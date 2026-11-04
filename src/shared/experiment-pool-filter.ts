import type { ExperimentTaskStatus } from './types'
export function matchesTaskStatus(status:ExperimentTaskStatus,filter:string):boolean {
  return filter==='all'||(filter==='active'?['queued','preparing','running','paused'].includes(status):status===filter)
}
export function toggleTaskStatus(current:string,next:string):string{return current===next?'all':next}
