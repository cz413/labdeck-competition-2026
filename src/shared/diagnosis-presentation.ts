import type { DiagnosisReport, Evidence, Finding } from './intelligence'
import { diagnoseEvidence } from './diagnosis-engine'

export const cleanDiagnosisText=(text:string):string=>text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
const isNotice=(item:Evidence):boolean=>/大家可以|新增的容量|本机器由于|仅支持与nas|万兆网卡接入/.test(cleanDiagnosisText(item.text))
const isError=(item:Evidence):boolean=>item.source==='log'&&/error|exception|traceback|failed|not found|no such|denied|out of memory|arguments.*required/i.test(cleanDiagnosisText(item.text))

/** Present one evidence-backed problem. Preserve the full report for expandable details. */
export function diagnosisPresentation(report:DiagnosisReport):{primary?:Finding;evidence:Evidence[];steps:string[];uncertainty?:string} {
  const evidence=report.evidence.map(item=>({...item,text:cleanDiagnosisText(item.text)}))
  // Re-evaluate direct log signatures so historical cached reports receive the same factual presentation.
  const direct=diagnoseEvidence(evidence).filter(item=>item.category!=='unknown')
  const candidates=report.findings.filter(item=>item.category!=='unknown')
  const rank={high:0,medium:1,low:2}
  const supported=candidates.filter(item=>item.evidenceIds.some(id=>evidence.some(value=>value.id===id&&!isNotice(value)&&isError(value))))
  const primary=direct[0]??[...supported].sort((a,b)=>rank[a.confidence]-rank[b.confidence])[0]??report.findings.find(item=>item.category==='unknown')
  const ids=new Set(primary?.evidenceIds??[])
  const cited=evidence.filter(item=>ids.has(item.id)&&!isNotice(item))
  const relevant=cited.filter(isError)
  const selected=(relevant.length?relevant:cited).slice(0,3)
  const steps=[...new Set(primary?.steps??[])].filter(step=>!(/配置模型后|检查任务退出码与完整错误日志|补充环境信息和错误附近/.test(step)&&primary?.category!=='unknown'))
  const visibleSteps=report.engine!=='rules'?steps.filter(step=>!/配置模型后/.test(step)):steps
  return {primary,evidence:selected,steps:visibleSteps.slice(0,5),uncertainty:primary?.category==='interpreter'?'尚未确认：该运行是否正确激活 Conda 环境、解释器是否存在，以及启动时的 PATH 是否正确。':undefined}
}
