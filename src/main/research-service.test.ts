import { dialog } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
  const s=new ResearchService(store,{requestResearchModel:requestModel,history:async()=>[],diagnose} as unknown as IntelligenceService,{connect:async()=>({client:{end(){}}}),exec:sshExec} as unknown as SshService,()=>{},()=>{},{directory,engineDirectory:resolve('artifacts/no-cangjie')});services.push(s);return s
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
    expect(initial.pending).toEqual(['review']);expect(initial.members).toHaveLength(2);expect(initial.expansionEngine).toBe('typescript');expect(save).not.toHaveBeenCalled()
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
    expect(result.stage).toBe('analysis');expect(result.pending).toEqual([]);expect(result.observations.map(o=>o.metrics.val_loss)).toEqual([1.8,1.8]);expect(result.analysis?.engine).toBe('rules');expect(result.analysis?.summary).toContain('2 项已核对正常结束');expect(diagnose).not.toHaveBeenCalled();expect(requestModel).toHaveBeenCalledTimes(1)
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
  it('persists selected files and can reread missing results without requeueing or model calls',async()=>{
    const s=service()
    const selected=await s.create({taskId:source.id,objective:'比较学习率',axes:[{flag:'--lr',values:['0.001','0.0001']}],maxRuns:2,useModel:true,resultConfig:{metricsFile:'{runDir}/metrics.json',artifacts:['{runDir}/model.pt']}})
    await s.approve(selected.id,true)
    tasks.slice(1).forEach((task,i)=>Object.assign(task.runs[0],{status:'completed',remoteRunDir:`/workspace/run${i}`,logPath:`/workspace/run${i}/log`}))
    let ready=false
    sshExec.mockImplementation(async(_client,command:string)=>{
      if(command.includes('__LABDECK_EXIT__'))return '__LABDECK_EXIT__0'
      if(!command.includes('__LABDECK_RESULT_FILES__'))return 'val_accuracy=0.99'
      const index=command.includes('/workspace/run0')?0:1
      const child=tasks[index+1].runs[0],root=child.remoteRunDir!
      const files=ready?[{path:root+'/metrics.json',resolvedPath:root+'/metrics.json',status:'available',kind:'file',sizeBytes:80,modifiedAt:'2026-10-15T01:00:00Z',content:Buffer.from(JSON.stringify({runId:child.id,dataset:'vision-v1',split:'validation',metrics:{accuracy:{value:0.01,unit:'ratio',direction:'maximize'}}})).toString('base64')},{path:root+'/model.pt',resolvedPath:root+'/model.pt',status:'available',kind:'file',sizeBytes:100,modifiedAt:'2026-10-15T01:00:00Z'}]:[{path:root+'/metrics.json',status:'missing'},{path:root+'/model.pt',status:'missing'}]
      return '__LABDECK_RESULT_FILES__'+JSON.stringify(files)
    })
    const empty=await s.refresh(selected.id)
    expect(empty.observations.every(o=>o.evidenceState==='missing'&&o.processState==='completed')).toBe(true)
    const modelCalls=requestModel.mock.calls.length
    const reopened=service();expect((await reopened.list())[0].resultConfig).toEqual(selected.resultConfig)
    await reopened.setPaused(selected.id,true)
    await expect(reopened.recollect(selected.id)).rejects.toThrow('恢复')
    await reopened.setPaused(selected.id,false)
    ready=true
    const collected=await reopened.recollect(selected.id)
    expect(collected.observations.every(o=>o.metrics.accuracy===0.01&&o.evidenceState==='complete')).toBe(true)
    expect(collected.analysis?.engine).toBe('rules');expect(collected.pending).toEqual([])
    expect(start).toHaveBeenCalledTimes(2);expect(save).toHaveBeenCalledTimes(2);expect(diagnose).not.toHaveBeenCalled()
    expect(requestModel).toHaveBeenCalledTimes(modelCalls)
    expect(collected.events.some(e=>e.node==='recollect')).toBe(true)
    const outputPath=join(directory,'structured-export.json')
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({canceled:false,filePath:outputPath})
    await reopened.export(selected.id)
    const exported=JSON.parse(await readFile(outputPath,'utf8'))
    expect(exported.resultConfig.metricsFile).toBe('{runDir}/metrics.json')
    expect(exported.observations[0].metricDetails[0]).toMatchObject({dataset:'vision-v1',unit:'ratio',source:'metrics_json'})
    expect(exported.observations[0].files[1]).toMatchObject({role:'artifact',sizeBytes:100})
    expect(exported.observations[0].files[0]).not.toHaveProperty('content')
  })
  it('does not recollect while waiting or paused, and warns about shared output paths',async()=>{
    const s=service(),selected=await s.create({taskId:source.id,objective:'compare',axes:[{flag:'--lr',values:['1','2']}],maxRuns:2,useModel:false,resultConfig:{metricsFile:'results/metrics.json',artifacts:[]}})
    expect(selected.warnings.some(w=>w.includes('可能被覆盖'))).toBe(true)
    await expect(s.recollect(selected.id)).rejects.toThrow('运行结束')
    expect(start).not.toHaveBeenCalled()
  })
})


