import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppStore } from './store'
import type { SshService } from './ssh-service'
import type { MonitorService } from './monitor-service'
import type { CondaService } from './conda-service'
import type { RepositorySnapshot } from '../shared/repository-guide'
const mocks=vi.hoisted(()=>({request:vi.fn(),open:vi.fn(),read:vi.fn(),paths:vi.fn()}))
vi.mock('electron',()=>({app:{getPath:()=>''},dialog:{},ipcMain:{},safeStorage:{}}))
vi.mock('./model-provider',async()=>({...await vi.importActual('./model-provider'),requestModel:mocks.request}))
vi.mock('./repository-reader',async()=>({...await vi.importActual('./repository-reader'),openRepositoryReadSession:mocks.open,readRepository:mocks.read,checkRepositoryLocations:mocks.paths,findRepositoryDirectories:async()=>[]}))
import { IntelligenceService } from './intelligence-service'
const input={source:'remote' as const,serverId:'22222222-2222-4222-8222-222222222222',path:'/repo',filePaths:['README.md','train.py'],goal:'训练一次'}
const answer={status:'ready_for_review',summary:'训练',steps:[],launchCommand:'python train.py',launchOrigin:'documented',launchCitations:[{path:'README.md',startLine:1,endLine:1}],workingDirectory:'',environmentName:'',dataPath:'',missingInputs:[],questions:[]}
function setup(){
  const snapshot:RepositorySnapshot={input,files:input.filePaths.map(path=>({path,sizeBytes:50})),excerpts:[],warnings:[],collectedAt:new Date().toISOString()}
  const close=vi.fn(),read=vi.fn(async(path:string)=>{const excerpt={path,startLine:1,text:path==='README.md'?'python train.py':'print(1)',truncated:false};if(!snapshot.excerpts.some(e=>e.path===path))snapshot.excerpts.push(excerpt);return excerpt})
  mocks.open.mockResolvedValue({snapshot,maxChars:300000,read,close,list:()=>({files:[],directories:[]}),find:()=>[]})
  mocks.paths.mockResolvedValue([{path:'.',expected:'directory',status:'confirmed',message:'exists'},{path:'train.py',expected:'file',status:'confirmed',message:'exists'}])
  const service=new IntelligenceService({} as AppStore,{} as SshService,{} as MonitorService,{} as CondaService)
  vi.spyOn(service as unknown as {ready():Promise<void>},'ready').mockResolvedValue()
  return {service,snapshot,close}
}
beforeEach(()=>vi.clearAllMocks())
describe('repository request budget and cancellation',()=>{
  it('caps full reconnaissance plus guide generation at four requests',async()=>{
    const {service}=setup()
    mocks.request.mockImplementation(async(_settings,_key,_system,payload)=>{
      if('files' in payload&&!('readFiles' in payload))return answer
      return {action:'inspect',toolCalls:[{tool:'read_file',arguments:{path:'train.py'},reason:'entry'}]}
    })
    const guide=await service.analyzeRepository(input)
    expect(guide.launchCommand).toBe('python train.py')
    expect(mocks.request).toHaveBeenCalledTimes(4)
    expect(mocks.open.mock.calls[0][3]).toEqual(input.filePaths)
    expect(mocks.read).not.toHaveBeenCalled()
  })
  it('does not retry or reread after a truncated final response',async()=>{
    const {service,close}=setup()
    mocks.request.mockResolvedValueOnce({action:'done'}).mockRejectedValueOnce(new Error('模型输出被截断'))
    await expect(service.analyzeRepository(input)).rejects.toThrow('截断')
    expect(mocks.request).toHaveBeenCalledTimes(2);expect(mocks.read).not.toHaveBeenCalled();expect(close).toHaveBeenCalled()
  })
  it('retains read evidence and the reconnaissance failure when writing the guide',async()=>{
    const {service}=setup()
    mocks.request.mockRejectedValueOnce(new Error('inspection unavailable')).mockResolvedValueOnce(answer)
    const guide=await service.analyzeRepository(input)
    expect(guide.snapshot.excerpts.length).toBeGreaterThan(0)
    expect(guide.snapshot.warnings.join()).toContain('inspection unavailable')
    expect(mocks.request).toHaveBeenCalledTimes(2)
  })
  it('cancels the model request, closes SFTP, and never starts a fallback request',async()=>{
    const {service,close}=setup(),controller=new AbortController()
    mocks.request.mockImplementation(async(_settings,_key,_system,_payload,signal:AbortSignal)=>{controller.abort(new Error('cancelled'));signal.throwIfAborted()})
    await expect(service.analyzeRepository(input,undefined,controller.signal)).rejects.toThrow('cancelled')
    expect(mocks.request).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalled();expect(mocks.read).not.toHaveBeenCalled()
  })
})

describe('task project preparation requests',()=>{
  it('returns evidence without persisting a workflow or a task, and carries its progress id',async()=>{
    const {service}=setup(),events:unknown[]=[]
    Object.assign(service,{onRepositoryProgress:(id:string,event:unknown)=>events.push({id,event})})
    mocks.request.mockResolvedValueOnce({action:'done'}).mockResolvedValueOnce(answer)
    const id='33333333-3333-4333-8333-333333333333'
    const result=await service.prepareProject(input,id)
    expect(result.launchCommand).toBe('python train.py')
    expect(events.length).toBeGreaterThan(0)
    expect(events.every(e=>(e as {id:string}).id===id)).toBe(true)
    // The fixture store has no workflow/save methods: accidental persistence would fail this call.
  })
  it('cancels the exact request and can start a new request afterwards',async()=>{
    const {service,close}=setup(),id='33333333-3333-4333-8333-333333333333'
    let started!:()=>void
    const ready=new Promise<void>(resolve=>{started=resolve})
    mocks.request.mockImplementationOnce(async(_s,_k,_p,_i,signal:AbortSignal)=>{started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))})
    const pending=service.prepareProject(input,id)
    const failed=expect(pending).rejects.toThrow('已取消项目分析')
    await ready;service.cancelProjectPreparation(id);await failed
    expect(close).toHaveBeenCalled();expect(mocks.request).toHaveBeenCalledTimes(1)
    mocks.request.mockResolvedValueOnce({action:'done'}).mockResolvedValueOnce(answer)
    await expect(service.prepareProject(input,id)).resolves.toMatchObject({launchCommand:'python train.py'})
  })
  it('rejects duplicate request ids and aborts pending work on shutdown',async()=>{
    const {service}=setup(),id='33333333-3333-4333-8333-333333333333'
    let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve})
    mocks.request.mockImplementationOnce(async(_s,_k,_p,_i,signal:AbortSignal)=>{started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))})
    const pending=service.prepareProject(input,id),failed=expect(pending).rejects.toThrow()
    await ready;await expect(service.prepareProject(input,id)).rejects.toThrow('正在进行中')
    service.stopTracking();await failed
  })
})
