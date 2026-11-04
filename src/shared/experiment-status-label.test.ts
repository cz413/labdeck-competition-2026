import {describe,it,expect} from 'vitest'
import type {ExperimentRun,ExperimentTask} from './types'
import {runStatusLabel,groupStatusLabel,taskStatusLabel} from './experiment-status-label'
const run=(patch:Partial<ExperimentRun>={})=>({status:'queued',computeDevice:'gpu',...patch}) as ExperimentRun
const task=(r:ExperimentRun)=>({status:r.status,runs:[r]}) as ExperimentTask
describe('execution mode status labels',()=>{
  it('distinguishes automatic GPU allocation, explicit GPU including index zero, and CPU',()=>{
    expect(runStatusLabel(run(),'排队中')).toBe('等待资源')
    expect(runStatusLabel(run({gpuIndex:0}),'排队中')).toBe('等待启动')
    expect(runStatusLabel(run({gpuUuid:'GPU-2'}),'排队中')).toBe('等待启动')
    expect(runStatusLabel(run({computeDevice:'cpu'}),'排队中')).toBe('等待启动')
  })
  it('labels preparation as starting and preserves terminal state labels',()=>{
    expect(runStatusLabel(run({status:'preparing'}),'准备运行')).toBe('正在启动')
    expect(runStatusLabel(run({status:'failed'}),'运行失败')).toBe('运行失败')
    expect(taskStatusLabel(task(run()),'排队中')).toBe('等待资源')
  })
  it('aggregates consistent execution modes and retains a general label for mixed queues',()=>{
    expect(groupStatusLabel([task(run()),task(run())],'queued','排队中')).toBe('等待资源')
    expect(groupStatusLabel([task(run({gpuIndex:0})),task(run({computeDevice:'cpu'}))],'queued','排队中')).toBe('等待启动')
    expect(groupStatusLabel([task(run()),task(run({gpuIndex:0}))],'queued','排队中')).toBe('排队中')
  })
})
