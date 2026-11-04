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
import { outputAnalysisPrompt } from './research-output-model'
let tasks:ExperimentTask[],directory:string,source:ExperimentTask
const services:ResearchService[]=[]
const serverId=randomUUID(),requestModel=vi.fn(),diagnose=vi.fn(),save=vi.fn(),start=vi.fn(),sshExec=vi.fn()
const outputModel=vi.fn(),preparationRepository=vi.fn()
let store:AppStore
function service(){
  const s=new ResearchService(store,{preparationRepository,requestResearchModel:(system:string,payload:unknown)=>system===outputAnalysisPrompt?outputModel(system,payload):requestModel(system,payload),history:async()=>[],diagnose} as unknown as IntelligenceService,{connect:async()=>({client:{end(){}}}),exec:sshExec} as unknown as SshService,()=>{},()=>{},{directory,engineDirectory:resolve('artifacts/no-cangjie')});services.push(s);return s
}
async function create(s:ResearchService,useModel=false){return s.create({taskId:source.id,objective:'比较学习率',axes:[{flag:'--lr',values:['0.001','0.0001']}],maxRuns:2,useModel})}
beforeEach(async()=>{
  vi.clearAllMocks();preparationRepository.mockReset();directory=await mkdtemp(join(tmpdir(),'labdeck-research-test-'));globals.directory=directory
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
  // A model response fixture, deliberately independent of production source inference.
  outputModel.mockImplementation(async(_system,payload)=>{
    const file=payload.files.find((file:{path:string})=>file.path==='train.py')
    if(!file?.text.includes("p.add_argument('--output_dir'"))return {status:'unverified',reason:'AI 未能确认保存位置'}
    const source={path:file.path,startLine:file.startLine,quote:file.text}
    return {status:'verified',reason:'保存参数传递到实际写入',targets:[{flag:'--output_dir',template:'{value}',kind:'directory',originalValue:'outputs',source,evidence:[source]}]}
  })
  requestModel.mockRejectedValue(new Error('模型离线'));diagnose.mockResolvedValue({id:randomUUID()})
})
afterEach(async()=>{services.forEach(s=>s.stop());services.length=0;const target=resolve(directory),parent=resolve(tmpdir());if(!target.startsWith(parent+'\\')&&!target.startsWith(parent+'/'))throw new Error('Unsafe temp path');await rm(target,{recursive:true,force:true})})
describe('persistent experiment research graph',()=>{
  function cachedProject(){
    source.preparationId=randomUUID()
    const files=[{path:'vision/train.py',startLine:1,text:"p.add_argument('--destination', default='out')\nwriter.save(args.destination)",truncated:false},{path:'rqvae/main.py',startLine:1,text:'print("sibling module")',truncated:false}]
    const snapshot={input:{source:'remote' as const,path:'/workspace',serverId,accessRouteId:'direct'},files:files.map(file=>({path:file.path,sizeBytes:file.text.length})),excerpts:files,warnings:[],collectedAt:new Date().toISOString()}
    preparationRepository.mockResolvedValue(snapshot)
    const citation={path:files[0].path,startLine:1,quote:files[0].text}
    outputModel.mockResolvedValue({status:'verified',reason:'从准备源码确认保存参数',targets:[{flag:'--destination',kind:'directory',originalValue:'out',template:'{value}',source:citation,evidence:[citation]}]})
    return snapshot
  }
  it('reuses the complete preparation snapshot across working-directory changes and still calls AI',async()=>{
    const snapshot=cachedProject(),s=service(),batch=await create(s)
    expect(preparationRepository).toHaveBeenCalledWith(source.preparationId)
    expect(openRepositoryReadSession).not.toHaveBeenCalled()
    expect(outputModel).toHaveBeenCalledTimes(2)
    expect(outputModel.mock.calls[0][1]).toMatchObject({workingDirectory:'/workspace/vision',repository:{root:'/workspace',reused:true},files:snapshot.excerpts})
    expect(batch.sourcePreparationId).toBe(source.preparationId)
    await s.recheckOutput(batch.id)
    expect(outputModel).toHaveBeenCalledTimes(4)
    expect(openRepositoryReadSession).not.toHaveBeenCalled()
  })
  it('supplements missing files at the preparation project root without rereading cached files',async()=>{
    const snapshot=cachedProject();snapshot.files.push({path:'writer.py',sizeBytes:30})
    const read=vi.fn(async(path:string)=>({path,startLine:1,text:'def save(): pass',truncated:false}))
    vi.mocked(openRepositoryReadSession).mockResolvedValueOnce({snapshot:{...snapshot,excerpts:[]},maxChars:180000,read,find:()=>[],list:()=>({directories:[],files:[]}),close:vi.fn()})
    await create(service())
    expect(vi.mocked(openRepositoryReadSession).mock.calls[0][2].path).toBe('/workspace')
    expect(read.mock.calls.map(call=>call[0])).toEqual(['writer.py'])
    expect(outputModel.mock.calls[0][1].files.map((file:{path:string})=>file.path)).toEqual(['vision/train.py','rqvae/main.py','writer.py'])
  })
  it('rejects preparation context from another server and rereads the current baseline',async()=>{
    const snapshot=cachedProject();snapshot.input.serverId=randomUUID()
    await create(service())
    expect(vi.mocked(openRepositoryReadSession).mock.calls[0][2].path).toBe(source.codePath)
    expect(outputModel.mock.calls[0][1].files.some((file:{path:string})=>file.path==='rqvae/main.py')).toBe(false)
  })
  it('retains cached sources for AI when supplementation is unavailable',async()=>{
    const snapshot=cachedProject();snapshot.files.push({path:'writer.py',sizeBytes:30})
    vi.mocked(openRepositoryReadSession).mockRejectedValueOnce(new Error('offline'))
    const batch=await create(service())
    expect(outputModel).toHaveBeenCalledTimes(2)
    expect(outputModel.mock.calls[0][1].warnings.join(' ')).toContain('未能连接服务器补读')
    expect(batch.outputIsolation?.engine).toBe('model')
  })
  it('binds every comparison run to the explicitly selected GPU and persists the choice',async()=>{
    const s=service(),batch=await create(s)
    const target={computeDevice:'gpu' as const,gpuUuid:'gpu-selected',gpuIndex:2,gpuNameSnapshot:'GPU 2',minimumFreeVramGiB:8,maximumGpuUtilizationPercent:30}
    const queued=await s.approve(batch.id,true,target)
    expect(queued.runTarget).toEqual(target)
    expect(start).toHaveBeenCalledTimes(2)
    for(const call of start.mock.calls)expect(call[1]).toMatchObject(target)
    expect((await service().list())[0].runTarget).toEqual(target)
  })
  it('starts the whole batch on CPU and synchronizes existing device arguments',async()=>{
    source.launchCommand+=' --device=cuda'
    const s=service(),batch=await create(s)
    const queued=await s.approve(batch.id,true,{computeDevice:'cpu',gpuUuid:'stale',gpuIndex:1,gpuNameSnapshot:'stale',minimumFreeVramGiB:8,maximumGpuUtilizationPercent:30})
    for(const call of start.mock.calls){
      expect(call[1]).toMatchObject({computeDevice:'cpu',gpuUuid:null,gpuIndex:null,minimumFreeVramGiB:null,maximumGpuUtilizationPercent:null})
      expect(call[1].launchCommand).toContain('--device=cpu')
    }
    expect(queued.members.every(member=>member.command.includes('--device=cpu'))).toBe(true)
    expect(source.launchCommand).toContain('--device=cuda')
  })
  it('preserves automatic GPU conditions when no particular card is chosen',async()=>{
    const s=service(),batch=await create(s)
    await s.approve(batch.id,true,{computeDevice:'gpu',gpuUuid:null,gpuIndex:null,gpuNameSnapshot:null,minimumFreeVramGiB:10,maximumGpuUtilizationPercent:50})
    for(const call of start.mock.calls)expect(call[1]).toMatchObject({gpuUuid:null,gpuIndex:null,minimumFreeVramGiB:10,maximumGpuUtilizationPercent:50})
  })
  it('resumes a partial batch with the original selected GPU and rejects changing its destination',async()=>{
    const s=service(),batch=await create(s),implementation=start.getMockImplementation()!
    const target={computeDevice:'gpu' as const,gpuUuid:'gpu-picked',gpuIndex:1,gpuNameSnapshot:'GPU',minimumFreeVramGiB:null,maximumGpuUtilizationPercent:null}
    start.mockImplementationOnce(implementation).mockRejectedValueOnce(new Error('partial failure'))
    await expect(s.approve(batch.id,true,target)).rejects.toThrow('partial failure')
    const reopened=service()
    await expect(reopened.approve(batch.id,true,{...target,gpuIndex:2})).rejects.toThrow('不能更换')
    await reopened.approve(batch.id,true)
    expect(tasks).toHaveLength(3)
    expect(tasks.slice(1).every(task=>task.runs[0].gpuIndex===1)).toBe(true)
  })
  it('does not submit invalid GPU conditions',async()=>{
    const s=service(),batch=await create(s)
    await expect(s.approve(batch.id,true,{computeDevice:'gpu',gpuUuid:null,gpuIndex:null,gpuNameSnapshot:null,minimumFreeVramGiB:-1,maximumGpuUtilizationPercent:150})).rejects.toThrow()
    expect(start).not.toHaveBeenCalled()
  })
  async function finishedBatch(s:ResearchService){
    const batch=await create(s);await s.approve(batch.id,true)
    const success=tasks.find(task=>task.id===batch.members[0]?.taskId)??tasks[1],failure=tasks[2]
    success.status='completed';success.runs[0].status='completed'
    failure.status='failed';failure.runs[0].status='failed'
    const ready=await s.refresh(batch.id)
    return {ready,success,failure}
  }
  it('retries only failed members, links the new run, clears stale results, and keeps successful evidence',async()=>{
    const s=service(),{ready,success,failure}=await finishedBatch(s)
    const oldRun=failure.runs[0].id,oldDirectory=ready.members[1].outputDirectory
    expect(ready.analysis).toBeDefined()
    const result=await s.retryFailed(ready.id,true,{computeDevice:'cpu',gpuUuid:null,gpuIndex:null,gpuNameSnapshot:null,minimumFreeVramGiB:null,maximumGpuUtilizationPercent:null})
    expect(start).toHaveBeenCalledTimes(3)
    expect(success.runs).toHaveLength(1)
    expect(failure.runs).toHaveLength(2)
    expect(result.members[1].runId).toBe(failure.runs[1].id)
    expect(result.members[1].runId).not.toBe(oldRun)
    expect(result.members[0].runId).toBe(success.runs[0].id)
    expect(result.analysis).toBeUndefined()
    expect(result.observations.map(item=>item.runId)).toEqual([success.runs[0].id])
    expect(result.members[1].outputDirectory).toBe(oldDirectory)
    expect(failure.runs[1]).toMatchObject({computeDevice:'cpu',artifactPath:result.members[1].outputDirectory})
    expect(result.pending).toEqual(['observe'])
    expect((await service().list())[0].members[1].runId).toBe(failure.runs[1].id)
    failure.runs[1].status='completed';failure.status='completed'
    const completed=await s.refresh(result.id)
    expect(completed.stage).toBe('analysis')
    expect(completed.observations.map(item=>item.runId)).not.toContain(oldRun)
    expect(completed.observations.map(item=>item.runId)).toContain(failure.runs[1].id)
  })
  it('rejects retries without confirmation, while active, or with no failed members',async()=>{
    const s=service(),batch=await create(s);await s.approve(batch.id,true)
    await expect(s.retryFailed(batch.id,false)).rejects.toThrow('确认')
    await expect(s.retryFailed(batch.id,true)).rejects.toThrow('全部结束')
    for(const task of tasks.slice(1)){task.runs[0].status='completed';task.status='completed'}
    await expect(s.retryFailed(batch.id,true)).rejects.toThrow('没有')
    expect(start).toHaveBeenCalledTimes(2)
  })
  it('recovers interrupted retry submission without duplicating an already created run',async()=>{
    const s=service(),{ready,failure}=await finishedBatch(s)
    const implementation=start.getMockImplementation()!
    start.mockImplementationOnce(async(...args)=>{await implementation(...args);throw new Error('saved before interruption')})
    await expect(s.retryFailed(ready.id,true)).rejects.toThrow('interruption')
    expect(failure.runs).toHaveLength(2)
    const reopened=service(),pending=(await reopened.list())[0]
    expect(pending.retrySubmission).toBeDefined()
    expect(pending.pending).toEqual(['retry'])
    await reopened.refresh(ready.id)
    const restored=await reopened.retryFailed(ready.id,true)
    expect(failure.runs).toHaveLength(2)
    expect(restored.retrySubmission).toBeUndefined()
    expect(restored.members[1].runId).toBe(failure.runs[1].id)
    expect(restored.error).toBeUndefined()
  })
  it('carries per-group result file selection to the replacement run and its original directory',async()=>{
    const s=service(),{ready,failure}=await finishedBatch(s),oldId=failure.runs[0].id,oldDirectory=ready.members[1].outputDirectory!
    await s.recollect(ready.id,{metricsFile:'',artifacts:[],resultFiles:['log.txt'],runResultFiles:{[oldId]:[oldDirectory+'/metrics.csv']}})
    const result=await s.retryFailed(ready.id,true)
    expect(result.resultConfig?.runResultFiles?.[oldId]).toBeUndefined()
    expect(result.resultConfig?.runResultFiles?.[failure.runs[1].id]).toEqual([result.members[1].outputDirectory+'/metrics.csv'])
  })
  it('recovers a multi-group retry after the second submission fails and keeps newer results cached correctly',async()=>{
    const s=service(),batch=await create(s);await s.approve(batch.id,true)
    for(const task of tasks.slice(1)){task.status='failed';task.runs[0].status='failed'}
    await s.refresh(batch.id)
    const implementation=start.getMockImplementation()!
    start.mockImplementationOnce(implementation).mockRejectedValueOnce(new Error('second retry failed'))
    await expect(s.retryFailed(batch.id,true)).rejects.toThrow('second retry failed')
    expect(tasks[1].runs).toHaveLength(2);expect(tasks[2].runs).toHaveLength(1)
    const reopened=service(),restored=await reopened.retryFailed(batch.id,true)
    expect(tasks[1].runs).toHaveLength(2);expect(tasks[2].runs).toHaveLength(2)
    expect(restored.members.map(member=>member.runId)).toEqual(tasks.slice(1).map(task=>task.runs[1].id))
  })
  it('uses fixes to the failed task environment but rejects changing the comparison parameter',async()=>{
    const s=service(),{ready,failure}=await finishedBatch(s)
    failure.launchCommand='python train.py --lr 0.9 --batch-size 16'
    await expect(s.retryFailed(ready.id,true)).rejects.toThrow('对比参数')
    expect(failure.runs).toHaveLength(1)
    failure.launchCommand=ready.members[1].command
    failure.condaEnvironment={manager:'conda',environmentName:'fixed-env'}
    await s.retryFailed(ready.id,true)
    expect(failure.runs[1].condaEnvironment?.environmentName).toBe('fixed-env')
  })
  it('corrects existing completed-batch output metadata without changing commands or launching runs',async()=>{
    source.launchCommand='python train.py --dataset=ml-1m --train_dir=default --lr 0.01'
    const factory=vi.mocked(openRepositoryReadSession).getMockImplementation()!
    const text="folder = args.dataset + '_' + args.train_dir\nf = open(folder + '/log.txt', 'w')"
    vi.mocked(openRepositoryReadSession).mockImplementation(async(...args)=>{const session=await factory(...args);session.read=async path=>{const excerpt={path,startLine:1,truncated:false,text};session.snapshot.excerpts.push(excerpt);return excerpt};return session})
    const citation={path:'train.py',startLine:1,quote:text}
    const answer=(template:string)=>({status:'verified',reason:'保存目录含数据集前缀',targets:[{flag:'--train_dir',kind:'directory',template,originalValue:'default',source:citation,evidence:[citation]}]})
    outputModel.mockResolvedValue(answer('{value}'))
    const s=service(),batch=await create(s);await s.approve(batch.id,true)
    for(const task of tasks.slice(1)){task.status='completed';task.runs[0].status='completed'}
    await s.refresh(batch.id)
    const commands=tasks.slice(1).map(task=>task.runs[0].launchCommand)
    outputModel.mockResolvedValue(answer('ml-1m_{value}'))
    const corrected=await s.recheckOutput(batch.id)
    expect(corrected.members[0].outputDirectory).toBe('/workspace/vision/ml-1m_labdecka_g01')
    expect(tasks.slice(1).map(task=>task.runs[0].launchCommand)).toEqual(commands)
    expect(start).toHaveBeenCalledTimes(2)
    expect(corrected.observations).toEqual([])
    expect(corrected.analysis).toBeUndefined()
    expect(corrected.pending).toEqual([])
    expect((await service().list())[0].members[0].outputDirectory).toBe(corrected.members[0].outputDirectory)
  })
  it('uses model source interpretation with nonstandard output flags and preserves source context',async()=>{
    const factory=vi.mocked(openRepositoryReadSession).getMockImplementation()!
    const text="parser.add_argument('--destination', default='results')\ncustom_writer(settings.destination)"
    vi.mocked(openRepositoryReadSession).mockImplementationOnce(async(...args)=>{const session=await factory(...args);session.read=async path=>{const excerpt={path,startLine:1,truncated:false,text};session.snapshot.excerpts.push(excerpt);return excerpt};return session})
    outputModel.mockResolvedValue({status:'verified',reason:'destination 传给结果写入模块',targets:[{flag:'--destination',kind:'directory',originalValue:'results',template:'{value}',source:{path:'train.py',startLine:1,quote:text},evidence:[{path:'train.py',startLine:1,quote:text}]}]})
    const batch=await create(service())
    expect(outputModel).toHaveBeenCalledTimes(2)
    expect(outputModel.mock.calls[0][1].files[0].text).toBe(text)
    expect(outputModel.mock.calls[0][1].files.some((file:{path:string})=>file.path==='README.md')).toBe(true)
    expect(batch.outputIsolation?.engine).toBe('model')
    expect(batch.outputIsolation?.flag).toBe('--destination')
    expect(batch.members.every(member=>member.command.includes('--destination'))).toBe(true)
  })
  it('keeps output verification blocked if the model is unavailable',async()=>{
    outputModel.mockRejectedValueOnce(new Error('offline'))
    const s=service(),batch=await create(s)
    expect(batch.outputIsolation?.status).toBe('unverified')
    expect(batch.outputIsolation?.reason).toContain('模型连接')
    await expect(s.approve(batch.id,true)).rejects.toThrow('模型连接')
    expect(start).not.toHaveBeenCalled()
  })

  it('requires AI rechecking for legacy verified review plans',async()=>{
    const s=service(),batch=await create(s)
    const graph=(s as unknown as {graph:{getState:(config:unknown)=>Promise<{values:{campaign:import('../shared/research').ResearchCampaign};next:string[]}>}}).graph
    const original=graph.getState.bind(graph)
    const spy=vi.spyOn(graph,'getState').mockImplementation(async config=>{const state=await original(config);const copy=structuredClone(state);delete copy.values.campaign.outputIsolation?.engine;return copy})
    const legacy=(await s.list())[0]
    expect(legacy.outputIsolation?.status).toBe('unverified')
    await expect(s.approve(batch.id,true)).rejects.toThrow('AI')
    expect(start).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  it('recovers a failed output update, removes stale warnings and restores approval before queueing',async()=>{
    outputModel.mockResolvedValueOnce({status:'unverified',reason:'旧保存位置引用失败'})
    const s=service(),batch=await create(s)
    const bridge=(s as unknown as {bridge:{expand:(...args:unknown[])=>Promise<unknown>}}).bridge
    vi.spyOn(bridge,'expand').mockRejectedValueOnce(new Error('simulated expansion failure'))
    await expect(s.recheckOutput(batch.id)).rejects.toThrow('expansion failure')
    expect((await s.list())[0].error).toBeTruthy()
    const restored=await s.recheckOutput(batch.id)
    expect(restored.error).toBeUndefined()
    expect(restored.pending).toEqual(['review'])
    expect(restored.warnings).not.toContain('旧保存位置引用失败')
    expect(restored.members.every(member=>member.command.includes('--output_dir'))).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    const reopened=(await service().list())[0]
    expect(reopened.pending).toEqual(['review'])
    expect(reopened.error).toBeUndefined()
    await s.approve(batch.id,true)
    expect(start).toHaveBeenCalledTimes(2)
  })
  it('rechecks a blocked draft in place and can approve it without recreating the campaign',async()=>{
    const factory=vi.mocked(openRepositoryReadSession).getMockImplementation()!
    vi.mocked(openRepositoryReadSession).mockImplementationOnce(async(...args)=>{
      const session=await factory(...args),read=session.read
      session.read=async path=>{const excerpt=await read(path);excerpt.text='print(1)';return excerpt}
      return session
    })
    const s=service(),blocked=await create(s)
    expect(blocked.outputIsolation?.status).toBe('unverified')
    await expect(s.approve(blocked.id,true)).rejects.toThrow()
    const calls=outputModel.mock.calls.length
    const checked=await s.recheckOutput(blocked.id)
    expect(outputModel).toHaveBeenCalledTimes(calls+2)
    expect(checked.id).toBe(blocked.id)
    expect(checked.outputIsolation?.status).toBe('verified')
    expect(checked.members).toHaveLength(2)
    await s.approve(checked.id,true)
    expect(start).toHaveBeenCalledTimes(2)
    expect(tasks[1].outputDirectories).toEqual(checked.members[0].outputDirectories)
    await expect(s.recheckOutput(checked.id)).rejects.toThrow('结束')
  })
  it('persists and queues every combination with multi-parameter design evidence',async()=>{
    const s=service()
    const axes=[{flag:'--lr',values:['0.01','0.001']},{flag:'--batch-size',values:['16','32']}]
    const variables=axes.map(axis=>({flag:axis.flag,baselineValue:axis.values[0],source:{path:'train.py',startLine:1,quote:'argument definition'}}))
    const initial=await s.create({taskId:source.id,objective:'比较学习率和批次大小',axes,maxRuns:4,design:{status:'ready',axes,baselineCommand:source.launchCommand,hypothesis:'比较组合结果',assumptions:[],variables}})
    expect(initial.design?.variables).toEqual(variables)
    expect(initial.members).toHaveLength(4)
    expect((await service().list())[0].design?.variables).toEqual(variables)
    await s.approve(initial.id,true)
    expect(start).toHaveBeenCalledTimes(4)
    expect(tasks.slice(1).map(task=>task.title)).toEqual(['基线','lr=0.01 · batch-size=32','lr=0.001 · batch-size=16','lr=0.001 · batch-size=32'])
  })
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
    await expect(s.approve(batch.id,true)).rejects.toThrow('保存位置')
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


