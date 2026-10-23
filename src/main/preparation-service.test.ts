import type { PreparationFlow } from '../shared/preparation'
import type { RepositoryAnalysisInput } from '../shared/repository-guide'
import type { AgentTraceObserver } from '../shared/agent-trace'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RepositoryGuide, RepositorySnapshot } from '../shared/repository-guide'
import type { PreparationEdit, PreparationView } from '../shared/preparation'
import type { ExperimentTask, ExperimentTaskDraft } from '../shared/types'
vi.mock('electron',()=>({app:{getPath:()=>''}}))
import { PreparationService } from './preparation-service'
const serverId='22222222-2222-4222-8222-222222222222'
const input={serverId,accessRouteId:'direct',path:'/repo',goal:'训练一次基线'}
let directory:string
const services:PreparationService[]=[]
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'labdeck-preparation-'))})
afterEach(async()=>{for(const service of services)service.stop();services.length=0;const target=resolve(directory),parent=resolve(tmpdir());if(!target.startsWith(parent+'\\')&&!target.startsWith(parent+'/'))throw new Error('Unsafe temporary test path');await rm(target,{recursive:true,force:true})})
function setup(){
  const tasks:ExperimentTask[]=[],snapshot:RepositorySnapshot={input:{source:'remote',...input},files:[{path:'README.md',sizeBytes:100},{path:'train.py',sizeBytes:50}],excerpts:[{path:'README.md',startLine:1,text:'python train.py --data /data/original',truncated:false}],warnings:[],collectedAt:new Date().toISOString()}
  const guide:RepositoryGuide={status:'needs_info',summary:'已有训练入口，需要核对数据',steps:[],launchCommand:'python train.py --data /data/original',workingDirectory:'.',environmentName:'',dataPath:'',launchOrigin:'documented',launchSources:['README.md'],launchCitations:[{path:'README.md',startLine:1,endLine:1,quote:'python train.py --data /data/original'}],missingInputs:['数据目录在哪里'],questions:[],warnings:[],checks:[],snapshot}
  const ops={scan:vi.fn(async()=>structuredClone(snapshot)),environments:vi.fn(async()=>[{name:'vision',prefix:'/opt/conda/envs/vision'}]),analyze:vi.fn(async(_input:RepositoryAnalysisInput,_signal:AbortSignal,_trace:AgentTraceObserver)=>structuredClone(guide)),candidates:vi.fn(async()=>[{path:'/repo/data',source:'server' as const,note:'已找到'}]),recheck:vi.fn(async(_flow:PreparationFlow)=>({at:new Date().toISOString(),lines:[{ok:true,text:'启动目录存在：/repo'}]})),save:vi.fn(async(draft:ExperimentTaskDraft,id:string)=>{
    const existing=tasks.find(task=>task.preparationId===id)
    const task={...draft,id:existing?.id??randomUUID(),preparationId:id,status:'planned' as const,archived:false,runs:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}
    if(existing)tasks.splice(tasks.indexOf(existing),1,task);else tasks.push(task)
    return structuredClone(task)
  }),tasks:()=>structuredClone(tasks)}
  const service=()=>{const value=new PreparationService(ops,()=>{},directory);services.push(value);return value}
  return {ops,service,tasks}
}
function editOf(view:PreparationView):PreparationEdit{return {draft:{...view.plan!.draft,dataPath:'/repo/data',launchCommand:'python train.py --data /repo/data'},mode:view.plan!.mode,fields:{...view.plan!.fields,dataPath:{source:'user'}},deferredGaps:['environment'],conflicts:[],history:[]}}
describe('durable experiment preparation',()=>{
  it('restores the exact plan, changes, deferred questions and trace without repeating analysis',async()=>{
    const {ops,service}=setup(),first=service(),id=randomUUID()
    const created=await first.create(input,id)
    expect(created.pending).toContain('wait');expect(created.plan).toBeDefined()
    const edited=await first.act(id,{kind:'edit',expectedRevision:created.revision,edit:editOf(created),label:'使用项目数据目录'})
    const restored=await service().get(id)
    expect(restored.plan!.draft).toEqual(edited.plan!.draft)
    expect(restored.edit?.deferredGaps).toEqual(['environment'])
    expect(restored.trace.some(event=>event.name==='更新实验方案'&&event.summary.includes('/repo/data'))).toBe(true)
    expect(ops.analyze).toHaveBeenCalledTimes(1);expect(ops.save).not.toHaveBeenCalled()
  })
  it('checks only current configuration after a supplement, without rescanning or using a model',async()=>{
    const {ops,service}=setup(),s=service(),id=randomUUID(),created=await s.create(input,id)
    const edited=await s.act(id,{kind:'edit',expectedRevision:created.revision,edit:editOf(created)})
    const checked=await s.act(id,{kind:'recheck',expectedRevision:edited.revision})
    expect(checked.checks?.lines[0].ok).toBe(true)
    expect(ops.scan).toHaveBeenCalledTimes(1);expect(ops.analyze).toHaveBeenCalledTimes(1)
    expect(ops.recheck.mock.calls[0][0].plan!.draft.dataPath).toBe('/repo/data')
    expect((await service().get(id)).checks).toEqual(checked.checks)
  })
  it('creates one task on repeated save and preserves its identity across a restart',async()=>{
    const {service,tasks}=setup(),s=service(),id=randomUUID(),created=await s.create(input,id)
    const saved=await s.act(id,{kind:'save',expectedRevision:created.revision})
    const again=await service().act(id,{kind:'save',expectedRevision:saved.revision})
    expect(tasks).toHaveLength(1);expect(again.task?.id).toBe(saved.task?.id);expect(tasks[0].runs).toEqual([])
    expect(again.phase).toBe('saved')
  })
  it('recovers a task persisted immediately before a failed graph save checkpoint',async()=>{
    const {ops,service,tasks}=setup(),s=service(),id=randomUUID(),created=await s.create(input,id)
    const write=ops.save.getMockImplementation()!
    ops.save.mockImplementationOnce(async(draft,key)=>{await write(draft,key);throw new Error('模拟保存后进程中断')})
    const failed=await s.act(id,{kind:'save',expectedRevision:created.revision})
    expect(failed.error).toContain('中断');expect(tasks).toHaveLength(1)
    const recovered=await service().act(id,{kind:'resume'})
    expect(recovered.error).toBeUndefined();expect(tasks).toHaveLength(1);expect(recovered.task?.id).toBe(tasks[0].id)
  })
  it('resumes an interrupted model node from its checkpoint and keeps completed scans',async()=>{
    const {ops,service}=setup(),s=service(),id=randomUUID()
    let start!:()=>void;const started=new Promise<void>(resolve=>{start=resolve})
    ops.analyze.mockImplementationOnce(async(_input,_signal)=>{start();return new Promise((_resolve,reject)=>{_signal.addEventListener('abort',()=>reject(_signal.reason),{once:true})})})
    const pending=s.create(input,id);await started;await s.cancel(id)
    const paused=await pending;expect(paused.phase).toBe('paused');expect(paused.pending).toContain('analyze')
    const resumed=await service().act(id,{kind:'resume'})
    expect(resumed.plan).toBeDefined();expect(ops.scan).toHaveBeenCalledTimes(1);expect(ops.environments).toHaveBeenCalledTimes(1);expect(ops.analyze).toHaveBeenCalledTimes(2)
  })
  it('rejects stale edits and editing across servers, preserving the prior draft',async()=>{
    const {service}=setup(),s=service(),id=randomUUID(),created=await s.create(input,id)
    await expect(s.act(id,{kind:'edit',expectedRevision:0,edit:editOf(created)})).rejects.toThrow('已更新')
    const edit=editOf(created);edit.draft.serverId=randomUUID()
    const failed=await s.act(id,{kind:'edit',expectedRevision:created.revision,edit})
    expect(failed.error).toContain('其他服务器');expect(failed.plan?.draft.serverId).toBe(serverId)
  })
  it('keeps user choices when the optional environment lookup fails',async()=>{
    const {ops,service}=setup();ops.environments.mockRejectedValueOnce(new Error('offline'))
    const view=await service().create(input,randomUUID())
    expect(view.plan).toBeDefined();expect(view.trace.some(event=>event.status==='warning')).toBe(true)
    expect(view.error).toBeUndefined()
  })
})

describe('preparation record lifecycle',()=>{
  it('only recreates a deleted task through an explicit save-as-new action',async()=>{
    const {service,tasks,ops}=setup(),s=service(),id=randomUUID()
    const created=await s.create(input,id)
    const saved=await s.act(id,{kind:'save',expectedRevision:created.revision})
    const oldId=saved.task!.id
    tasks.splice(0)
    const rejected=await s.act(id,{kind:'save',expectedRevision:saved.revision})
    expect(rejected.error).toContain('另存为新任务');expect(tasks).toHaveLength(0)
    const recreated=await s.act(id,{kind:'save-as-new',expectedRevision:rejected.revision})
    expect(recreated.error).toBeUndefined();expect(recreated.task!.id).not.toBe(oldId)
    expect(ops.save.mock.calls.at(-1)![0].id).toBeUndefined()
    expect(recreated.plan!.draft.id).toBe(recreated.task!.id)
    const restored=await service().get(id)
    expect(restored.taskId).toBe(recreated.task!.id)
    await service().act(id,{kind:'save',expectedRevision:restored.revision})
    expect(tasks).toHaveLength(1)
  })
  it('does not save-as-new when the linked task still exists',async()=>{
    const {service,tasks}=setup(),s=service(),id=randomUUID(),created=await s.create(input,id)
    const saved=await s.act(id,{kind:'save',expectedRevision:created.revision})
    const rejected=await s.act(id,{kind:'save-as-new',expectedRevision:saved.revision})
    expect(rejected.error).toContain('原任务仍存在');expect(tasks).toHaveLength(1)
  })
  it('deletes preparation checkpoints permanently without deleting the saved experiment task',async()=>{
    const {service,tasks}=setup(),s=service(),id=randomUUID(),created=await s.create(input,id)
    const saved=await s.act(id,{kind:'save',expectedRevision:created.revision})
    await s.remove(id)
    expect(await s.list()).toEqual([])
    expect(tasks[0].id).toBe(saved.task!.id)
    const restarted=service()
    expect(await restarted.list()).toEqual([])
    await expect(restarted.get(id)).rejects.toThrow('准备流程不存在')
    expect(tasks).toHaveLength(1)
  })
  it('refuses to delete a record while its model step is running',async()=>{
    const {ops,service}=setup(),s=service(),id=randomUUID()
    let started!:()=>void
    const ready=new Promise<void>(resolve=>{started=resolve})
    ops.analyze.mockImplementationOnce(async(_input,signal)=>{started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))})
    const pending=s.create(input,id);await ready
    try{await expect(s.remove(id)).rejects.toThrow('先停止')}
    finally{await s.cancel(id);await pending}
    await s.remove(id)
    expect(await s.list()).toEqual([])
  })
})

describe('preparation checkpoint bounds',()=>{
  it('keeps the recent checkpoints bounded while retaining the editable state',async()=>{
    const {service}=setup(),s=service(),id=randomUUID();let view=await s.create(input,id)
    for(let i=0;i<12;i++){
      const edit=editOf(view);edit.draft.title=`第 ${i} 次修改`
      view=await s.act(id,{kind:'edit',expectedRevision:view.revision,edit})
      expect(view.error).toBeUndefined()
    }
    const checkpoint=JSON.parse(await (await import('node:fs/promises')).readFile(join(directory,'checkpoints.json'),'utf8'))
    for(const values of Object.values(checkpoint.storage[id]) as Record<string,unknown>[])expect(Object.keys(values).length).toBeLessThanOrEqual(8)
    expect((await service().get(id)).plan!.draft.title).toBe('第 11 次修改')
  })
  it('deduplicates concurrent creation and replays no completed model work',async()=>{
    const {ops,service}=setup(),s=service(),id=randomUUID()
    const results=await Promise.all([s.create(input,id),s.create(input,id)])
    expect(results[0].id).toBe(id);expect(results[1].id).toBe(id)
    expect(ops.scan).toHaveBeenCalledTimes(1);expect(ops.analyze).toHaveBeenCalledTimes(1)
  })
})


describe('preparation evidence scope',()=>{
  it('retains a read-only check when saving or renaming, and marks it stale after path edits',async()=>{
    const {service}=setup(),s=service(),id=randomUUID(),created=await s.create(input,id)
    const checked=await s.act(id,{kind:'recheck',expectedRevision:created.revision})
    const saved=await s.act(id,{kind:'save',expectedRevision:checked.revision})
    const checkedAgain=await s.act(id,{kind:'recheck',expectedRevision:saved.revision})
    expect(checkedAgain.phase).toBe('saved')
    const {projectConfigurationKey}=await import('../shared/project-task')
    const key=checkedAgain.checks!.configurationKey
    expect(key).toBe(projectConfigurationKey(checkedAgain.plan!.draft))
    const edit=editOf(checkedAgain);edit.draft.codePath='/other'
    const updated=await s.act(id,{kind:'edit',expectedRevision:checkedAgain.revision,edit})
    expect(updated.checks!.configurationKey).toBe(key)
    expect(updated.checks!.configurationKey).not.toBe(projectConfigurationKey(updated.plan!.draft))
  })
})
