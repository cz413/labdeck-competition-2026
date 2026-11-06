import type { RunObservation } from '../shared/research'
import { evidenceState, legacyMetricValues, observationMetrics, processEvidenceState } from '../shared/research-results'

/** Called only when the run and its configured result sources are unchanged. */
export function preserveCollectedResults(current:RunObservation,previous?:RunObservation):RunObservation {
  if(!previous||previous.runId!==current.runId)return current
  let retained=false
  const retain=()=>{retained=true}
  if(!current.excerpt.trim()&&previous.excerpt.trim()&&current.warning){current.excerpt=previous.excerpt;retain()}
  if(current.exitCode===undefined&&previous.exitCode!==undefined){current.exitCode=previous.exitCode;retain()}
  const oldFiles=previous.files??[]
  if(!current.files?.length&&current.warning&&oldFiles.length){
    current.files=oldFiles.map(file=>({...structuredClone(file),message:[file.message,'本次读取失败，保留上次采集结果'].filter(Boolean).join('；')}));retain()
    current.metricDetails=structuredClone(previous.metricDetails??[])
  }else{
    current.files=current.files?.map(file=>{
      const old=oldFiles.find(item=>item.path===file.path&&item.role===file.role&&item.status==='available')
      if(file.status!=='unreadable'||!old)return file
      retain()
      if(file.role==='metrics')current.metricDetails=[...(current.metricDetails??[]).filter(metric=>metric.sourcePath!==file.path),...structuredClone(observationMetrics(previous).filter(metric=>metric.sourcePath===file.path))]
      return {...structuredClone(old),message:[file.message,'本次读取失败，保留上次采集结果'].filter(Boolean).join('；')}
    })
  }
  if(!current.metricDetails?.length&&current.excerpt===previous.excerpt&&retained){
    const logMetrics=observationMetrics(previous).filter(metric=>metric.source==='log')
    if(logMetrics.length)current.metricDetails=structuredClone(logMetrics)
  }
  if(retained){
    current.warning=[current.warning,`本次读取失败，保留上次采集结果（${previous.collectedAt??'历史采集'}）`].filter(Boolean).join('；')
    current.collectedAt=previous.collectedAt
    current.metrics=legacyMetricValues(current.metricDetails??[])
  }
  current.processState=processEvidenceState(current);current.evidenceState=evidenceState(current)
  return current
}
