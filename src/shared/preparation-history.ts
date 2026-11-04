import type { PreparationEdit } from './preparation'

export type PreparationHistoryEntry = PreparationEdit['history'][number]
export type PreparationPlanState = PreparationHistoryEntry['before']

/** Old records store the state before an edit. The next record preserves its result. */
export function preparationHistoryVersions(history: PreparationHistoryEntry[], current: PreparationPlanState): (PreparationHistoryEntry & {state: PreparationPlanState})[] {
  return history.map((entry,index)=>({...entry,state:structuredClone(history[index+1]?.before??current)}))
}

/** Restoring is another edit: keep later versions available instead of popping history. */
export function appendPreparationHistory(history: PreparationHistoryEntry[], entry: Omit<PreparationHistoryEntry,'before'>, current: PreparationPlanState): PreparationHistoryEntry[] {
  return [...history.slice(-19),{...entry,before:structuredClone(current)}]
}
