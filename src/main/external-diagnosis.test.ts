import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { AppStore } from './store'
import type { SshService } from './ssh-service'
import type { MonitorService } from './monitor-service'
import type { CondaService } from './conda-service'
import type { ExperimentTask, ServerProfile } from '../shared/types'
const state=vi.hoisted(()=>({directory:'',request:vi.fn()}))
vi.mock('electron',()=>({app:{getPath:()=>state.directory},dialog:{showSaveDialog:vi.fn()},ipcMain:{handle:vi.fn()},safeStorage:{isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from(s),decryptString:(b:Buffer)=>b.toString()}}))
vi.mock('./model-provider',async()=>({...await vi.importActual('./model-provider'),requestModel:state.request}))
import { readExternalTail, EXTERNAL_LOG_SCAN_BYTES, collectExternalLog } from './external-diagnosis'
import { IntelligenceService } from './intelligence-service'
const serverId='10000000-0000-4000-8000-000000000003'
const context={serverId,logPath:'/logs/failed.out',codePath:'/repo',launchCommand:'python train.py --batch-size 32',environmentName:'vision'}
function fakeSftp(text:string,link=false){
  const bytes=Buffer.from(text),reads:{offset:number;length:number}[]=[]
  const stats={size:bytes.length,mtime:100,isFile:()=>!link,isDirectory:()=>false,isSymbolicLink:()=>link} as Stats
  const api={
    lstat:vi.fn((_path:string,callback:(e:null,s:Stats)=>void)=>callback(null,stats)),
    realpath:vi.fn((path:string,callback:(e:null,s:string)=>void)=>callback(null,path)),
    open:vi.fn((_path:string,_flags:string,callback:(e:null,h:Buffer)=>void)=>callback(null,Buffer.from('handle'))),
    fstat:vi.fn((_handle:Buffer,callback:(e:null,s:Stats)=>void)=>callback(null,stats)),
    read:vi.fn((_handle:Buffer,buffer:Buffer,offset:number,length:number,position:number,callback:(e:null,n:number)=>void)=>{reads.push({offset:position,length});const n=bytes.copy(buffer,offset,position,position+length);callback(null,n)}),
    close:vi.fn((_handle:Buffer,callback:()=>void)=>callback())
  }
  return {api:api as unknown as SFTPWrapper,raw:api,reads}
}
let server:ServerProfile,tasks:ExperimentTask[],save:ReturnType<typeof vi.fn>,exec:ReturnType<typeof vi.fn>,connect:ReturnType<typeof vi.fn>
function dependencies(text='CUDA out of memory\n'){
  const sftp=fakeSftp(text)
  exec=vi.fn(()=>{throw new Error('No shell execution is allowed in external log collection')})
  connect=vi.fn(async()=>({client:{sftp:(callback:(e:null,s:SFTPWrapper)=>void)=>callback(null,sftp.api),end:vi.fn()},profile:server}))
  const store={getServer:()=>server,getSecrets:()=>({}),listExperimentTasks:()=>tasks,saveExperimentTask:save,startExperimentRun:vi.fn()} as unknown as AppStore
  return {sftp,store,ssh:{connect,exec} as unknown as SshService}
}
beforeEach(async()=>{
  state.directory=await mkdtemp(join(tmpdir(),'labdeck-external-'))
  state.request.mockReset();tasks=[]
  server={id:serverId,name:'GPU server',mode:'real',host:'example.invalid',port:22,username:'researcher',authType:'password',hostFingerprint:'SHA256:test'} as ServerProfile
  save=vi.fn(async draft=>{const task={...draft,id:randomUUID(),archived:false,runs:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};tasks.push(task);return task})
})
afterEach(async()=>{
  const target=resolve(state.directory),base=resolve(tmpdir())
  if(!target.startsWith(base+sep)||!basename(target).startsWith('labdeck-external-'))throw new Error('Unexpected cleanup target')
  await rm(target,{recursive:true,force:true})
})
describe('external experiment diagnosis',()=>{
  it('reads a bounded log tail and never imports or executes project code',async()=>{
    const fixture=fakeSftp('line\n'.repeat(20000)+'CUDA out of memory\n')
    const result=await readExternalTail(fixture.api,context.logPath)
    expect(result.snapshot.bytesRead).toBeLessThanOrEqual(EXTERNAL_LOG_SCAN_BYTES)
    expect(result.snapshot.truncated).toBe(true)
    expect(result.text.split('\n').length).toBeLessThanOrEqual(240)
    expect(result.text).toContain('CUDA out of memory')
    expect(fixture.reads.every(read=>read.length<=32768)).toBe(true)
  })
  it('keeps an early traceback even when the final lines are only progress',async()=>{
    const fixture=fakeSftp('Traceback (most recent call last):\nModuleNotFoundError: No module named torch\n'+'progress\n'.repeat(30000))
    const result=await readExternalTail(fixture.api,context.logPath)
    expect(result.text).toContain('ModuleNotFoundError');expect(result.snapshot.selection).toBe('errors_and_tail');expect(result.snapshot.bytesRead).toBeLessThanOrEqual(EXTERNAL_LOG_SCAN_BYTES)
  })
  it('refuses a symlink without opening it',async()=>{
    const fixture=fakeSftp('sensitive',true)
    await expect(readExternalTail(fixture.api,context.logPath)).rejects.toThrow('普通文件')
    expect(fixture.raw.open).not.toHaveBeenCalled()
  })
  it('requires a trusted server before opening a connection',async()=>{
    const {store,ssh}=dependencies();server.hostFingerprint=undefined
    await expect(collectExternalLog(store,ssh,context)).rejects.toThrow('主机指纹')
    expect(connect).not.toHaveBeenCalled()
  })
  it('creates a sourced diagnosis without fabricating a task or run',async()=>{
    const {store,ssh}=dependencies()
    const service=new IntelligenceService(store,ssh,{} as MonitorService,{} as CondaService)
    const report=await service.diagnose({external:context,useModel:false})
    expect(report.source).toBe('external');expect(report.taskId).toBeUndefined();expect(report.runId).toBeUndefined()
    expect(report.findings.some(f=>f.category==='oom')).toBe(true)
    expect(report.externalLog?.resolvedPath).toBe(context.logPath)
    expect(report.repair).toBeUndefined();expect(save).not.toHaveBeenCalled();expect(exec).not.toHaveBeenCalled();expect(state.request).not.toHaveBeenCalled()
  })
  it('saves one reviewed planned draft idempotently with no failed-run backfill',async()=>{
    const {store,ssh}=dependencies()
    const service=new IntelligenceService(store,ssh,{} as MonitorService,{} as CondaService)
    const report=await service.diagnose({external:context,useModel:false})
    const input={title:'Retry',codePath:'/repo',launchCommand:'python train.py --batch-size 16',environmentName:'vision',dataPath:''}
    const first=await service.saveExternalDraft(report.id,input),second=await service.saveExternalDraft(report.id,input)
    expect(second.id).toBe(first.id);expect(save).toHaveBeenCalledTimes(1);expect(first.status).toBe('planned');expect(first.runs).toEqual([])
    expect(first.notes).toContain(`[外部诊断:${report.id}]`)
    expect((await service.history())[0].importedTaskId).toBe(first.id)
    expect(exec).not.toHaveBeenCalled();expect(state.request).not.toHaveBeenCalled()
  })
  it('reuses identical paid analysis and only repeats when explicitly forced',async()=>{
    const {store,ssh}=dependencies();const service=new IntelligenceService(store,ssh,{} as MonitorService,{} as CondaService)
    await service.saveSettings({enabled:true,endpoint:'http://127.0.0.1:11434/v1',model:'mock'})
    state.request.mockImplementation(async(...args:unknown[])=>{const payload=args[3] as {evidence:{id:string;source:string;text:string}[]};(args[5] as ((usage:unknown)=>void)|undefined)?.({requests:1,elapsedMs:10,promptTokens:100,completionTokens:20,totalTokens:120});return {action:'final',summary:'OOM observed',findings:[{category:'oom',title:'OOM',confidence:'high',explanation:'Explicit error',evidenceIds:[payload.evidence.find(e=>e.text.includes('CUDA'))!.id],steps:['Review batch size']}]}})
    const first=await service.diagnose({external:context,useModel:true,depth:'quick'}),second=await service.diagnose({external:context,useModel:true,depth:'quick'})
    expect(second.id).toBe(first.id);expect(second.cacheHit).toBe(true);expect(state.request).toHaveBeenCalledTimes(1);expect(first.usage?.totalTokens).toBe(120)
    await service.diagnose({external:context,useModel:true,depth:'quick',force:true});expect(state.request).toHaveBeenCalledTimes(2)
  })
  it('rejects an executable combination command when importing a rerun draft',async()=>{
    const {store,ssh}=dependencies()
    const service=new IntelligenceService(store,ssh,{} as MonitorService,{} as CondaService)
    const report=await service.diagnose({external:context,useModel:false})
    await expect(service.saveExternalDraft(report.id,{title:'bad',codePath:'/repo',launchCommand:'python train.py; rm -rf /repo',environmentName:'',dataPath:''})).rejects.toThrow()
    expect(save).not.toHaveBeenCalled();expect(exec).not.toHaveBeenCalled()
  })
})
