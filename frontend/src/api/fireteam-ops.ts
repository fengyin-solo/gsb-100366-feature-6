import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, FireteamActionContext } from '@/data/types'

// 扑火队伍的出动 / 休整 / 撤回是受控操作：状态机、林场权限、联动回写都集中在服务层，
// 页面只负责把调度参数（操作林场、关联报告、领用装备、临时指挥权）传进来。
const TEAM_KEY = 'fireteam'
const REPORT_KEY = 'firereport'
const EQUIPMENT_KEY = 'equipment'

const ACTION_DISPATCH = '下达出动'
const ACTION_REST = '转入休整'
const ACTION_WITHDRAW = '撤回队伍'

const STATUS_STANDBY = '在营待命'
const STATUS_DISPATCHED = '已出动'
const STATUS_FIGHTING = '扑救中'
const STATUS_WITHDRAWN = '已撤回'
const STATUS_RESTING = '休整中'

const EQUIPMENT_AVAILABLE = '可用'
const EQUIPMENT_CHECKED_OUT = '已领用'

// 正在处理中的出动指令：并发提交时只有第一笔能进入流转，其余直接拒绝，
// 状态前置校验（必须在营待命）再兜一层，保证同一队伍出动只生效一次。
const inflightDispatches = new Set<number>()

function teamName(row: EntryRow): string {
  return String(row['队伍名称'] ?? '').trim() || String(row['队伍编号'] ?? row.id)
}

function homeFarm(row: EntryRow): string {
  return String(row['所属林场'] ?? '').trim()
}

function commandFarmOf(row: EntryRow): string {
  return String(row['临时指挥权'] ?? '').trim()
}

// 老队伍可能没登记队长姓名：按所属林场兜底展示，不拦流程。
export function captainLabel(row: EntryRow): string {
  const name = String(row['队长姓名'] ?? '').trim()
  if (name) {
    return name
  }
  const farm = homeFarm(row)
  return farm ? `${farm}队部（队长待补录）` : '队长待补录'
}

function formatNow(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

// 缺省关联规则：优先最新一条已确认火情，其次最新一条待核实。
function pickLinkedReport(reports: EntryRow[]): number {
  for (const status of ['已确认', '待核实']) {
    const picked = reports.reduce(
      (best, row, index) =>
        String(row.status) === status && (best < 0 || Number(row.id) > Number(reports[best].id))
          ? index
          : best,
      -1,
    )
    if (picked >= 0) {
      return picked
    }
  }
  return -1
}

type EquipmentPick = { ok: true; indexes: number[] } | { ok: false; message: string }

// 指定了装备编号就逐台校验（必须存在且可用）；缺省按队伍所属林场划拨全部可用装备。
function resolveEquipment(
  equipment: EntryRow[],
  specified: string[] | undefined,
  home: string,
): EquipmentPick {
  if (specified && specified.length > 0) {
    const indexes: number[] = []
    for (const no of specified) {
      const index = equipment.findIndex((row) => String(row['装备编号']) === no)
      if (index < 0) {
        return { ok: false, message: `未找到装备编号为 ${no} 的消防装备，出动未生效` }
      }
      if (indexes.includes(index)) {
        return { ok: false, message: `装备 ${no} 在领用清单中重复，出动未生效` }
      }
      const status = String(equipment[index].status)
      if (status !== EQUIPMENT_AVAILABLE) {
        return { ok: false, message: `装备 ${no} 当前状态「${status}」，不可领用，出动未生效` }
      }
      indexes.push(index)
    }
    return { ok: true, indexes }
  }
  const indexes = equipment
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) =>
        String(row.status) === EQUIPMENT_AVAILABLE && String(row['保管林场'] ?? '').trim() === home,
    )
    .map(({ index }) => index)
  return { ok: true, indexes }
}

export function runFireteamAction(
  id: number,
  action: string,
  context: FireteamActionContext = {},
): ActionResult {
  const rows = listRows(TEAM_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的扑火队伍` }
  }
  const team = rows[index]
  if (action === ACTION_DISPATCH) {
    return dispatchTeam(team, rows, index, context)
  }
  if (action === ACTION_REST) {
    return restTeam(team, rows, index)
  }
  if (action === ACTION_WITHDRAW) {
    return withdrawTeam(team, rows, index, context)
  }
  return { ok: false, message: `扑火队伍没有登记「${action}」这个动作` }
}

function dispatchTeam(
  team: EntryRow,
  rows: EntryRow[],
  index: number,
  context: FireteamActionContext,
): ActionResult {
  const name = teamName(team)
  const id = Number(team.id)
  if (inflightDispatches.has(id)) {
    return { ok: false, message: `「${name}」的出动指令正在处理中，请勿重复提交` }
  }
  inflightDispatches.add(id)
  try {
    const status = String(team.status)
    if (status === STATUS_WITHDRAWN) {
      return { ok: false, message: `「${name}」已撤回，不能重新进入出动` }
    }
    if (status !== STATUS_STANDBY) {
      const batch = String(team['出动批次号'] ?? '').trim()
      return {
        ok: false,
        message: batch
          ? `「${name}」已存在生效中的出动批次「${batch}」，重复提交未生效`
          : `「${name}」当前状态「${status}」，只有所属林场的在营待命队伍可下达出动`,
      }
    }
    const operatorFarm = (context.operatorFarm ?? '').trim()
    if (!operatorFarm) {
      return { ok: false, message: '请先填写当前操作林场，再下达出动指令' }
    }
    const home = homeFarm(team)
    const crossFarm = home !== operatorFarm
    const commandFarm = (context.commandFarm ?? '').trim()
    if (crossFarm && !commandFarm) {
      return { ok: false, message: `「${name}」属「${home}」，跨林场调度须先登记临时指挥权` }
    }

    // 联动对象先校验后落库：任何一项不通过，队伍状态与台账都保持原样。
    const reports = listRows(REPORT_KEY)
    let reportIndex = -1
    const reportNo = (context.reportNo ?? '').trim()
    if (reportNo) {
      reportIndex = reports.findIndex((row) => String(row['报告编号']) === reportNo)
      if (reportIndex < 0) {
        return { ok: false, message: `未找到报告编号为 ${reportNo} 的火情报告，出动未生效` }
      }
    } else {
      reportIndex = pickLinkedReport(reports)
    }
    const equipment = listRows(EQUIPMENT_KEY)
    const gear = resolveEquipment(equipment, context.equipmentNos, home)
    if (!gear.ok) {
      return { ok: false, message: gear.message }
    }

    const batch = `DEP-${String(id).padStart(4, '0')}-${Date.now().toString(36).toUpperCase()}`
    // 历史队伍记录保持原归属：所属林场、集结半径一律不改；
    // 跨林场调度只追加临时指挥权，留档备查。
    const updatedTeam: EntryRow = {
      ...team,
      status: STATUS_DISPATCHED,
      pending: true,
      abnormal: false,
      出动批次号: batch,
      出动时间: formatNow(),
    }
    if (crossFarm) {
      updatedTeam['临时指挥权'] = commandFarm
    }
    const nextTeams = [...rows]
    nextTeams[index] = updatedTeam

    let nextReports: EntryRow[] | null = null
    if (reportIndex >= 0) {
      const report = reports[reportIndex]
      const note = `【联动出动】${name}（批次 ${batch}）已出动，待关联核查`
      const previous = String(report['扑救情况'] ?? '').trim()
      nextReports = [...reports]
      nextReports[reportIndex] = {
        ...report,
        扑救情况: previous ? `${previous}；${note}` : note,
        联动核查: '待核查',
        pending: true,
      }
    }

    let nextEquipment: EntryRow[] | null = null
    if (gear.indexes.length > 0) {
      nextEquipment = [...equipment]
      for (const gearIndex of gear.indexes) {
        nextEquipment[gearIndex] = {
          ...nextEquipment[gearIndex],
          status: EQUIPMENT_CHECKED_OUT,
          pending: true,
          领用队伍: name,
          领用批次: batch,
        }
      }
    }

    saveRows(TEAM_KEY, nextTeams)
    if (nextReports) {
      saveRows(REPORT_KEY, nextReports)
    }
    if (nextEquipment) {
      saveRows(EQUIPMENT_KEY, nextEquipment)
    }

    const effects: string[] = []
    effects.push(
      nextReports
        ? `已回写火情报告 ${String(reports[reportIndex]['报告编号'])} 提醒关联核查`
        : '未找到可关联的火情报告，请人工补录关联核查',
    )
    effects.push(
      nextEquipment
        ? `装备台账回写 ${gear.indexes.length} 台为已领用（${gear.indexes
            .map((gearIndex) => String(equipment[gearIndex]['装备编号']))
            .join('、')}）`
        : '所属林场暂无可用装备，装备台账未回写',
    )
    const crossNote = crossFarm
      ? `；跨林场调度，临时指挥权登记为「${commandFarm}」，原所属林场与集结半径保留`
      : ''
    return { ok: true, message: `「${name}」已出动（批次 ${batch}）${crossNote}；${effects.join('；')}` }
  } finally {
    inflightDispatches.delete(id)
  }
}

function restTeam(team: EntryRow, rows: EntryRow[], index: number): ActionResult {
  const name = teamName(team)
  const status = String(team.status)
  if (status !== STATUS_FIGHTING) {
    return { ok: false, message: `「${name}」当前状态「${status}」，只有扑救中的队伍才能转入休整` }
  }
  const next = [...rows]
  next[index] = { ...team, status: STATUS_RESTING, pending: true, abnormal: false }
  saveRows(TEAM_KEY, next)
  return { ok: true, message: `「${name}」已转入休整` }
}

function withdrawTeam(
  team: EntryRow,
  rows: EntryRow[],
  index: number,
  context: FireteamActionContext,
): ActionResult {
  const name = teamName(team)
  const status = String(team.status)
  if (status === STATUS_WITHDRAWN) {
    return { ok: false, message: `「${name}」已撤回，不用重复操作` }
  }
  if (status !== STATUS_DISPATCHED && status !== STATUS_FIGHTING && status !== STATUS_RESTING) {
    return { ok: false, message: `「${name}」当前状态「${status}」，无可撤回的在途任务` }
  }
  const operatorFarm = (context.operatorFarm ?? '').trim()
  const home = homeFarm(team)
  const command = commandFarmOf(team)
  if (!operatorFarm || (operatorFarm !== home && operatorFarm !== command)) {
    const holder = command ? `「${home}」或临时指挥单位「${command}」` : `「${home}」`
    return { ok: false, message: `越权撤回被拒绝：只有所属林场${holder}可撤回「${name}」` }
  }
  // 撤回只改状态并留撤回时间：临时指挥权、出动批次留档，原所属林场不变。
  const next = [...rows]
  next[index] = {
    ...team,
    status: STATUS_WITHDRAWN,
    pending: false,
    abnormal: false,
    撤回时间: formatNow(),
  }
  saveRows(TEAM_KEY, next)
  return { ok: true, message: `「${name}」已撤回，出动档案保留，原所属林场不变` }
}
