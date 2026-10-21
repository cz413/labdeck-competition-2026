import { randomUUID } from 'node:crypto'
import type { DiagnosisReport, RepairClosure, Verification } from '../shared/intelligence'
import type { ExperimentRunStatus } from '../shared/types'
export const REPAIR_POLL_MS = 30_000
export const MAX_VERIFICATION_ATTEMPTS = 3
const BACKOFF_MS = [30_000, 120_000, 300_000]
interface RepairTrackerOptions {
  list: () => Promise<DiagnosisReport[]>;
  patch: (id:string, update:(closure:RepairClosure|undefined)=>RepairClosure) => Promise<DiagnosisReport>;
  status: (report:DiagnosisReport) => ExperimentRunStatus|undefined;
  verify: (id:string,requestId:string,signal:AbortSignal) => Promise<Verification>;
  cancelDiagnosis: (requestId:string) => void;
  now?: () => number;
}
export function initialClosure(enabled=true,useModelOnFailure=false):RepairClosure {
 return {enabled,useModelOnFailure,status:enabled?'waiting':'paused',message:enabled?'已启用自动跟踪，等待资源与运行前检查':'自动跟踪已暂停；远程任务按原计划继续',updatedAt:new Date().toISOString(),attempts:0}
}
export class RepairTracker {
 private timer:NodeJS.Timeout|undefined
 private stopped=true
 private sweeping=false
 private pendingWake=false
 private readonly checking=new Map<string,{controller:AbortController;requestId:string;promise:Promise<Verification>}>()
 constructor(private readonly options:RepairTrackerOptions){}
 private now():number{return this.options.now?.()??Date.now()}
 async start():Promise<void>{
  if(!this.stopped)return
  this.stopped=false
  this.timer=setInterval(()=>this.wake(),REPAIR_POLL_MS);this.timer.unref()
  await this.sweep()
 }
 stop():void{
  this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=undefined
  for(const current of this.checking.values()){current.controller.abort();this.options.cancelDiagnosis(current.requestId)}
 }
 wake():void{
  if(this.stopped)return
  if(this.sweeping){this.pendingWake=true;return}
  void this.sweep().catch(()=>{})
 }
 async sweep():Promise<void>{
  if(this.stopped||this.sweeping)return
  this.sweeping=true
  try{
   const reports=await this.options.list()
   for(const report of reports){
    if(this.stopped)break
    if(!report.retryRunId||!report.closure?.enabled)continue
    if(report.closure.attempts>=MAX_VERIFICATION_ATTEMPTS){
      await this.options.patch(report.id,current=>({...current!,enabled:false,status:'attention',message:'上次核验已到自动次数上限，当前证据仍待确认；可手动状态确认或继续跟踪',updatedAt:new Date(this.now()).toISOString(),nextCheckAt:undefined}))
      continue
    }
    if(report.closure.nextCheckAt&&Date.parse(report.closure.nextCheckAt)>this.now())continue
    try{await this.check(report.id)}catch{/* A corrupt/deleted report must not block remaining tracking. */}
   }
  }finally{
   this.sweeping=false
   if(this.pendingWake&&!this.stopped){this.pendingWake=false;queueMicrotask(()=>this.wake())}
  }
 }
 async setEnabled(id:string,enabled:boolean):Promise<DiagnosisReport>{
  const report=(await this.options.list()).find(r=>r.id===id)
  if(!report?.retryRunId||report.source!=='remote')throw new Error('只有已创建的实际修复运行可以跟踪')
  if(report.closure?.status==='passed'||report.closure?.status==='failed')return report
  const active=this.checking.get(id)
  if(active){active.controller.abort();this.options.cancelDiagnosis(active.requestId);await active.promise.catch(()=>{})}
  const next=await this.options.patch(id,previous=>({...initialClosure(enabled,previous?.useModelOnFailure??!!report.useModel),...(previous?.checkedAt?{checkedAt:previous.checkedAt}:{}),updatedAt:new Date(this.now()).toISOString()}))
  if(enabled)this.wake()
  return next
 }
 check(id:string):Promise<Verification>{
  const existing=this.checking.get(id)
  if(existing)return existing.promise
  const controller=new AbortController();const requestId=randomUUID()
  const promise=this.perform(id,requestId,controller.signal).finally(()=>this.checking.delete(id))
  this.checking.set(id,{controller,requestId,promise});return promise
 }
 private async perform(id:string,requestId:string,signal:AbortSignal):Promise<Verification>{
  const report=(await this.options.list()).find(r=>r.id===id)
  if(!report?.retryRunId)throw new Error('尚未创建修复运行')
  signal.throwIfAborted()
  const runStatus=this.options.status(report)
  const previous=report.closure??initialClosure(false)
  const enabled=previous.enabled
  const time=()=>new Date(this.now()).toISOString()
  const patch=(update:(current:RepairClosure)=>RepairClosure)=>this.options.patch(id,current=>signal.aborted?(current??previous):update(current??previous))
  if(runStatus==='queued'||runStatus==='preparing'||runStatus==='running'){
   const running=runStatus==='running';const message=running?'修复运行进行中，结束后自动核验退出码':'等待 GPU 资源与运行前检查'
   if(previous.status!==(running?'running':'waiting')||previous.message!==message)await patch(current=>({...current,status:running?'running':'waiting',message,updatedAt:time(),nextCheckAt:undefined}))
   return {status:running?'running':'waiting',message,runId:report.retryRunId}
  }
  if(!runStatus||runStatus==='cancelled'||runStatus==='paused'){
   const message=!runStatus?'修复运行记录不存在，请检查任务历史':runStatus==='cancelled'?'修复运行已取消，运行状态尚未确认':'修复运行已暂停，运行状态尚未确认'
   await patch(current=>({...current,enabled:false,status:'attention',message,updatedAt:time(),nextCheckAt:undefined}))
   return {status:'unknown',message,runId:report.retryRunId}
  }
  await patch(current=>({...current,status:'verifying',message:'运行已结束，正在核验远程退出码；失败时继续采集诊断',attempts:current.attempts+1,updatedAt:time(),nextCheckAt:undefined}))
  signal.throwIfAborted()
  let result:Verification
  try{result=await this.options.verify(id,requestId,signal)}
  catch{signal.throwIfAborted();result={status:'unknown',message:'状态确认或后续诊断未完成；连接与证据仍待确认',runId:report.retryRunId}}
  signal.throwIfAborted()
  await patch(current=>{
   const status=result.status==='completed'?'passed':result.status==='failed'?'failed':result.status==='running'?'running':result.status==='waiting'?'waiting':'attention'
   const retryUnknown=status==='attention'&&enabled&&current.attempts<MAX_VERIFICATION_ATTEMPTS
   return {...current,enabled:status==='passed'||status==='failed'?false:status==='attention'?retryUnknown:enabled,status,
    message:result.message+(retryUnknown?'；稍后自动重新核验':status==='attention'&&enabled?'；自动核验已停止，可手动重查或恢复跟踪':''),
    updatedAt:time(),checkedAt:result.checkedAt??time(),exitCode:result.exitCode,nextDiagnosisId:result.diagnosis?.id,
    nextCheckAt:retryUnknown?new Date(this.now()+BACKOFF_MS[Math.min(current.attempts-1,2)]).toISOString():undefined}
  })
  return result
 }
}
