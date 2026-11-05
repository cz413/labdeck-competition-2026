import type {ExperimentRun,ExperimentTask,ServerProfile} from './types'

export interface RunningGpuTask {
  task:ExperimentTask
  run:ExperimentRun
  server?:ServerProfile
  serverId?:string
  accessRouteId?:string
  gpuIndex?:number
}

// Membership follows platform run events, not GPU telemetry or process discovery.
export function runningGpuTasks(servers:ServerProfile[],tasks:ExperimentTask[]):RunningGpuTask[]{
  return tasks.flatMap(task=>task.runs.filter(run=>run.status==='running'&&(run.computeDevice??task.computeDevice??'gpu')==='gpu').map(run=>{
    const serverId=run.serverId??task.serverId
    return {task,run,server:servers.find(server=>server.id===serverId),serverId,accessRouteId:run.accessRouteId??task.accessRouteId,gpuIndex:run.gpuIndex??task.gpuIndex}
  }))
}
