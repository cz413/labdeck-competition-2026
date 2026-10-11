import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppStore } from './store'
import type { IntelligenceService } from './intelligence-service'
import type { SshService } from './ssh-service'
import type { ExperimentTask, ExperimentTaskDraft, ExperimentRunStartInput } from '../shared/types'
const globals=vi.hoisted(()=>({directory:''}))
vi.mock('electron',()=>({app:{getPath:()=>globals.directory,getAppPath:()=>process.cwd(),isPackaged:false},dialog:{showSaveDialog:vi.fn()},ipcMain:{handle:vi.fn()}}))
import { ResearchService } from './research-service'
let tasks:ExperimentTask[],directory:string,source:ExperimentTask
const services:ResearchService[]=[]
const serverId=randomUUID(),requestModel=vi.fn(),diagnose=vi.fn(),save=vi.fn(),start=vi.fn(),sshExec=vi.fn()
let store:AppStore
function service(){
  const s=new ResearchService(store,{requestResearchModel:requestModel,history:async()=>[],diagnose} as unknown as IntelligenceService,{connect:async()=>({client:{end(){}}}),exec:sshExec} as unknown as SshService,()=>{},()=>{},{directory,engineDirectory:resolve('resources/cangjie')});services.push(s);return s
}
async function create(s:ResearchService,useModel=false){return s.create({taskId:source.id,objective:'比较学习率',axes:[{flag:'--lr',values:['0.001','0.0001']}],maxRuns:2,useModel})}
beforeEach(async()=>{
  vi.clearAllMocks();directory=await mkdtemp(join(tmpdir(),'labdeck-research-test-'));globals.directory=directory
  const stamp=new Date().toISOString()
  source={id:randomUUID(),title:'基准训练',project:'vision',objective:'baseline',tags:[],priority:'normal',status:'planned',serverId,accessRouteId:'direct',codePath:'/workspace/vision',dataPath:'/datasets/vision',launchCommand:'python train.py --lr 0.01 --batch-size 16',launchMode:'command',scriptPath:'',artifactPath:'',resultSummary:'',notes:'base notes',archived:false,createdAt:stamp,updatedAt:stamp,runs:[]};tasks=[source]
  save.mockImplementation(async(draft:ExperimentTaskDraft)=>{const task={...draft,id:randomUUID(),createdAt:stamp,updatedAt:stamp,archived:false,runs:[]} as ExperimentTask;tasks.push(task);return structuredClone(task)})
  start.mockImplementation(async(id:string,input:ExperimentRunStartInput)=>{const task=tasks.find(t=>t.id===id)!;task.runs.push({...input,id:randomUUID(),number:1,status:'queued',resultSummary:''} as unknown as ExperimentTask['runs'][number]);task.status='queued';return structuredClone(task)})
  store={listExperimentTasks:()=>structuredClone(tasks),getServer:()=>({id:serverId,name:'GPU',mode:'real',host:'192.0.2.1',port:22,username:'user',authType:'password',hostFingerprint:'SHA256:fixture'}),getSecrets:()=>({}),saveExperimentTask:save,startExperimentRun:start} as unknown as AppStore
  sshExec.mockImplementation(async(_client,command:string)=>command.includes('__LABDECK_EXIT__')?'__LABDECK_EXIT__0':'epoch=2 val_loss=1.8 val_acc=0.51')
  requestModel.mockRejectedValue(new Error('模型离线'));diagnose.mockResolvedValue({id:randomUUID()})
})
afterEach(async()=>{services.forEach(s=>s.stop());services.length=0;const target=resolve(directory),parent=resolve(tmpdir());if(!target.startsWith(parent+'\\')&&!target.startsWith(parent+'/'))throw new Error('Unsafe temp path');await rm(target,{recursive:true,force:true})})
describe('persistent experiment research graph',()=>{
  it('recovers a checkpoint whose index write was interrupted',async()=>{
    const original=await create(service())
    await rm(join(directory,'campaigns.json'))
    const recovered=(await service().list())[0]
    expect(recovered.id).toBe(original.id);expect(recovered.pending).toEqual(['review']);expect(start).not.toHaveBeenCalled()
  })
  it('interrupts for approval and resumes the same checkpoint after a new service instance',async()=>{
    const initial=await create(service())
    expect(initial.pending).toEqual(['review']);expect(initial.members).toHaveLength(2);expect(initial.expansionEngine).toBe('cangjie');expect(save).not.toHaveBeenCalled()
    const reopened=service();const restored=(await reopened.list())[0]
    expect(restored.id).toBe(initial.id);expect(restored.members).toEqual(initial.members)
    await expect(reopened.approve(initial.id,false)).rejects.toThrow('确认')
    const waiting=await reopened.approve(initial.id,true)
    expect(waiting.pending).toEqual(['observe']);expect(start).toHaveBeenCalledTimes(2);expect(tasks[0].launchCommand).toBe(source.launchCommand);expect(tasks[0].runs).toHaveLength(0)
    await reopened.approve(initial.id,true);expect(start).toHaveBeenCalledTimes(2)
  })
  it('recovers a partially submitted batch without creating duplicate tasks or runs',async()=>{
    const s=service(),initial=await create(s)
    start.mockImplementationOnce(async(id:string,input:ExperimentRunStartInput)=>{const task=tasks.find(t=>t.id===id)!;task.runs.push({...input,id:randomUUID(),number:1,status:'queued',resultSummary:''} as unknown as ExperimentTask['runs'][number]);task.status='queued';return structuredClone(task)})
    start.mockRejectedValueOnce(new Error('模拟第二项持久化失败'))
    await expect(s.approve(initial.id,true)).rejects.toThrow('第二项')
    expect(tasks).toHaveLength(3);expect(tasks[1].runs).toHaveLength(1);expect(tasks[2].runs).toHaveLength(0)
    const recovered=await service().refresh(initial.id)
    expect(recovered.pending).toEqual(['observe']);expect(tasks).toHaveLength(3);expect(tasks.slice(1).map(t=>t.runs.length)).toEqual([1,1])
  })
  it('stops recovery if a confirmed child task was edited',async()=>{
    const s=service(),initial=await create(s)
    const implementation=start.getMockImplementation()!
    start.mockImplementationOnce(implementation).mockRejectedValueOnce(new Error('partial failure'))
    await expect(s.approve(initial.id,true)).rejects.toThrow('partial')
    tasks[1].launchCommand='python train.py --lr 9'
    await expect(service().refresh(initial.id)).rejects.toThrow('发生变化')
    expect(tasks[1].runs).toHaveLength(1);expect(tasks[2].runs).toHaveLength(0)
  })
  it('does not create another run when a child run lost its association marker',async()=>{
    const s=service(),initial=await create(s)
    const implementation=start.getMockImplementation()!
    start.mockImplementationOnce(implementation).mockRejectedValueOnce(new Error('partial failure'))
    await expect(s.approve(initial.id,true)).rejects.toThrow('partial')
    tasks[1].runs[0].notes='manually edited'
    tasks[1].runs[0].status='completed'
    await expect(service().refresh(initial.id)).rejects.toThrow('去重标记')
    expect(tasks[1].runs).toHaveLength(1)
  })
  it('waits without model polling and treats poor metrics as observations rather than faults',async()=>{
    const s=service(),initial=await create(s,true);await s.approve(initial.id,true)
    await s.refresh(initial.id);expect(requestModel).not.toHaveBeenCalled();expect(sshExec).not.toHaveBeenCalled()
    tasks.slice(1).forEach((t,i)=>{t.runs[0].status='completed';t.runs[0].logPath=`/workspace/run${i}/log`;t.runs[0].remoteRunDir=`/workspace/run${i}`})
    const result=await s.refresh(initial.id)
    expect(result.stage).toBe('analysis');expect(result.pending).toEqual([]);expect(result.observations.map(o=>o.metrics.val_loss)).toEqual([1.8,1.8]);expect(result.analysis?.engine).toBe('rules');expect(result.analysis?.summary).toContain('2 项正常结束');expect(diagnose).not.toHaveBeenCalled();expect(requestModel).toHaveBeenCalledTimes(1)
    expect((await service().list())[0].analysis).toEqual(result.analysis)
  })
  it('links runtime failures to existing diagnosis and never retries a repair automatically',async()=>{
    const s=service(),initial=await create(s);await s.approve(initial.id,true)
    tasks.slice(1).forEach((t,i)=>{t.runs[0].status='failed';t.runs[0].logPath=`/workspace/run${i}/log`;t.runs[0].remoteRunDir=`/workspace/run${i}`})
    sshExec.mockImplementation(async(_client,command:string)=>command.includes('__LABDECK_EXIT__')?'__LABDECK_EXIT__1':'RuntimeError: CUDA out of memory')
    const result=await s.refresh(initial.id)
    expect(result.observations.every(o=>o.diagnosisId)).toBe(true);expect(diagnose).toHaveBeenCalledTimes(2);expect(start).toHaveBeenCalledTimes(2);expect(result.events.some(e=>e.node==='diagnose')).toBe(true)
  })
  it('pause survives restart and does not alter queued runs',async()=>{
    const s=service(),initial=await create(s);await s.approve(initial.id,true);await s.setPaused(initial.id,true)
    const restored=await service().refresh(initial.id)
    expect(restored.paused).toBe(true);expect(restored.pending).toEqual(['observe']);expect(tasks[1].runs[0].status).toBe('queued')
  })
  it('rejects ungrounded model evidence and never silently declares success from missing logs',async()=>{
    const s=service(),initial=await create(s,true);await s.approve(initial.id,true)
    tasks.slice(1).forEach(t=>{t.runs[0].status='completed'})
    requestModel.mockResolvedValue({summary:'保证达到目标',observations:[],limitations:[],evidenceIds:['invented']})
    const result=await s.refresh(initial.id)
    expect(result.analysis?.engine).toBe('rules');expect(result.analysis?.limitations.join('')).toContain('不存在的运行证据');expect(result.observations.every(o=>o.exitCode===undefined&&!!o.warning)).toBe(true)
  })
  it('checks suggestion budget before exposing model-generated axes',async()=>{
    requestModel.mockResolvedValue({axes:[{flag:'--lr',values:['1','2','3']}],assumptions:[],hypothesis:'compare'})
    await expect(service().suggest(source.id,'比较学习率',2)).rejects.toThrow('预算');expect(start).not.toHaveBeenCalled()
  })
})


