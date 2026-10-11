import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { diagnosticSamples } from '../shared/diagnosis-engine'
import type { AppStore } from './store'
import type { SshService } from './ssh-service'
import type { MonitorService } from './monitor-service'
import type { CondaService } from './conda-service'
import type { ExperimentTask } from '../shared/types'
const state=vi.hoisted(()=>({directory:'',request:vi.fn()}))
vi.mock('electron',()=>({app:{getPath:()=>state.directory},dialog:{showSaveDialog:vi.fn()},ipcMain:{handle:vi.fn()},safeStorage:{isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from(`encrypted:${s}`),decryptString:(b:Buffer)=>b.toString().replace(/^encrypted:/,'')}}))
vi.mock('./model-provider',async()=>({...await vi.importActual('./model-provider'),requestModel:state.request}))
import { IntelligenceService, isAllowedTrainingCommand } from './intelligence-service'
const taskId='10000000-0000-4000-8000-000000000001'
const runId='10000000-0000-4000-8000-000000000002'
const serverId='10000000-0000-4000-8000-000000000003'
const retryRunId='10000000-0000-4000-8000-000000000004'
let task:ExperimentTask
let getServer:ReturnType<typeof vi.fn>
let startRun:ReturnType<typeof vi.fn>
let ssh: {connect:ReturnType<typeof vi.fn>;exec:ReturnType<typeof vi.fn>}
let monitor:{snapshot:ReturnType<typeof vi.fn>}
const services:IntelligenceService[]=[]
function service(){
  const result=new IntelligenceService({listExperimentTasks:()=>[structuredClone(task)],getServer,getSecrets:()=>({}),startExperimentRun:startRun} as unknown as AppStore,ssh as unknown as SshService,monitor as unknown as MonitorService,{checkEnvironment:vi.fn()} as unknown as CondaService)
  services.push(result);return result
}
beforeEach(async()=>{
  state.directory=await mkdtemp(join(tmpdir(),'labdeck-intelligence-test-'));state.request.mockReset()
  task={id:taskId,title:'训练',project:'vision',objective:'',tags:[],priority:'normal',status:'failed',serverId,accessRouteId:'direct',codePath:'/workspace/vision',dataPath:'',launchCommand:'python train.py --batch-size 32',artifactPath:'',resultSummary:'',notes:'',archived:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),runs:[{id:runId,number:1,status:'failed',serverId,accessRouteId:'direct',codePath:'/workspace/vision',launchCommand:'python train.py --batch-size 32',launchMode:'command',logPath:'/workspace/run/log.txt',resultSummary:'',notes:''}]}
  getServer=vi.fn(()=>({id:serverId,name:'gpu8',host:'192.0.2.1',port:22,username:'user',authType:'password',hostFingerprint:'SHA256:trusted',mode:'real',tags:[],group:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}))
  startRun=vi.fn(async(_id,input)=>{task.runs.push({...input,id:retryRunId,number:2,status:'queued',resultSummary:''});task.status='queued';return structuredClone(task)})
  ssh={connect:vi.fn(async()=>({client:{end:vi.fn()}})),exec:vi.fn(async(_client,command:string)=>command.includes('__LABDECK_EXIT__')?'__LABDECK_EXIT__0':diagnosticSamples.oom)}
  monitor={snapshot:vi.fn(async()=>({sampledAt:new Date().toISOString(),status:'online',processes:[],gpus:[{index:0,name:'GPU',memoryTotalMiB:24000,memoryUsedMiB:1000,utilizationPercent:1,temperatureC:40}]}))}
})
afterEach(async()=>{
  services.forEach(s=>s.stopTracking());services.length=0
  const resolved=resolve(state.directory);const parent=resolve(tmpdir())
  if(!resolved.startsWith(parent+'\\')&&!resolved.startsWith(parent+'/'))throw new Error('Unsafe temporary test path')
  await rm(resolved,{recursive:true,force:true})
})
describe('intelligent experiment lifecycle',()=>{
  it('keeps sample and pasted diagnoses separate from real runs and cannot execute them',async()=>{
    const s=service();const report=await s.diagnose({sample:'oom',useModel:false})
    expect(report.source).toBe('sample');expect(report.repair).toBeUndefined()
    expect(ssh.connect).not.toHaveBeenCalled();expect(monitor.snapshot).not.toHaveBeenCalled()
    await expect(s.retry(report.id,true)).rejects.toThrow('实际失败运行')
    const pasted=await s.diagnose({logText:diagnosticSamples.oom,useModel:false})
    expect(pasted.source).toBe('pasted');expect(pasted.repair).toBeUndefined()
  })
  it('collects real evidence, persists it, then creates one explicitly approved retry with provenance',async()=>{
    const s=service();const report=await s.diagnose({taskId,runId,useModel:false})
    expect(report.source).toBe('remote');expect(report.repair?.after).toBe('python train.py --batch-size 16')
    expect(report.evidence.some(e=>e.id==='resource')).toBe(true)
    await expect(s.retry(report.id,false)).rejects.toThrow('明确确认');expect(startRun).not.toHaveBeenCalled()
    await s.retry(report.id,true)
    expect(startRun.mock.calls[0][1]).toMatchObject({launchCommand:'python train.py --batch-size 16',gpuUuid:null,gpuIndex:null})
    expect(task.runs[0].launchCommand).toBe('python train.py --batch-size 32')
    expect(task.runs[1].notes).toContain(report.id)
    await expect(s.retry(report.id,true)).rejects.toThrow('已创建运行')
    expect(startRun).toHaveBeenCalledOnce()
    expect(await service().history()).toHaveLength(1)
    expect(await s.verify(report.id)).toMatchObject({status:'waiting',runId:retryRunId})
    task.runs[1].status='completed';task.runs[1].remoteRunDir='/workspace/remote-run'
    expect((await s.verify(report.id)).message).toContain('不代表模型质量')
  })
  it('does not treat manually completed records or missing exit files as verified success',async()=>{
    const s=service();const report=await s.diagnose({taskId,runId,useModel:false})
    await s.retry(report.id,true);task.runs[1].status='completed'
    expect(await s.verify(report.id)).toMatchObject({status:'unknown'})
    task.runs[1].remoteRunDir='/workspace/remote-run';ssh.exec.mockResolvedValue('__LABDECK_EXIT_MISSING__')
    expect(await s.verify(report.id)).toMatchObject({status:'unknown'})
  })
  it('blocks stale repairs and simultaneous duplicate retries',async()=>{
    const s=service();const report=await s.diagnose({taskId,runId,useModel:false})
    task.runs[0].launchCommand='python train.py --batch-size 64'
    await expect(s.retry(report.id,true)).rejects.toThrow('命令已变化')
    task.runs[0].launchCommand='python train.py --batch-size 32'
    const results=await Promise.allSettled([s.retry(report.id,true),s.retry(report.id,true)])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(startRun).toHaveBeenCalledOnce()
  })
  it('never trusts demo nodes or unverified SSH fingerprints as actual evidence',async()=>{
    getServer.mockReturnValueOnce({...getServer(),mode:'demo'})
    await expect(service().diagnose({taskId,useModel:false})).rejects.toThrow('演示节点')
    getServer.mockReturnValueOnce({...getServer(),hostFingerprint:undefined})
    await expect(service().diagnose({taskId,useModel:false})).rejects.toThrow('主机指纹')
    expect(ssh.connect).not.toHaveBeenCalled()
  })
  it('keeps unknown logs unknown and does not enable retries when resource checks fail',async()=>{
    ssh.exec.mockResolvedValue('Process ended without an exit code')
    monitor.snapshot.mockRejectedValue(new Error('offline'))
    const report=await service().diagnose({taskId,useModel:false})
    expect(report.findings[0].category).toBe('unknown');expect(report.repair).toBeUndefined()
    expect(report.warnings.some(w=>w.includes('未采集到'))).toBe(true)
  })
  it('rejects fabricated model evidence and explicitly falls back to rules',async()=>{
    state.request.mockResolvedValue({summary:'Guess',findings:[{category:'other',title:'invented',confidence:'high',explanation:'Guess',evidenceIds:['fabricated'],steps:[]}]})
    const s=service();await s.saveSettings({enabled:true,endpoint:'http://127.0.0.1:11434/v1',model:'test'})
    const report=await s.diagnose({sample:'oom',useModel:true})
    expect(report.engine).toBe('rules');expect(report.findings).toHaveLength(1)
    expect(report.warnings.some(w=>w.includes('证据校验'))).toBe(true)
  })
  it('accepts model findings only when evidence IDs exist',async()=>{
    state.request.mockResolvedValue({summary:'Traceback indicates OOM',findings:[{category:'oom',title:'Check batch size',confidence:'medium',explanation:'Try a smaller batch',evidenceIds:['log-5'],steps:['Check parameters']}]})
    const s=service();await s.saveSettings({enabled:true,endpoint:'http://127.0.0.1:11434/v1',model:'test'})
    const report=await s.diagnose({sample:'oom',useModel:true})
    expect(report.engine).toBe('model+rules');expect(report.findings).toHaveLength(2)
    expect(report.repair).toBeUndefined()
  })
  it('uses model-selected remote checks instead of an unconditional GPU/environment bundle',async()=>{
    const s=service();await s.saveSettings({enabled:true,endpoint:'http://127.0.0.1:11434/v1',model:'test'})
    state.request.mockResolvedValueOnce({action:'inspect',toolCalls:[{tool:'inspect_path',arguments:{path:'/workspace/vision'},reason:'确认代码目录',evidenceIds:['runtime']}]})
      .mockResolvedValueOnce({action:'final',summary:'目录检查完成',findings:[{category:'path',title:'代码目录',confidence:'medium',explanation:'检查时可访问',evidenceIds:['check-1'],steps:['核对训练配置']}]})
    ssh.exec.mockImplementation(async(_client,command:string)=>command.startsWith('p=')?'exists=yes kind=directory readable=yes':diagnosticSamples.oom)
    const report=await s.diagnose({taskId,runId,useModel:true})
    expect(report.engine).toBe('agent+rules');expect(report.investigation).toMatchObject({rounds:2,inspections:1,status:'completed'})
    expect(monitor.snapshot).not.toHaveBeenCalled();expect(ssh.exec).toHaveBeenCalledTimes(2)
    expect(report.repair).toBeDefined();expect((await service().history())[0].investigation).toEqual(report.investigation)
  })
  it('keeps both reports when two diagnoses finish concurrently',async()=>{
    const s=service();const reports=await Promise.all([s.diagnose({sample:'oom',useModel:false}),s.diagnose({sample:'path',useModel:false})])
    const persisted=await service().history();expect(persisted).toHaveLength(2);expect(persisted.map(r=>r.id).sort()).toEqual(reports.map(r=>r.id).sort())
  })
  it('does not send a request when model use is selected but model settings are disabled',async()=>{
    const report=await service().diagnose({sample:'oom',useModel:true})
    expect(report.engine).toBe('rules');expect(state.request).not.toHaveBeenCalled();expect(report.warnings.length).toBeGreaterThan(0)
  })
  it('cancels a model request and persists the partial report with progress',async()=>{
    const s=service();await s.saveSettings({enabled:true,endpoint:'http://127.0.0.1:11434/v1',model:'test'})
    const requestId='10000000-0000-4000-8000-000000000099';const progress=vi.fn()
    state.request.mockImplementation(async(_config,_key,_system,_payload,signal:AbortSignal)=>{s.cancelDiagnosis(requestId);signal.throwIfAborted()})
    const report=await s.diagnose({sample:'oom',useModel:true,requestId},progress)
    expect(report.investigation?.status).toBe('cancelled');expect(report.findings[0].category).toBe('oom')
    expect(progress.mock.calls.at(-1)?.[0].stage).toBe('cancelled');expect((await s.history())[0].id).toBe(report.id)
  })
  it('automatically follows the queued repair and persists successful remote verification across restart',async()=>{
    const s=service();const report=await s.diagnose({taskId,runId,useModel:false});await s.retry(report.id,true);await s.startTracking()
    task.runs[1].status='running';await s.checkTrackedRepairs();expect((await s.history()).find(r=>r.id===report.id)?.closure?.status).toBe('running')
    task.runs[1].status='completed';task.runs[1].remoteRunDir='/workspace/remote-run';await s.checkTrackedRepairs()
    expect((await service().history()).find(r=>r.id===report.id)?.closure).toMatchObject({enabled:false,status:'passed',exitCode:0})
    expect(startRun).toHaveBeenCalledOnce()
  })
  it('redetects failure, generates a linked diagnosis and waits for another explicit repair confirmation',async()=>{
    const s=service();const report=await s.diagnose({taskId,runId,useModel:false});await s.retry(report.id,true)
    task.runs[1].status='failed';task.runs[1].remoteRunDir='/workspace/remote-run';task.runs[1].logPath='/workspace/retry/log.txt'
    ssh.exec.mockImplementation(async(_client,command:string)=>command.includes('__LABDECK_EXIT__')?'__LABDECK_EXIT__1':diagnosticSamples.oom)
    await s.startTracking();const history=await s.history();const closure=history.find(r=>r.id===report.id)?.closure
    expect(closure).toMatchObject({status:'failed',enabled:false,exitCode:1});expect(closure?.nextDiagnosisId).toBeDefined()
    expect(history.find(r=>r.id===closure?.nextDiagnosisId)?.repair?.after).toBe('python train.py --batch-size 8')
    expect(startRun).toHaveBeenCalledOnce()
    await Promise.all([s.verify(report.id),s.verify(report.id)]);expect((await s.history()).filter(r=>r.runId===retryRunId)).toHaveLength(1)
  })
  it('restores an enabled pending workflow on application restart',async()=>{
    const s=service();const report=await s.diagnose({taskId,runId,useModel:false});await s.retry(report.id,true);s.stopTracking()
    task.runs[1].status='completed';task.runs[1].remoteRunDir='/workspace/remote-run'
    const restarted=service();await restarted.startTracking();expect((await restarted.history()).find(r=>r.id===report.id)?.closure?.status).toBe('passed')
  })
  it('recovers the run link when the process exited after queue creation but before report save',async()=>{
    const s=service();const report=await s.diagnose({taskId,runId,useModel:false})
    task.runs.push({...task.runs[0],id:retryRunId,number:2,status:'queued',notes:`[诊断:${report.id}] recovery fixture`})
    const restarted=service();await restarted.startTracking()
    expect((await restarted.history()).find(r=>r.id===report.id)).toMatchObject({retryRunId,closure:{enabled:true,status:'waiting'}})
    expect(startRun).not.toHaveBeenCalled()
  })
  it('keeps missing exit evidence pending and preserves the original run',async()=>{
    const s=service();const report=await s.diagnose({taskId,runId,useModel:false});await s.retry(report.id,true)
    task.runs[1].status='completed';task.runs[1].remoteRunDir='/workspace/remote-run';ssh.exec.mockResolvedValue('__LABDECK_EXIT_MISSING__')
    await s.startTracking();expect((await s.history()).find(r=>r.id===report.id)?.closure).toMatchObject({enabled:true,status:'attention',attempts:1})
    expect(task.runs[0].status).toBe('failed');expect(startRun).toHaveBeenCalledOnce()
  })
  it('can pause tracking while the remote run continues, and resume later',async()=>{
    const s=service();const report=await s.diagnose({taskId,runId,useModel:false});await s.retry(report.id,true)
    await s.setTracking(report.id,false);await s.startTracking();task.runs[1].status='completed';task.runs[1].remoteRunDir='/workspace/remote-run'
    await s.checkTrackedRepairs();expect((await s.history()).find(r=>r.id===report.id)?.closure?.status).toBe('paused')
    await s.setTracking(report.id,true);await vi.waitFor(async()=>expect((await s.history()).find(r=>r.id===report.id)?.closure?.status).toBe('passed'))
    expect(startRun).toHaveBeenCalledOnce()
  })
  it('honors the original model-analysis choice using the current enabled settings',async()=>{
    const s=service();await s.saveSettings({enabled:true,endpoint:'http://127.0.0.1:11434/v1',model:'test'})
    state.request.mockResolvedValue({summary:'OOM',findings:[{category:'oom',title:'model',confidence:'medium',explanation:'verify',evidenceIds:['log-5'],steps:[]}]})
    const report=await s.diagnose({taskId,runId,useModel:true});await s.retry(report.id,true)
    task.runs[1].status='failed';task.runs[1].remoteRunDir='/workspace/remote-run';task.runs[1].logPath='/workspace/retry/log.txt'
    ssh.exec.mockImplementation(async(_client,command:string)=>command.includes('__LABDECK_EXIT__')?'__LABDECK_EXIT__1':diagnosticSamples.oom)
    await s.startTracking();const next=(await s.history()).find(r=>r.runId===retryRunId)
    expect(next?.engine).toBe('model+rules');expect(state.request).toHaveBeenCalledTimes(2);expect(startRun).toHaveBeenCalledOnce()
  })
  it('retains enabled workflows even after more than one hundred newer diagnoses',async()=>{
    const s=service();const report=await s.diagnose({taskId,runId,useModel:false});await s.retry(report.id,true)
    for(let i=0;i<101;i++)await s.diagnose({sample:'path',useModel:false})
    const persisted=await service().history();expect(persisted).toHaveLength(100)
    expect(persisted.find(r=>r.id===report.id)?.closure?.enabled).toBe(true)
    expect(startRun).toHaveBeenCalledOnce()
  })
  it('keeps provider credentials encrypted and prevents silent reuse on provider change',async()=>{
    const s=service();const config=await s.saveSettings({enabled:true,endpoint:'https://example.com/v1',model:'m',apiKey:'test-private-key'})
    expect(config.hasApiKey).toBe(true);expect(config).not.toHaveProperty('apiKey')
    const file=await readFile(join(state.directory,'intelligence','model.json'),'utf8')
    expect(file).not.toContain('test-private-key')
    await expect(s.saveSettings({enabled:true,endpoint:'https://other.example/v1',model:'m'})).rejects.toThrow('更换模型地址')
  })
  it('creates a validated planned task and never launches it during model planning',async()=>{
    state.request.mockResolvedValue({title:'Train',launchCommand:'python train.py --batch-size 16',dataPath:'/datasets',minimumFreeVramGiB:20,assumptions:['Verify script flags']})
    const plan=await service().plan({intent:'train',serverId,codePath:'/workspace/vision',environmentName:'vision'})
    expect(plan.draft).toMatchObject({status:'planned',serverId,codePath:'/workspace/vision',condaEnvironment:{environmentName:'vision'}})
    expect(startRun).not.toHaveBeenCalled();expect(ssh.connect).not.toHaveBeenCalled()
    state.request.mockResolvedValue({title:'bad',launchCommand:'python -c "delete()"',dataPath:'',minimumFreeVramGiB:null,assumptions:[]})
    await expect(service().plan({intent:'train',serverId,codePath:'/workspace/vision',environmentName:''})).rejects.toThrow('支持范围')
  })
  it.each(['bash train.sh','python -c "x"','python train.py; touch /tmp/x','python train.py $(id)','python train.py | cat'])('rejects unsafe generated commands: %s',command=>expect(isAllowedTrainingCommand(command)).toBe(false))
})
