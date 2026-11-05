import {describe,it,expect} from 'vitest'
import type {ExperimentTask,ExperimentRun,ServerProfile} from './types'
import {runningGpuTasks} from './live-gpu-tasks'
const server={id:'gpu6',name:'gpu6',monitorPolicy:'manual'} as ServerProfile
const run={id:'run',status:'running',computeDevice:'gpu',serverId:'gpu6',accessRouteId:'jump',gpuIndex:0} as ExperimentRun
const task={id:'task',title:'Training',serverId:'other',accessRouteId:'direct',gpuIndex:2,computeDevice:'gpu',runs:[run]} as ExperimentTask

describe('running GPU task list',()=>{
  it('appears immediately when running without telemetry, PID or monitoring',()=>{
    const rows=runningGpuTasks([server],[task])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({server,serverId:'gpu6',accessRouteId:'jump',gpuIndex:0})
    expect(rows[0].run.remotePid).toBeUndefined()
  })
  it('removes ended runs and excludes queued, preparing and paused runs',()=>{
    for(const status of ['queued','preparing','completed','failed','cancelled','paused']){
      expect(runningGpuTasks([server],[{...task,runs:[{...run,status} as ExperimentRun]}])).toEqual([])
    }
  })
  it('excludes CPU runs and uses each run snapshot over the task configuration',()=>{
    expect(runningGpuTasks([server],[{...task,computeDevice:'cpu'}])).toHaveLength(1)
    expect(runningGpuTasks([server],[{...task,runs:[{...run,computeDevice:'cpu'}]}])).toEqual([])
  })
  it('keeps concurrent runs separate and restores the list from saved running records',()=>{
    const restored=JSON.parse(JSON.stringify({...task,runs:[run,{...run,id:'run2'}]}))
    expect(runningGpuTasks([server],[restored]).map(row=>row.run.id)).toEqual(['run','run2'])
  })
  it('retains running rows when a server profile is unavailable',()=>{
    expect(runningGpuTasks([],[task])[0]).toMatchObject({serverId:'gpu6',server:undefined})
  })
})
