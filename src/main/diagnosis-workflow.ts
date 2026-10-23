import { createHash, randomUUID } from 'node:crypto'
import type { DiagnosisInput, DiagnosisProgress, DiagnosisReport, ModelSettings } from '../shared/intelligence'
import type { ExperimentRun } from '../shared/types'
import type { ModelUsage } from '../shared/model-usage'
import { sumModelUsage } from '../shared/model-usage'
import { diagnoseEvidence, proposeBatchRepair } from '../shared/diagnosis-engine'
import type { InvestigationResult } from './diagnostic-agent'

export type CollectedDiagnosis = Omit<DiagnosisReport, 'id'|'createdAt'|'engine'|'findings'>
type Progress = (stage:DiagnosisProgress['stage'],message:string,round?:number)=>void
export interface DiagnosisDependencies {
  collect(input:DiagnosisInput,signal:AbortSignal):Promise<CollectedDiagnosis>
  history():readonly DiagnosisReport[]
  model:Pick<ModelSettings,'enabled'|'model'|'endpoint'>
  analyze(report:DiagnosisReport,signal:AbortSignal,progress:Progress,onUsage:(usage:ModelUsage)=>void):Promise<InvestigationResult>
  findRun(taskId:string,runId:string):ExperimentRun
  save(report:DiagnosisReport):Promise<DiagnosisReport>
}

/** Ignore sampling timestamps, but retain evidence content and exact run identity. */
export function diagnosisCacheKey(input:DiagnosisInput,collected:CollectedDiagnosis,model:DiagnosisDependencies['model']):string {
  const evidence=collected.evidence.map(item=>{
    const timestamp=item.id==='external-log-file'?'collectedAt':item.source==='resource'||item.source==='environment'?'sampledAt':undefined
    if(!timestamp)return item
    try{
      const value=JSON.parse(item.text)
      if(!value||typeof value!=='object'||Array.isArray(value))return item
      delete value[timestamp];delete value.checkedAt
      return {...item,text:JSON.stringify(value)}
    }catch{return item}
  })
  return createHash('sha256').update(JSON.stringify({version:'diagnosis-v8-actionable-advice',source:collected.source,taskId:collected.taskId,runId:collected.runId,external:collected.externalContext,evidence,useModel:input.useModel,depth:input.depth??'inspect',model:input.useModel?model:null})).digest('hex')
}

export function reusableDiagnosis(input:DiagnosisInput,collected:CollectedDiagnosis,key:string,history:readonly DiagnosisReport[],now=Date.now()):DiagnosisReport|undefined {
  if(input.force||!['remote','external'].includes(collected.source))return
  return history.find(report=>{
    const age=now-Date.parse(report.createdAt)
    return report.cacheKey===key&&age>=0&&age<86400000&&(!input.useModel||report.engine!=='rules')&&(!report.investigation||report.investigation.status==='completed')
  })
}

/** Coordinates analysis only; persistence, SSH and model transport are injected. */
export async function runDiagnosis(input:DiagnosisInput,signal:AbortSignal,emit:Progress,deps:DiagnosisDependencies):Promise<DiagnosisReport> {
  emit('collect','正在读取日志与运行记录')
  const collected=await deps.collect(input,signal)
  const key=diagnosisCacheKey(input,collected,deps.model)
  const cached=!signal.aborted&&reusableDiagnosis(input,collected,key,deps.history())
  if(cached){
    emit('complete','日志与输入配置未变化，复用已有诊断；未再次调用模型')
    return {...structuredClone(cached),cacheHit:true,warnings:[...cached.warnings,'本次复用原分析。环境与资源信息仍是原采集时刻，需要更新时请强制重新分析。']}
  }
  // Keep original rule evidence separate from any model-requested inspections.
  const ruleFindings=diagnoseEvidence(collected.evidence).map(finding=>({...finding,origin:'rules' as const}))
  const originalOom=ruleFindings.some(finding=>finding.category==='oom')
  const report:DiagnosisReport={...structuredClone(collected),cacheKey:key,id:randomUUID(),createdAt:new Date().toISOString(),engine:'rules',useModel:input.useModel,findings:ruleFindings}
  const usage:ModelUsage[]=[]
  if(input.useModel&&!signal.aborted){
    if(!deps.model.enabled||!deps.model.model)report.warnings.push('模型未启用或未配置名称，保留规则诊断。')
    else{
      try{
        const result=await deps.analyze(report,signal,emit,call=>usage.push(call))
        report.evidence=result.evidence;report.investigation=result.investigation;report.warnings.push(...result.warnings)
        if(result.findings){
          const supported=result.findings.filter(finding=>finding.category!=='unknown'&&finding.evidenceIds.some(id=>report.evidence.some(item=>item.id===id&&item.source==='log'&&/error|exception|traceback|failed|not found|no such|denied|out of memory|arguments.*required/i.test(item.text))))
          if(supported.length){report.findings=report.findings.filter(item=>item.category!=='unknown');report.findings.push(...supported.map(finding=>({...finding,origin:'model' as const})))}
          report.summary=supported.length?result.summary:undefined
          report.engine=result.investigation.inspections?'agent+rules':'model+rules'
        }
      }catch{
        // Initialization failures (credentials/tool context) must not discard collected evidence.
        report.investigation={status:signal.aborted?'cancelled':'failed',rounds:0,inspections:0,trace:[]}
        report.warnings.push(signal.aborted?'已停止模型诊断，保留已有证据与规则结果。':'模型分析未完成，请检查模型配置或运行上下文；已保留证据与规则结果。')
      }
    }
  }
  if(signal.aborted&&!report.investigation){report.investigation={status:'cancelled',rounds:0,inspections:0,trace:[]};report.warnings.push('已停止诊断，保留已获得的证据。')}
  if(report.source==='remote'&&report.taskId&&report.runId&&!signal.aborted){
    try{
      const run=deps.findRun(report.taskId,report.runId)
      // Never turn model guesses or follow-up checks into executable repair authorization.
      if(run.status==='failed')report.repair=proposeBatchRepair(run.launchCommand??'',originalOom,run.launchMode)
    }catch{report.warnings.push('原运行记录已变化，保留诊断报告，不生成可执行修复。')}
  }
  if(usage.length)report.usage=sumModelUsage(usage)
  const saved=await deps.save(report)
  emit(signal.aborted?'cancelled':'complete',signal.aborted?'已停止，当前证据已保存':'诊断完成，证据与检查过程已保存')
  return saved
}
