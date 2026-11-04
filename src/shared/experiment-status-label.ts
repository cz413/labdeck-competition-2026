import type { ExperimentRun,ExperimentTask } from './types'
type Target=Pick<ExperimentRun,'status'|'computeDevice'|'gpuUuid'|'gpuIndex'>
/** Presentation only: queued runs continue to use the existing scheduler state. */
export function runStatusLabel(run:Target|undefined,fallback:string):string {
  if(!run)return fallback
  if(run.status==='preparing')return '正在启动'
  if(run.status!=='queued')return fallback
  return run.computeDevice==='cpu'||!!run.gpuUuid||run.gpuIndex!=null?'等待启动':'等待资源'
}
export function taskStatusLabel(task:ExperimentTask,fallback:string):string {
  if(task.status!=='queued'&&task.status!=='preparing')return fallback
  return runStatusLabel(task.runs.find(run=>run.status===task.status),fallback)
}
export function groupStatusLabel(tasks:ExperimentTask[],status:string,fallback:string):string {
  if(status==='preparing')return '正在启动'
  if(status!=='queued')return fallback
  const labels=new Set(tasks.filter(task=>task.status==='queued').map(task=>taskStatusLabel(task,fallback)))
  return labels.size===1?[...labels][0]:fallback
}
