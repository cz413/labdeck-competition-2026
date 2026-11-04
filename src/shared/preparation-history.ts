import type { PreparationEdit } from './preparation'
export type PreparationHistoryEntry = PreparationEdit['history'][number]
export type PreparationPlanState = PreparationHistoryEntry['before']

/** Field provenance does not make an otherwise identical configuration a new version. */
export function preparationStateKey(state:PreparationPlanState):string {
  const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)])):value
  return JSON.stringify(stable({draft:state.draft,mode:state.mode}))
}
/** Materialize legacy before-only records before switching away from the latest result. */
export function freezePreparationHistory(history:PreparationHistoryEntry[],current:PreparationPlanState):PreparationHistoryEntry[] {
  return history.map((entry,index)=>({...entry,after:structuredClone(entry.after??history[index+1]?.before??current)}))
}
export function preparationHistoryVersions(history:PreparationHistoryEntry[],current:PreparationPlanState):(PreparationHistoryEntry & {state:PreparationPlanState})[] {
  const versions=freezePreparationHistory(history,current).map(entry=>({...entry,state:entry.after!}))
  const seen=new Set<string>()
  return versions.filter(entry=>{const key=preparationStateKey(entry.state);if(seen.has(key))return false;seen.add(key);return true})
}
/** Only edits create versions. Restoring just selects a previously materialized result. */
export function appendPreparationHistory(history:PreparationHistoryEntry[],entry:Omit<PreparationHistoryEntry,'before'|'after'>,current:PreparationPlanState):PreparationHistoryEntry[] {
  return [...freezePreparationHistory(history,current).slice(-19),{...entry,before:structuredClone(current)}]
}
