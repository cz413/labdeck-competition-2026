import { resultAnalysisPayload } from './research-analysis'
import { dialog } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppStore } from './store'
import type { IntelligenceService } from './intelligence-service'
import type { SshService } from './ssh-service'
import type { ExperimentTask, ExperimentTaskDraft, ExperimentRunStartInput } from '../shared/types'
const globals=vi.hoisted(()=>({directory:''}))
vi.mock('./repository-reader',()=>({openRepositoryReadSession:vi.fn()}))
import { openRepositoryReadSession } from './repository-reader'
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
  vi.mocked(openRepositoryReadSession).mockImplementation(async()=>{
    const snapshot={input:{source:'remote' as const,path:source.codePath,serverId},files:[{path:'train.py',sizeBytes:300},{path:'README.md',sizeBytes:100}],excerpts:[] as import('../shared/repository-guide').RepositoryExcerpt[],warnings:[],collectedAt:stamp}
    return {snapshot,maxChars:180000,read:async(path:string)=>{const excerpt={path,startLine:1,truncated:false,text:path==='train.py'?"p.add_argument('--lr', type=float, default=0.01)\np.add_argument('--batch-size', type=int, default=16)\np.add_argument('--output_dir', default='outputs')\nos.makedirs(args.output_dir, exist_ok=True)\nf=open(os.path.join(args.output_dir, 'log.txt'), 'w')":'训练示例：python train.py --lr 0.01'};snapshot.excerpts.push(excerpt);return excerpt},find:()=>[],list:()=>({directories:[],files:[]}),close:vi.fn()}
  })
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
    expect(result.stage).toBe('analysis');expect(result.pending).toEqual([]);expect(result.observations.map(o=>o.metrics.val_loss)).toEqual([1.8,1.8]);expect(result.analysis?.engine).toBe('rules');expect(result.analysis?.summary).toContain('已采集指标');expect(diagnose).not.toHaveBeenCalled();expect(requestModel).not.toHaveBeenCalled()
    expect((await service().list())[0].analysis).toEqual(result.analysis)
    await s.analyze(initial.id);expect(requestModel).toHaveBeenCalledTimes(1)
  })
  it('only requests AI analysis explicitly after completion, including batches created without model opt-in',async()=>{
    const s=service(),initial=await create(s)
    await expect(s.analyze(initial.id)).rejects.toThrow('运行结束')
    await s.approve(initial.id,true)
    tasks.slice(1).forEach(t=>{t.runs[0].status='completed'})
    const result=await s.refresh(initial.id)
    expect(requestModel).not.toHaveBeenCalled()
    requestModel.mockResolvedValue({summary:'根据本批记录进行比较',observations:[],limitations:[],evidenceIds:result.observations.map(o=>o.evidenceId)})
    expect((await s.analyze(initial.id)).analysis?.engine).toBe('model')
    expect(requestModel).toHaveBeenCalledTimes(1)
    await s.analyze(initial.id)
    await expect(s.analyze(initial.id)).rejects.toThrow('次数上限')
    expect(requestModel).toHaveBeenCalledTimes(2)
  })
  it('uses the selected historical run snapshot for design and new tasks instead of current configuration',async()=>{
    const runId=randomUUID()
    source.runs=[{id:runId,number:1,status:'failed',serverId,accessRouteId:'direct',computeDevice:'cpu',codePath:'/workspace/old',dataPath:'/datasets/old',launchCommand:'python train.py --lr 0.02',launchMode:'command',condaEnvironment:{manager:'conda',environmentName:'old-env'},artifactPath:'/outputs/old',resultSummary:'',notes:''}]
    source.launchCommand='bash changed.sh';source.launchMode='script';source.codePath='/workspace/new';source.condaEnvironment={manager:'conda',environmentName:'new-env'}
    const s=service()
    requestModel.mockResolvedValue({axes:[{flag:'--lr',values:['0.001']}],assumptions:[],hypothesis:'compare',rationale:'keep other settings'})
    const design=await s.suggest(source.id,'比较学习率',2,runId)
    expect(design.baselineCommand).toBe('python train.py --lr 0.02')
    expect(vi.mocked(openRepositoryReadSession).mock.calls[0][2].path).toBe('/workspace/old')
    const batch=await s.create({taskId:source.id,sourceRunId:runId,objective:'比较学习率',axes:design.axes,maxRuns:2,design})
    expect(batch).toMatchObject({sourceRunId:runId,sourceRunNumber:1,baseline:{codePath:'/workspace/old',dataPath:'/datasets/old',computeDevice:'cpu',condaEnvironment:{environmentName:'old-env'}}})
    expect((await service().list())[0].sourceRunId).toBe(runId)
    await s.approve(batch.id,true)
    expect(tasks[1]).toMatchObject({computeDevice:'cpu',codePath:'/workspace/old',condaEnvironment:{environmentName:'old-env'}})
    expect(tasks[1].launchCommand).toContain('python train.py --lr 0.02')
    expect(source.launchCommand).toBe('bash changed.sh')
  })
  it('rejects missing or incomplete selected snapshots without falling back to the current task',async()=>{
    const runId=randomUUID()
    const input={taskId:source.id,sourceRunId:runId,objective:'比较学习率',axes:[{flag:'--lr',values:['0.01','0.001']}],maxRuns:2}
    await expect(service().create(input)).rejects.toThrow('运行记录不存在')
    source.runs=[{id:runId,number:1,status:'completed',resultSummary:'',notes:''}]
    await expect(service().create(input)).rejects.toThrow('配置快照')
    expect(save).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled()
  })
  it('does not inherit a newly configured environment or data directory when the selected run used neither',async()=>{
    const runId=randomUUID()
    source.runs=[{id:runId,number:1,status:'completed',serverId,codePath:'/workspace/old',launchCommand:'python train.py --lr 0.01',resultSummary:'',notes:''}]
    source.condaEnvironment={manager:'conda',environmentName:'new-env'}
    const batch=await service().create({taskId:source.id,sourceRunId:runId,objective:'比较学习率',axes:[{flag:'--lr',values:['0.01','0.001']}],maxRuns:2})
    expect(batch.baseline.condaEnvironment).toBeUndefined();expect(batch.baseline.dataPath).toBe('')
  })
  it('passes all raw result files to AI only after a manual request',async()=>{
    const s=service(),batch=await s.create({taskId:source.id,objective:'compare',axes:[{flag:'--lr',values:['0.01','0.001']}],maxRuns:2,resultConfig:{metricsFile:'',artifacts:[],resultFiles:['{runDir}/log.txt','{runDir}/results.csv']}})
    await s.approve(batch.id,true)
    tasks.slice(1).forEach((task,i)=>Object.assign(task.runs[0],{status:'completed',remoteRunDir:`/runs/${i}`,logPath:`/runs/${i}/stdout.log`}))
    sshExec.mockImplementation(async(_client,command:string)=>{
      if(command.includes('__LABDECK_EXIT__'))return '__LABDECK_EXIT__0'
      if(!command.includes('__LABDECK_RESULT_FILES__'))return 'console output'
      const root=command.includes('/runs/0')?'/runs/0':'/runs/1'
      return '__LABDECK_RESULT_FILES__'+JSON.stringify(['log.txt','results.csv'].map(name=>({path:root+'/'+name,resolvedPath:root+'/'+name,status:'available',kind:'file',sizeBytes:20,content:Buffer.from(name==='log.txt'?'recall 0.5':'ndcg,value\nndcg,0.4').toString('base64')})))
    })
    const ready=await s.refresh(batch.id);expect(requestModel).not.toHaveBeenCalled()
    requestModel.mockResolvedValue({summary:'compare results',observations:[],limitations:[],evidenceIds:ready.observations.map(o=>o.evidenceId)})
    await s.analyze(batch.id)
    const payload=requestModel.mock.calls[0][1]
    for(const internal of ['exitCode','processState','evidenceState','sizeBytes','association','truncated','remoteRunDir'])expect(JSON.stringify(payload)).not.toContain('"'+internal+'"')
    expect(payload.runs[0].results.every((result:{text:string})=>!result.text.includes('console output'))).toBe(true)
    expect(payload.resultSource).toBeUndefined();expect(payload.runs[0].results.map((f:{text:string})=>f.text)).toEqual(['recall 0.5','ndcg,value\nndcg,0.4'])
    expect((await service().list())[0].resultConfig?.resultFiles).toHaveLength(2)
  })
  it('updates result sources after completion, persists them, and never queues another run or calls AI',async()=>{
    const s=service(),batch=await create(s)
    await s.approve(batch.id,true)
    tasks.slice(1).forEach((task,i)=>Object.assign(task.runs[0],{status:'completed',remoteRunDir:`/runs/${i}`,logPath:`/runs/${i}/stdout.log`}))
    await s.refresh(batch.id)
    sshExec.mockImplementation(async(_client,command:string)=>{
      if(command.includes('__LABDECK_EXIT__'))return '__LABDECK_EXIT__0'
      if(!command.includes('__LABDECK_RESULT_FILES__'))return 'loss=0.2'
      const root=command.includes('/runs/0')?'/runs/0':'/runs/1'
      return '__LABDECK_RESULT_FILES__'+JSON.stringify([{path:root+'/result.txt',resolvedPath:root+'/result.txt',status:'available',kind:'file',content:Buffer.from('final recall=0.6').toString('base64')}])
    })
    const config={metricsFile:'',artifacts:[],resultFiles:['{runDir}/result.txt']}
    const files=await s.recollect(batch.id,config)
    expect(files.observations[0].files?.[0].text).toContain('recall=0.6')
    expect((await service().list())[0].resultConfig).toEqual(config)
    const consoleResult=await s.recollect(batch.id,{metricsFile:'',artifacts:[],resultFiles:[]})
    expect(consoleResult.observations[0].files).toEqual([]);expect(consoleResult.observations[0].metrics.loss).toBe(0.2)
    expect(start).toHaveBeenCalledTimes(2);expect(save).toHaveBeenCalledTimes(2);expect(requestModel).not.toHaveBeenCalled()
  })
  it('rejects post-run source changes before completion or with invalid configuration',async()=>{
    const s=service(),batch=await create(s)
    await expect(s.recollect(batch.id,{metricsFile:'',artifacts:[],resultFiles:['log.txt']})).rejects.toThrow('运行结束')
    await s.approve(batch.id,true)
    tasks.slice(1).forEach(task=>{task.runs[0].status='completed'})
    await s.refresh(batch.id);sshExec.mockClear()
    await expect(s.recollect(batch.id,{metricsFile:'',artifacts:[],resultFiles:['same.txt','same.txt']})).rejects.toThrow('重复')
    expect(sshExec).not.toHaveBeenCalled();expect(requestModel).not.toHaveBeenCalled()
  })
  it('rejects technical result reports instead of showing exit codes or internal fields',async()=>{
    const s=service(),batch=await create(s)
    await s.approve(batch.id,true);tasks.slice(1).forEach(task=>{task.runs[0].status='completed'})
    const ready=await s.refresh(batch.id)
    requestModel.mockResolvedValue({summary:'exitCode=0，evidenceState=partial',observations:['进程状态为 completed'],limitations:[],evidenceIds:ready.observations.map(o=>o.evidenceId)})
    const result=await s.analyze(batch.id)
    expect(result.analysis?.contentVersion).toBe(2);expect(result.analysis?.engine).toBe('rules')
    expect(JSON.stringify({summary:result.analysis?.summary,observations:result.analysis?.observations,limitations:result.analysis?.limitations})).not.toMatch(/exitCode|evidenceState|进程状态/)
  })
  it('captures each completed run immediately, restores snapshots, and does not reread them at batch completion',async()=>{
    const s=service(),batch=await create(s);await s.approve(batch.id,true)
    tasks.slice(1).forEach((task,i)=>Object.assign(task.runs[0],{remoteRunDir:`/runs/${i}`,logPath:`/runs/${i}/stdout.log`}))
    let overwrite=false
    sshExec.mockImplementation(async(_client,command:string)=>command.includes('__LABDECK_EXIT__')?'__LABDECK_EXIT__0':command.includes('/runs/0/')?(overwrite?'loss=99':'loss=0.1'):'loss=0.2')
    tasks[1].runs[0].status='completed'
    const partial=await s.refresh(batch.id)
    expect(partial.stage).toBe('waiting');expect(partial.observations).toHaveLength(1);expect(partial.observations[0].excerpt).toBe('loss=0.1')
    overwrite=true
    const reopened=service()
    expect((await reopened.list())[0].observations[0].excerpt).toBe('loss=0.1')
    tasks[2].runs[0].status='completed'
    const completed=await reopened.refresh(batch.id)
    expect(completed.stage).toBe('analysis');expect(completed.observations.map(o=>o.excerpt)).toEqual(['loss=0.1','loss=0.2'])
    expect(sshExec.mock.calls.filter(call=>call[1].includes('tail -n')&&call[1].includes('/runs/0/'))).toHaveLength(1)
    expect(requestModel).not.toHaveBeenCalled();expect(start).toHaveBeenCalledTimes(2)
    const reread=await reopened.recollect(batch.id)
    expect(reread.observations[0].excerpt).toBe('loss=99')
  })
  it('shows verified output directories before submission and preserves them for each queued run',async()=>{
    const s=service(),batch=await create(s)
    expect(batch.outputIsolation?.status).toBe('verified')
    expect(new Set(batch.members.map(m=>m.outputDirectory)).size).toBe(2)
    expect(save).not.toHaveBeenCalled()
    await s.approve(batch.id,true)
    expect(tasks[1].artifactPath).toBe(batch.members[0].outputDirectory)
    expect(tasks[2].launchCommand).toBe(batch.members[1].command)
    expect((await service().list())[0].members[0].outputDirectory).toBe(batch.members[0].outputDirectory)
  })
  it('does not submit when an output argument cannot be verified in project code',async()=>{
    const implementation=vi.mocked(openRepositoryReadSession).getMockImplementation()!
    vi.mocked(openRepositoryReadSession).mockImplementation(async(...args)=>{const session=await implementation(...args);session.read=async path=>{const excerpt={path,text:'print("training")',startLine:1,truncated:false};session.snapshot.excerpts.push(excerpt);return excerpt};return session})
    const s=service(),batch=await create(s)
    expect(batch.outputIsolation?.status).toBe('unverified')
    await expect(s.approve(batch.id,true)).rejects.toThrow('独立输出目录')
    expect(save).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled()
  })
  it('deletes the entire batch including recovered children but preserves its source and remote files',async()=>{
    const s=service(),batch=await create(s);await s.approve(batch.id,true)
    const unrelated={...structuredClone(source),id:randomUUID()};tasks.push(unrelated)
    // A missing child is harmless; a partial-submission marker still identifies its replacement.
    tasks[1].id=randomUUID()
    const bulk=vi.fn(async(ids:string[])=>{tasks=tasks.filter(task=>!ids.includes(task.id))})
    Object.assign(store,{deleteExperimentTasks:bulk});sshExec.mockClear()
    await s.removeBatch(batch.id)
    expect(bulk).toHaveBeenCalledOnce()
    expect(tasks.map(task=>task.id)).toEqual([source.id,unrelated.id])
    expect(await service().list()).toEqual([]);expect(sshExec).not.toHaveBeenCalled()
  })
  it('keeps the comparison record when batch task deletion is blocked',async()=>{
    const s=service(),batch=await create(s);await s.approve(batch.id,true)
    const before=structuredClone(tasks)
    Object.assign(store,{deleteExperimentTasks:vi.fn(async()=>{throw new Error('请先取消运行')})})
    await expect(s.removeBatch(batch.id)).rejects.toThrow('先取消运行')
    expect(tasks).toEqual(before);expect((await service().list())[0].id).toBe(batch.id)
  })
  it('deletes a batch durably without deleting its tasks, runs or remote files',async()=>{
    const s=service(),batch=await create(s);await s.approve(batch.id,true)
    const before=structuredClone(tasks)
    sshExec.mockClear()
    await s.remove(batch.id)
    expect(await s.list()).toEqual([]);expect(await service().list()).toEqual([])
    expect(tasks).toEqual(before);expect(start).toHaveBeenCalledTimes(2);expect(sshExec).not.toHaveBeenCalled()
    const disk=JSON.parse(await readFile(join(directory,'checkpoints.json'),'utf8'))
    expect(disk.storage[batch.id]).toBeUndefined()
    await expect(s.remove(batch.id)).resolves.toBeUndefined()
  })
  it('finishes an interrupted deletion on restart instead of recovering its checkpoint',async()=>{
    const batch=await create(service())
    const index=JSON.parse(await readFile(join(directory,'campaigns.json'),'utf8'))
    index[batch.id].deleted=true
    await writeFile(join(directory,'campaigns.json'),JSON.stringify(index),'utf8')
    expect(await service().list()).toEqual([])
    expect(JSON.parse(await readFile(join(directory,'checkpoints.json'),'utf8')).storage[batch.id]).toBeUndefined()
    expect(tasks).toHaveLength(1)
  })
  it('does not delete a record while result collection is in progress',async()=>{
    const s=service(),batch=await create(s);await s.approve(batch.id,true)
    tasks.slice(1).forEach((task,i)=>Object.assign(task.runs[0],{status:'completed',logPath:`/runs/${i}/stdout.log`,remoteRunDir:`/runs/${i}`}))
    let release!:(value:string)=>void
    const waiting=new Promise<string>(resolve=>{release=resolve})
    sshExec.mockImplementationOnce(()=>waiting)
    const refreshing=s.refresh(batch.id)
    try{
      await vi.waitFor(()=>expect(sshExec).toHaveBeenCalled())
      await expect(s.remove(batch.id)).rejects.toThrow('正在处理')
    }finally{release('loss=0.1');await refreshing}
    expect((await s.list())[0].id).toBe(batch.id)
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
    await s.refresh(initial.id);expect(requestModel).not.toHaveBeenCalled()
    const result=await s.analyze(initial.id)
    expect(result.analysis?.engine).toBe('rules');expect(result.analysis?.summary).toBe('本次 AI 结果分析未完成，请重新分析。');expect(result.observations.every(o=>o.exitCode===undefined&&!!o.warning)).toBe(true)
  })
  it('reads project evidence, includes a baseline and creates no tasks during design',async()=>{
    requestModel.mockResolvedValue({axes:[{flag:'--lr',values:['0.001']}],assumptions:[],hypothesis:'降低学习率可能更稳定',rationale:'保持 batch 等配置一致'})
    const result=await service().suggest(source.id,'比较学习率',3)
    expect(result.axes[0].values).toEqual(['0.01','0.001']);expect(result.readFiles).toContain('train.py')
    expect(requestModel.mock.calls[0][1].files[0].text).toContain('add_argument');expect(result.variable?.source.path).toBe('train.py')
    const session=await vi.mocked(openRepositoryReadSession).mock.results[0].value
    expect(session.close).toHaveBeenCalledOnce();expect(start).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled()
  })
  it('closes project sessions on model errors and does not fall back to ungrounded suggestions',async()=>{
    await expect(service().suggest(source.id,'比较学习率',3)).rejects.toThrow('模型离线')
    const session=await vi.mocked(openRepositoryReadSession).mock.results[0].value
    expect(session.close).toHaveBeenCalledOnce();expect(start).not.toHaveBeenCalled()
  })
  it('rejects a changed baseline before creating a batch',async()=>{
    await expect(service().create({taskId:source.id,objective:'比较学习率',axes:[{flag:'--lr',values:['0.01','0.001']}],maxRuns:2,useModel:false,expectedBaselineCommand:'python train.py --lr 9'})).rejects.toThrow('基准命令已变化')
    expect(save).not.toHaveBeenCalled()
  })
  it('keeps the design rationale across restart and labels the baseline run',async()=>{
    requestModel.mockResolvedValue({axes:[{flag:'--lr',values:['0.001']}],assumptions:[],hypothesis:'比较学习率',rationale:'其余参数保持一致'})
    const s=service(),design=await s.suggest(source.id,'比较学习率',2)
    const batch=await s.create({taskId:source.id,objective:'比较学习率',axes:design.axes,maxRuns:2,useModel:false,design})
    expect((await service().list())[0].design?.rationale).toBe(design.rationale)
    await s.approve(batch.id,true)
    expect(tasks[1].title).toContain('基线');expect(tasks[1].launchCommand).toContain('--lr 0.01')
    expect(tasks[2].title).toBe('lr=0.001')
  })
  it('returns missing information without calling a model when parameter definitions are unavailable',async()=>{
    const implementation=vi.mocked(openRepositoryReadSession).getMockImplementation()!
    vi.mocked(openRepositoryReadSession).mockImplementation(async(...args)=>{const session=await implementation(...args);session.read=async path=>{const excerpt={path,text:'print("no parameter definitions")',startLine:1,truncated:false};session.snapshot.excerpts.push(excerpt);return excerpt};return session})
    const result=await service().suggest(source.id,'比较学习率',2)
    expect(result.status).toBe('needs_info');expect(result.axes).toEqual([]);expect(requestModel).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled()
  })
  it('checks suggestion budget before exposing model-generated axes',async()=>{
    requestModel.mockResolvedValue({axes:[{flag:'--lr',values:['1','2','3']}],assumptions:[],hypothesis:'compare',rationale:'compare learning rates'})
    await expect(service().suggest(source.id,'比较学习率',2)).rejects.toThrow('预算');expect(start).not.toHaveBeenCalled()
  })
  it('collects each group from its own selection and persists overrides for result analysis',async()=>{
    const s=service(),batch=await create(s);const waiting=await s.approve(batch.id,true)
    tasks.slice(1).forEach((task,index)=>{task.status='completed';Object.assign(task.runs[0],{status:'completed',remoteRunDir:`/runs/group-${index}`,logPath:`/runs/group-${index}/stdout.log`})})
    await s.refresh(batch.id)
    sshExec.mockImplementation(async(_client,command:string)=>{
      if(command.includes('__LABDECK_RESULT_FILES__')){
        const requests=JSON.parse(command.match(/\[\{"path":.*?\}\]/)![0]) as {path:string}[]
        return '__LABDECK_RESULT_FILES__'+JSON.stringify(requests.map(({path})=>({path,resolvedPath:path,status:'available',kind:'file',sizeBytes:20,content:Buffer.from(path.endsWith('.csv')?'accuracy,0.85':'loss=0.42').toString('base64')})))
      }
      return command.includes('__LABDECK_EXIT__')?'__LABDECK_EXIT__0':'console must not replace chosen files'
    })
    const secondRun=waiting.members[1].runId!
    const config={metricsFile:'',artifacts:[],resultFiles:['log.txt'],runResultFiles:{[secondRun]:['/external/evaluation.csv']}}
    const result=await s.recollect(batch.id,config)
    expect(result.observations.map(item=>item.files?.map(file=>file.path))).toEqual([[waiting.members[0].outputDirectory+'/log.txt'],['/external/evaluation.csv']])
    expect((await service().list())[0].resultConfig).toEqual(config)
    const payload=resultAnalysisPayload(result)
    expect(payload.runs[0].results).toEqual([{name:'log.txt',text:'loss=0.42'}])
    expect(payload.runs[1].results).toEqual([{name:'evaluation.csv',text:'accuracy,0.85'}])
    expect(requestModel).not.toHaveBeenCalled();expect(start).toHaveBeenCalledTimes(2)
    sshExec.mockClear()
    await expect(s.recollect(batch.id,{...config,runResultFiles:{[randomUUID()]:['wrong.log']}})).rejects.toThrow('不属于本批运行')
    expect(sshExec).not.toHaveBeenCalled()
    await expect(s.recollect(batch.id,{...config,resultFiles:[]})).rejects.toThrow('部分对照组尚未配置')
    expect(sshExec).not.toHaveBeenCalled()
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
    const s=service(),selected=await s.create({taskId:source.id,objective:'compare',axes:[{flag:'--lr',values:['1','2']}],maxRuns:2,useModel:false,resultConfig:{metricsFile:'/shared/metrics.json',artifacts:[]}})
    expect(selected.warnings.some(w=>w.includes('可能被覆盖'))).toBe(true)
    await expect(s.recollect(selected.id)).rejects.toThrow('运行结束')
    expect(start).not.toHaveBeenCalled()
  })
})


