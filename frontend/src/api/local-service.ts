import { DEFAULT_OPERATOR_FOREST } from '@/stores/session'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows, saveRowsBatch } from '@/data/local-store'
import type {
  ActionContext,
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']
const DISPATCH_ACTION = '下达出动'
const FIRE_TEAM_ACTIVE_STATUSES = ['已出动', '扑救中', '休整中']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function textValue(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

function findRow(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function makeDispatchTicket(teamId: number): string {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase()
  return `D-${String(teamId).padStart(4, '0')}-${suffix}`
}

function makeIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function createDispatchRequestKey(): string {
  return makeIdempotencyKey()
}

/** 老队伍缺队长姓名时不补写历史数据，只在展示和操作回执中按所属林场兼容。 */
export function displayCaptain(row: EntryRow): string {
  const captain = textValue(row, '队长姓名')
  if (captain) {
    return captain
  }
  const forest = textValue(row, '所属林场')
  return forest ? `${forest}（按所属林场兼容）` : '未设置队长（按所属林场兼容）'
}

function commandForests(row: EntryRow): string[] {
  const home = textValue(row, '所属林场')
  const temporary = textValue(row, '临时指挥林场')
  return temporary && temporary !== home ? [home, temporary] : [home]
}

/** 返回当前单位在当前状态下真正可提交的动作；页面只做禁用，最终仍由本服务拦截。 */
export function availableFireteamActions(row: EntryRow, operatorUnit = DEFAULT_OPERATOR_FOREST): string[] {
  const home = textValue(row, '所属林场')
  const isHomeUnit = home === operatorUnit
  const canCommand = commandForests(row).includes(operatorUnit)
  const status = String(row.status)

  if (status === '在营待命' && isHomeUnit) {
    return [DISPATCH_ACTION]
  }
  if (status === '已出动' && canCommand) {
    return isHomeUnit ? ['到场扑救', '撤回队伍'] : ['到场扑救']
  }
  if (status === '扑救中' && canCommand) {
    return isHomeUnit ? ['转入休整', '撤回队伍'] : ['转入休整']
  }
  if (status === '休整中' && canCommand) {
    return isHomeUnit ? ['恢复扑救', '撤回队伍'] : ['恢复扑救']
  }
  return []
}

function failure(message: string): ActionResult {
  return { ok: false, message }
}

function isPendingStatus(meta: ModuleMeta, status: string): boolean {
  if (meta.key === 'fireteam') {
    return status !== '已撤回'
  }
  return status !== meta.statuses[meta.statuses.length - 1]
}

function replaceRow(rows: EntryRow[], id: number, patch: Partial<EntryRow>): EntryRow[] {
  return rows.map((row) =>
    Number(row.id) === id ? (Object.assign({}, row, patch) as EntryRow) : row,
  )
}

function dispatchFireteam(
  team: EntryRow,
  context: ActionContext,
): ActionResult {
  const operatorUnit = context.operatorUnit ?? DEFAULT_OPERATOR_FOREST
  const home = textValue(team, '所属林场')
  if (home !== operatorUnit) {
    return failure('只有队伍所属林场可下达出动；跨林场支援须由归属林场先派出并授予临时指挥权')
  }
  if (String(team.status) !== '在营待命') {
    return failure(`当前状态为「${team.status}」，只有在营待命队伍可下达出动`)
  }
  if (!context.fireReportId || !context.equipmentId) {
    return failure('出动必须关联已核实火情报告和可领用装备')
  }
  if (!context.idempotencyKey) {
    return failure('缺少出动提交凭证，无法防止重复提交')
  }

  const teams = listRows('fireteam')
  const duplicated = teams.some((row) => row.出动幂等键 === context.idempotencyKey)
  if (duplicated) {
    return { ok: false, duplicated: true, message: '该出动指令已生效，重复或并发提交已被忽略' }
  }

  const reports = listRows('firereport')
  const report = findRow(reports, context.fireReportId)
  if (!report) {
    return failure('没有找到要关联的火情报告')
  }
  if (String(report.status) !== '已确认') {
    return failure('只有已核实确认的火情报告可接收出动提醒回写')
  }
  if (textValue(report, '关联队伍编号')) {
    return failure('该火情报告已关联出动队伍，不能重复核查回写')
  }

  const equipmentRows = listRows('equipment')
  const equipment = findRow(equipmentRows, context.equipmentId)
  if (!equipment) {
    return failure('没有找到要领用的消防装备')
  }
  if (String(equipment.status) !== '可用') {
    return failure('选中的消防装备当前不可领用')
  }
  if (textValue(equipment, '保管林场') !== home) {
    return failure('只能领用队伍所属林场保管的装备；跨林场支援不改变装备归属')
  }

  const ticket = makeDispatchTicket(Number(team.id))
  const teamCode = textValue(team, '队伍编号')
  const reportCode = textValue(report, '报告编号')
  const equipmentCode = textValue(equipment, '装备编号')
  const reportForest = textValue(report, '所属林场')
  const temporaryCommandForest = reportForest && reportForest !== home ? reportForest : ''
  const operatedAt = nowText()
  const target = '已出动'

  const nextTeams = replaceRow(teams, Number(team.id), {
    status: target,
    pending: true,
    abnormal: false,
    临时指挥林场: temporaryCommandForest,
    最近出动单号: ticket,
    关联火情编号: reportCode,
    领用装备编号: equipmentCode,
    出动幂等键: context.idempotencyKey,
  })
  const nextReports = replaceRow(reports, Number(report.id), {
    status: '已出警',
    pending: true,
    abnormal: false,
    关联队伍编号: teamCode,
    提醒核查时间: operatedAt,
    核查备注: `${temporaryCommandForest || home}出动提醒已核查；队长：${displayCaptain(team)}；单号：${ticket}`,
    扑救情况: `队伍已出动，集结半径沿用原值：${textValue(team, '集结半径') || '未登记'}`,
  })
  const nextEquipment = replaceRow(equipmentRows, Number(equipment.id), {
    status: '已领用',
    pending: true,
    abnormal: false,
    领用队伍编号: teamCode,
    最近领用单号: ticket,
    领用时间: operatedAt,
  })

  saveRowsBatch({
    fireteam: nextTeams,
    firereport: nextReports,
    equipment: nextEquipment,
  })

  const crossTip = temporaryCommandForest
    ? `，临时指挥权保留至${temporaryCommandForest}，所属林场和集结半径不变`
    : ''
  return {
    ok: true,
    message: `队伍已出动（单号 ${ticket}）：火情报告 ${reportCode} 已回写核查，装备 ${equipmentCode} 已登记领用${crossTip}`,
  }
}

function runFireteamAction(
  meta: ModuleMeta,
  id: number,
  action: string,
  context: ActionContext,
): ActionResult {
  const rows = listRows(meta.key)
  const row = findRow(rows, id)
  if (!row) {
    return failure(`没有找到编号为 ${id} 的${meta.entity}`)
  }

  if (action === DISPATCH_ACTION) {
    return dispatchFireteam(row, context)
  }

  const operatorUnit = context.operatorUnit ?? DEFAULT_OPERATOR_FOREST
  const home = textValue(row, '所属林场')
  const canCommand = commandForests(row).includes(operatorUnit)
  const status = String(row.status)
  const target = meta.actionTargets[action]

  if (action === '撤回队伍') {
    if (home !== operatorUnit) {
      return failure('跨林场临时指挥权只用于现场扑救和休整指挥，不能撤回其他所属林场的队伍')
    }
    if (!FIRE_TEAM_ACTIVE_STATUSES.includes(status)) {
      return failure(`当前状态为「${status}」，不能撤回；已撤回队伍也不能重新进入出动`)
    }
  } else if (!availableFireteamActions(row, operatorUnit).includes(action)) {
    if (status === '已撤回') {
      return failure('队伍已撤回，不能重新进入出动或现场状态')
    }
    if (home !== operatorUnit && !canCommand) {
      return failure('当前单位没有这支队伍的现场指挥权')
    }
    return failure(`「${status}」状态不能执行「${action}」`)
  }

  const patch: Partial<EntryRow> = {
    status: target,
    pending: isPendingStatus(meta, target),
    abnormal: false,
  }
  const changes: Record<string, EntryRow[]> = {
    fireteam: replaceRow(rows, id, patch),
  }

  if (action === '撤回队伍') {
    const equipmentCode = textValue(row, '领用装备编号')
    if (equipmentCode) {
      const equipmentRows = listRows('equipment')
      changes.equipment = equipmentRows.map((equipment) =>
        textValue(equipment, '装备编号') === equipmentCode
          ? {
              ...equipment,
              status: '可用',
              pending: true,
              abnormal: false,
              归还时间: nowText(),
            }
          : equipment,
      )
    }
  }

  saveRowsBatch(changes)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  context: ActionContext = {},
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return failure(`${meta.entity}没有登记「${action}」这个动作`)
  }
  if (key === 'fireteam') {
    return runFireteamAction(meta, id, action, context)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return failure(`没有找到编号为 ${id} 的${meta.entity}`)
  }
  const current = String(rows[index].status)
  if (current === target) {
    return failure(`${meta.entity}已经是「${target}」，不用重复操作`)
  }
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: isPendingStatus(meta, target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
