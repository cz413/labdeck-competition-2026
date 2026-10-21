import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppStore } from './store'
import type { ExperimentTask } from '../shared/types'
import type { RepositoryGuide } from '../shared/repository-guide'
vi.mock('electron',()=>({app:{getPath:()=>''}}))
import { RepositoryWorkflowService } from './repository-workflow'
import { reviewRepositoryGuide } from './repository-review'
import { applyRepositoryChecks } from './repository-analysis'
import { sumModelUsage } from '../shared/model-usage'
let directory:string,tasks:ExperimentTask[]
const serverId='10000000-0000-4000-8000-000000000003'
const input={source:'remote' as const,serverId,path:'/repo',filePaths:['README.md'],goal:'Run baseline'}
const guide:RepositoryGuide={status:'ready_for_review',summary:'Baseline',missingInputs:[],warnings:[],checks:[],launchCommand:'python train.py',launchOrigin:'documented',launchCitations:[],launchSources:[],workingDirectory:'',environmentName:'vision',dataPath:'',questions:[],snapshot:{input,files:[],excerpts:[],warnings:[],collectedAt:'2026-10-20T00:00:00Z'},steps:[{role:'prepare',title:'Install environment',explanation:'Prepare it manually',commands:['pip install -r requirements.txt'],sources:[],workingDirectory:'',environment:'vision',origin:'suggested',citations:[]},{role:'launch',title:'Train',explanation:'Queue the task',commands:['python train.py'],sources:[],workingDirectory:'',environment:'vision',origin:'documented',citations:[]}]}
function dependencies(){
  const save=vi.fn(async draft=>{const task={...draft,id:randomUUID(),runs:[],archived:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};tasks.push(task);return task})
  const store={getServer:()=>({id:serverId,mode:'real'}),listExperimentTasks:()=>tasks,saveExperimentTask:save} as unknown as AppStore
  const analyze=vi.fn(async()=>structuredClone(guide)),recheck=vi.fn(async(g,review)=>applyRepositoryChecks(reviewRepositoryGuide(g,review),[{path:'.',expected:'directory',status:'confirmed',message:'exists'},{path:'train.py',expected:'file',status:'confirmed',message:'exists'}]))
  return {store,save,analyze,recheck,service:new RepositoryWorkflowService(store,{analyze,recheck},()=>{},directory)}
}
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'labdeck-startup-'));tasks=[]})
afterEach(async()=>{const target=resolve(directory);if(!target.startsWith(resolve(tmpdir())+sep)||!basename(target).startsWith('labdeck-startup-'))throw new Error('Unexpected cleanup target');await rm(target,{recursive:true,force:true})})
describe('repository LangGraph startup flow',()=>{
  it('stops for human preparation and restores the checkpoint without a second analysis',async()=>{
    const d=dependencies(),flow=await d.service.create(input)
    expect(flow.pending).toContain('await_action');expect(flow.phase).toBe('preparing');expect(d.analyze).toHaveBeenCalledTimes(1)
    await d.service.act(flow.id,{kind:'step',index:0,confirmed:true})
    const restored=new RepositoryWorkflowService(d.store,{analyze:d.analyze,recheck:d.recheck},()=>{},directory)
    const saved=(await restored.list())[0]
    expect(saved.confirmedSteps).toEqual([0]);expect(saved.phase).toBe('ready');expect(d.analyze).toHaveBeenCalledTimes(1)
  })
  it('rechecks user supplements without model calls and resets manual acknowledgements',async()=>{
    const d=dependencies(),flow=await d.service.create(input)
    await d.service.act(flow.id,{kind:'step',index:0,confirmed:true})
    const updated=await d.service.act(flow.id,{kind:'review',input:{launchCommand:'python train.py --epochs 2',workingDirectory:'',environmentName:'vision',dataPath:'',resolutions:[]}})
    expect(updated.guide?.launchOrigin).toBe('user');expect(updated.confirmedSteps).toEqual([]);expect(updated.guide?.status).toBe('ready_for_review');expect(d.analyze).toHaveBeenCalledTimes(1);expect(d.recheck).toHaveBeenCalledTimes(1)
  })
  it('confirms and clears every prepare step in one action',async()=>{
    const d=dependencies(),flow=await d.service.create(input)
    const confirmed=await d.service.act(flow.id,{kind:'steps',confirmed:true})
    expect(confirmed.confirmedSteps).toEqual([0]);expect(confirmed.phase).toBe('ready')
    const cleared=await d.service.act(flow.id,{kind:'steps',confirmed:false})
    expect(cleared.confirmedSteps).toEqual([]);expect(cleared.phase).toBe('preparing')
  })
  it('can save a draft with soft missing inputs when forced',async()=>{
    const d=dependencies()
    const pending:RepositoryGuide={...structuredClone(guide),status:'needs_info',missingInputs:['实际数据集在哪里？']}
    const analyze=vi.fn(async()=>structuredClone(pending))
    const service=new RepositoryWorkflowService(d.store,{analyze,recheck:d.recheck},()=>{},directory)
    const flow=await service.create(input)
    await service.act(flow.id,{kind:'step',index:0,confirmed:true})
    const saved=await service.act(flow.id,{kind:'save',title:'Baseline',force:true})
    expect(saved.taskId).toBeTruthy()
    expect(tasks[0].notes).toContain('实际数据集在哪里？')
  })
  it('refuses a forced draft without a supported launch command',async()=>{
    const d=dependencies()
    const pending:RepositoryGuide={...structuredClone(guide),status:'needs_info',missingInputs:[],launchCommand:''}
    const analyze=vi.fn(async()=>structuredClone(pending))
    const service=new RepositoryWorkflowService(d.store,{analyze,recheck:d.recheck},()=>{},directory)
    const flow=await service.create(input)
    await service.act(flow.id,{kind:'step',index:0,confirmed:true})
    const saved=await service.act(flow.id,{kind:'save',title:'Baseline',force:true})
    expect(saved.error).toContain('启动命令')
  })
  it('refuses a forced draft with a placeholder command',async()=>{
    const d=dependencies()
    const pending:RepositoryGuide={...structuredClone(guide),status:'needs_info',missingInputs:[],launchCommand:'python train.py --data /path/to/data'}
    const analyze=vi.fn(async()=>structuredClone(pending))
    const service=new RepositoryWorkflowService(d.store,{analyze,recheck:d.recheck},()=>{},directory)
    const flow=await service.create(input)
    await service.act(flow.id,{kind:'step',index:0,confirmed:true})
    const saved=await service.act(flow.id,{kind:'save',title:'Baseline',force:true})
    expect(saved.error).toContain('占位符')
  })
  it('refuses a forced draft when the entry file is missing',async()=>{
    const d=dependencies()
    const pending:RepositoryGuide={...structuredClone(guide),status:'needs_info',missingInputs:[],checks:[{path:'train.py',expected:'file',status:'missing',message:'本次未找到该路径'}]}
    const analyze=vi.fn(async()=>structuredClone(pending))
    const service=new RepositoryWorkflowService(d.store,{analyze,recheck:d.recheck},()=>{},directory)
    const flow=await service.create(input)
    await service.act(flow.id,{kind:'step',index:0,confirmed:true})
    const saved=await service.act(flow.id,{kind:'save',title:'Baseline',force:true})
    expect(saved.error).toContain('入口文件')
  })
  it('cannot mark execution successful by checking a box; saves only one planned draft',async()=>{
    const d=dependencies(),flow=await d.service.create(input)
    const invalid=await d.service.act(flow.id,{kind:'step',index:1,confirmed:true})
    expect(invalid.error).toContain('不能手动')
    await d.service.act(flow.id,{kind:'step',index:0,confirmed:true})
    const saved=await d.service.act(flow.id,{kind:'save',title:'Baseline'})
    expect(saved.taskId).toBeTruthy();expect(tasks[0].status).toBe('planned');expect(tasks[0].runs).toEqual([])
    await d.service.act(flow.id,{kind:'save',title:'Baseline'})
    expect(d.save).toHaveBeenCalledTimes(1);expect(d.analyze).toHaveBeenCalledTimes(1)
  })
  it('keeps the bound failed run when a later independent run succeeds',async()=>{
    const d=dependencies(),flow=await d.service.create(input)
    await d.service.act(flow.id,{kind:'step',index:0,confirmed:true});await d.service.act(flow.id,{kind:'save',title:'Baseline'})
    const run={id:randomUUID(),number:1,status:'failed'} as ExperimentTask['runs'][number]
    tasks[0].runs.push(run)
    const tracked=await d.service.act(flow.id,{kind:'sync'})
    tasks[0].runs.push({...run,id:randomUUID(),number:2,status:'completed'})
    expect(tracked.runId).toBe(run.id);expect((await d.service.list())[0].phase).toBe('failed')
    tasks[0].runs.shift();expect((await d.service.list())[0].phase).toBe('run_missing')
  })
  it('preserves unknown token counts instead of treating them as zero',()=>{
    const total=sumModelUsage([{requests:1,elapsedMs:10,totalTokens:20},{requests:1,elapsedMs:5}])
    expect(total.requests).toBe(2);expect(total.totalTokens).toBeUndefined()
  })
})
