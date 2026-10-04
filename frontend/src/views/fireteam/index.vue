<template>
  <section class="page" data-module="fireteam">
    <header class="page-head">
      <div>
        <h2>扑火队伍管理</h2>
        <p class="page-desc">出动与回撤受控：归属林场才能派出和撤回；跨林场只保留现场临时指挥权，集结半径和历史归属不变。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记扑火队伍</button>
        <button class="btn" type="button" @click="exportRows">导出扑火队伍清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="rowActions(row).length">
              <button
                v-for="action in rowActions(row)"
                :key="action"
                class="link"
                type="button"
                :disabled="submitting"
                @click="chooseAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="muted-text">无受控动作</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无扑火队伍数据，可先登记扑火队伍</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条扑火队伍记录</span>
      <span v-if="successMessage" class="success-text">{{ successMessage }}</span>
      <span v-else-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="dispatchTarget" class="modal-mask" @click.self="closeDispatch">
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="dispatch-title">
        <header class="modal-head">
          <h3 id="dispatch-title">下达受控出动</h3>
          <button class="btn ghost" type="button" @click="closeDispatch">关闭</button>
        </header>

        <div class="dispatch-summary">
          <p><strong>队伍：</strong>{{ dispatchTarget.队伍名称 }}（{{ dispatchTarget.队伍编号 }}）</p>
          <p><strong>所属林场：</strong>{{ dispatchTarget.所属林场 }}</p>
          <p><strong>队长：</strong>{{ captainName(dispatchTarget) }}</p>
          <p><strong>集结半径：</strong>{{ dispatchTarget.集结半径 || '未登记' }}（跨林场调度时原样保留）</p>
        </div>

        <form class="dispatch-form" @submit.prevent="submitDispatch">
          <label>
            <span>关联火情报告</span>
            <select v-model="selectedReportId" required>
              <option value="" disabled>请选择已核实且未关联出动的火情报告</option>
              <option v-for="report in dispatchReports" :key="String(report.id)" :value="String(report.id)">
                {{ report.报告编号 }} · {{ report.所属林场 }} · {{ report.起火地点 }}
              </option>
            </select>
          </label>
          <p v-if="!dispatchReports.length" class="form-error">暂无可关联的已核实火情报告</p>

          <label>
            <span>领用消防装备</span>
            <select v-model="selectedEquipmentId" required>
              <option value="" disabled>请选择所属林场保管的可用装备</option>
              <option v-for="equipment in dispatchEquipments" :key="String(equipment.id)" :value="String(equipment.id)">
                {{ equipment.装备编号 }} · {{ equipment.装备名称 }} · {{ equipment.规格型号 }}
              </option>
            </select>
          </label>
          <p v-if="!dispatchEquipments.length" class="form-error">所属林场暂无可用装备，不能出动</p>

          <div class="dispatch-note">
            <strong>临时指挥权：</strong>{{ temporaryCommandForest || '同林场出动，无需临时指挥权' }}
            <span v-if="temporaryCommandForest">；历史归属仍为 {{ dispatchTarget.所属林场 }}</span>
          </div>

          <footer class="modal-actions">
            <button class="btn" type="button" @click="closeDispatch">取消</button>
            <button
              class="btn primary"
              type="submit"
              :disabled="submitting || !dispatchReports.length || !dispatchEquipments.length"
            >
              {{ submitting ? '提交中...' : '确认出动' }}
            </button>
          </footer>
        </form>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  availableFireteamActions,
  createDispatchRequestKey,
  displayCaptain,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('fireteam')
const session = useSessionStore()
const columns = meta.fields
const statuses = meta.statuses

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const submitting = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const dispatchTarget = ref<EntryRow | null>(null)
const selectedReportId = ref('')
const selectedEquipmentId = ref('')
const idempotencyKey = ref('')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const activeCount = rows.value.filter((row) => ['已出动', '扑救中', '休整中'].includes(String(row.status))).length
  return [
    { label: '队伍总数', value: rows.value.length },
    { label: '待命队伍', value: rows.value.filter((row) => String(row.status) === '在营待命').length },
    { label: '出动队伍', value: activeCount },
  ]
})

const dispatchReports = computed(() => {
  if (!dispatchTarget.value) {
    return []
  }
  return listRows('firereport').filter(
    (row) => String(row.status) === '已确认' && String(row['关联队伍编号'] ?? '').trim() === '',
  )
})

const dispatchEquipments = computed(() => {
  if (!dispatchTarget.value) {
    return []
  }
  const home = String(dispatchTarget.value['所属林场'] ?? '')
  return listRows('equipment').filter(
    (row) => String(row.status) === '可用' && String(row['保管林场'] ?? '') === home,
  )
})

const temporaryCommandForest = computed(() => {
  const report = dispatchReports.value.find((row) => String(row.id) === selectedReportId.value)
  const fireForest = report ? String(report['所属林场'] ?? '') : ''
  const home = dispatchTarget.value ? String(dispatchTarget.value['所属林场'] ?? '') : ''
  return fireForest && fireForest !== home ? fireForest : ''
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '扑火队伍登记入口尚未接入审批流'
  successMessage.value = ''
}

function captainName(row: EntryRow): string {
  return displayCaptain(row)
}

function formatCell(row: EntryRow, column: string): string | number | boolean {
  if (column === '队长姓名') {
    return displayCaptain(row)
  }
  return row[column] ?? (column === '临时指挥林场' ? '无' : '—')
}

function rowActions(row: EntryRow): string[] {
  return availableFireteamActions(row, session.operatorForest)
}

function chooseAction(action: string, row: EntryRow) {
  if (action === '下达出动') {
    openDispatch(row)
    return
  }
  executeAction(action, Number(row.id))
}

function openDispatch(row: EntryRow) {
  errorMessage.value = ''
  successMessage.value = ''
  dispatchTarget.value = row
  idempotencyKey.value = createDispatchRequestKey()
  selectedReportId.value = ''
  selectedEquipmentId.value = ''
}

function closeDispatch() {
  if (submitting.value) {
    return
  }
  dispatchTarget.value = null
  selectedReportId.value = ''
  selectedEquipmentId.value = ''
  idempotencyKey.value = ''
}

function submitDispatch() {
  if (!dispatchTarget.value || submitting.value) {
    return
  }
  submitting.value = true
  const result = applyAction(meta.key, Number(dispatchTarget.value.id), '下达出动', {
    operatorName: session.operator,
    operatorUnit: session.operatorForest,
    fireReportId: Number(selectedReportId.value),
    equipmentId: Number(selectedEquipmentId.value),
    idempotencyKey: idempotencyKey.value,
  })
  submitting.value = false
  if (!result.ok) {
    errorMessage.value = result.message
    successMessage.value = ''
    return
  }
  closeDispatch()
  successMessage.value = result.message
  errorMessage.value = ''
  reload()
}

function executeAction(action: string, id: number) {
  errorMessage.value = ''
  successMessage.value = ''
  const result = applyAction(meta.key, id, action, {
    operatorName: session.operator,
    operatorUnit: session.operatorForest,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  successMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '扑火队伍列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.muted-text { color: var(--muted); }
.success-text { color: #16794c; }
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgb(15 23 42 / 45%);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
}
.modal-card {
  width: min(680px, calc(100vw - 32px));
  background: #fff;
  border-radius: 10px;
  padding: 18px;
  box-shadow: 0 18px 50px rgb(15 23 42 / 25%);
}
.modal-head,
.modal-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.modal-head h3 { margin: 0; }
.dispatch-summary {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
  background: #f8fafc;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 12px 0;
}
.dispatch-summary p { margin: 0; font-size: 13px; }
.dispatch-form { display: grid; gap: 12px; }
.dispatch-form label span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.dispatch-form select { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 8px; }
.dispatch-note { font-size: 13px; color: #475569; background: #eef6ff; border-radius: 6px; padding: 8px 10px; }
.form-error { margin: 4px 0 0; color: #b42318; font-size: 12px; }
.modal-actions { justify-content: flex-end; margin-top: 4px; }
</style>
