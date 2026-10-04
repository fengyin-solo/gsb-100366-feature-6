// 扑火队伍受控操作的冒烟验证：local-store 在无 window 时走内存种子数据，可直接在 node 里跑。
// 运行（仓库根目录）：
//   cd frontend
//   npx tsc -p scripts/tsconfig.smoke.json \
//     && sed -i 's|@/data/|../data/|g; s|@/api/|../api/|g' /tmp/smoke-out/src/api/*.js \
//     && sed -i 's|@/data/|../src/data/|g; s|@/api/|../src/api/|g' /tmp/smoke-out/scripts/*.js \
//     && node /tmp/smoke-out/scripts/smoke-fireteam.js
import { runFireteamAction, captainLabel } from '@/api/fireteam-ops'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

let failures = 0

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok  ${label}`)
  } else {
    failures += 1
    console.error(`FAIL  ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

function team(id: number): EntryRow {
  return listRows('fireteam').find((row) => Number(row.id) === id) as EntryRow
}

function report(no: string): EntryRow {
  return listRows('firereport').find((row) => String(row['报告编号']) === no) as EntryRow
}

function gear(no: string): EntryRow {
  return listRows('equipment').find((row) => String(row['装备编号']) === no) as EntryRow
}

// 1. 本林场在营待命队伍出动：状态流转 + 火情报告回写 + 装备台账回写
const d1 = runFireteamAction(1, '下达出动', { operatorFarm: '东山林场' })
check('本林场待命队伍可出动', d1.ok, d1.message)
check('出动后状态为已出动', String(team(1).status) === '已出动')
check('出动批次号已生成', String(team(1)['出动批次号'] ?? '').startsWith('DEP-0001-'))
check('火情报告回写关联核查提醒', String(report('FR-0001')['联动核查']) === '待核查'
  && String(report('FR-0001')['扑救情况']).includes('待关联核查'))
check('火情报告原状态不被改动', String(report('FR-0001').status) === '已确认')
check('所属林场可用装备已领用', String(gear('EQ-0001').status) === '已领用'
  && String(gear('EQ-0002').status) === '已领用')
check('装备台账记录领用队伍与批次', String(gear('EQ-0001')['领用队伍']) === '东山快速扑火队'
  && String(gear('EQ-0001')['领用批次']) === String(team(1)['出动批次号']))
check('已领用装备不被重复划拨', String(gear('EQ-0005')['领用队伍']) === '东山第二扑火队')

// 2. 并发/重复提交只生效一次
const batch1 = String(team(1)['出动批次号'])
const d2 = runFireteamAction(1, '下达出动', { operatorFarm: '东山林场' })
check('重复出动被拒绝', !d2.ok)
check('拒绝文案说明已有生效批次', d2.message.includes(batch1), d2.message)
check('批次号未被覆盖', String(team(1)['出动批次号']) === batch1)
check('火情报告提醒未重复追加', String(report('FR-0001')['扑救情况']).split('联动出动').length === 2)

// 3. 已撤回不能重新进入出动
const d3 = runFireteamAction(5, '下达出动', { operatorFarm: '南山林场' })
check('已撤回队伍出动被拒绝', !d3.ok && d3.message.includes('已撤回'), d3.message)
check('已撤回队伍状态保持', String(team(5).status) === '已撤回')

// 4. 扑救中才能转休整
const r1 = runFireteamAction(2, '转入休整', { operatorFarm: '西山林场' })
check('待命队伍转休整被拒绝', !r1.ok && r1.message.includes('扑救中'), r1.message)
const r2 = runFireteamAction(4, '转入休整', { operatorFarm: '东山林场' })
check('扑救中队伍可转休整', r2.ok && String(team(4).status) === '休整中', r2.message)

// 5. 跨林场调度：临时指挥权必填，原归属与集结半径保留
const x1 = runFireteamAction(2, '下达出动', { operatorFarm: '东山林场' })
check('跨林场未登记临时指挥权被拒绝', !x1.ok && x1.message.includes('临时指挥权'), x1.message)
check('拒绝后队伍仍在营待命', String(team(2).status) === '在营待命')
const x2 = runFireteamAction(2, '下达出动', {
  operatorFarm: '东山林场',
  commandFarm: '东山林场',
  reportNo: 'FR-0002',
  equipmentNos: ['EQ-0003'],
})
check('登记临时指挥权后跨场出动成功', x2.ok, x2.message)
check('临时指挥权已留档', String(team(2)['临时指挥权']) === '东山林场')
check('原所属林场保持', String(team(2)['所属林场']) === '西山林场')
check('集结半径保持', String(team(2)['集结半径']) === '20公里')
check('指定火情报告被回写', String(report('FR-0002')['联动核查']) === '待核查')
check('指定装备被领用', String(gear('EQ-0003').status) === '已领用')

// 6. 越权撤回拒绝；所属林场 / 临时指挥单位可撤回
const w1 = runFireteamAction(4, '撤回队伍', { operatorFarm: '西山林场' })
check('越权撤回被拒绝', !w1.ok && w1.message.includes('越权'), w1.message)
check('越权撤回后状态不变', String(team(4).status) === '休整中')
const w2 = runFireteamAction(2, '撤回队伍', { operatorFarm: '东山林场' })
check('临时指挥单位可撤回', w2.ok && String(team(2).status) === '已撤回', w2.message)
check('撤回后原所属林场不变', String(team(2)['所属林场']) === '西山林场')
const w3 = runFireteamAction(4, '撤回队伍', { operatorFarm: '东山林场' })
check('所属林场可撤回', w3.ok && String(team(4).status) === '已撤回', w3.message)

// 7. 老队伍缺队长姓名：按所属林场兜底
check('缺队长按所属林场兼容', captainLabel(team(3)) === '北山林场队部（队长待补录）', captainLabel(team(3)))
check('有队长正常显示', captainLabel(team(1)) === '王建国')

// 8. 指定不可用装备：整笔出动不生效（原子性）
const before = String(team(3).status)
const a1 = runFireteamAction(3, '下达出动', { operatorFarm: '北山林场', equipmentNos: ['EQ-0004'] })
check('装备不可用时出动被拒绝', !a1.ok && a1.message.includes('EQ-0004'), a1.message)
check('队伍状态保持原样', String(team(3).status) === before)
check('未生成出动批次', !team(3)['出动批次号'])

// 9. 缺操作林场直接拒绝
const n1 = runFireteamAction(3, '下达出动', { operatorFarm: '' })
check('缺操作林场出动被拒绝', !n1.ok, n1.message)

if (failures > 0) {
  console.error(`\n${failures} 项未通过`)
  process.exit(1)
}
console.log('\n全部通过')
