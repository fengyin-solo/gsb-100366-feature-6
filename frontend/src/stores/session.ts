import { defineStore } from 'pinia'

export const OPERATOR_FORESTS = ['青松林场', '白桦林场', '红枫林场']
export const DEFAULT_OPERATOR_FOREST = OPERATOR_FORESTS[0]

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    operatorForest: DEFAULT_OPERATOR_FOREST,
    shiftLabel: '白班 08:00-20:00',
    scope: '森林防火巡护管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setOperatorForest(forest: string) {
      this.operatorForest = forest
    },
  },
})
