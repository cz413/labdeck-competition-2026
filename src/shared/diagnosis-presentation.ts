import type { DiagnosisReport, Evidence, Finding } from './intelligence'
import { diagnoseEvidence } from './diagnosis-engine'

export const cleanDiagnosisText=(text:string):string=>text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
const technicalStatus = /退出(?:状态)?码|exit(?:ed)?\s+(?:with\s+)?(?:status|code)|return\s*code/i
/** Keep machine status in raw logs, not in the user-facing diagnosis or action list. */
export function actionableDiagnosisText(text:string):string {
  const withoutSuffix=cleanDiagnosisText(text).replace(/(?:并且|同时|以及|并|且|和)\s*(?:(?:确认|检查|核对|查看|确保)\s*)?(?:(?:程序|进程|任务|命令)的?)?(?:退出(?:状态)?码|exit(?:ed)?\s+(?:with\s+)?(?:status|code)|return\s*code)[^，,。；;\n]*/gi,'')
  return withoutSuffix.split(/(?<=[，,。；;\n])/).filter(clause=>!technicalStatus.test(clause)).join('').replace(/^[，,；;。\s]+/,'').replace(/[，,；;]\s*([。！？!?]|$)/g,(_match,ending:string)=>ending||'。').trim()
}
const isNotice=(item:Evidence):boolean=>/大家可以|新增的容量|本机器由于|仅支持与nas|万兆网卡接入/.test(cleanDiagnosisText(item.text))
const isError=(item:Evidence):boolean=>item.source==='log'&&/error|exception|traceback|failed|not found|no such|denied|out of memory|arguments.*required/i.test(cleanDiagnosisText(item.text))

/** Present one evidence-backed problem. Preserve the full report for expandable details. */
export function diagnosisPresentation(report:DiagnosisReport):{primary?:Finding;evidence:Evidence[];steps:string[];uncertainty?:string} {
  const evidence=report.evidence.map(item=>({...item,text:cleanDiagnosisText(item.text)}))
  // Re-evaluate direct log signatures so historical cached reports receive the same factual presentation.
  const direct=diagnoseEvidence(evidence).filter(item=>item.category!=='unknown')
  const candidates=report.findings.filter(item=>item.category!=='unknown')
  const rank={high:0,medium:1,low:2}
  const supported=candidates.filter(item=>item.evidenceIds.every(id=>evidence.some(value=>value.id===id))&&item.evidenceIds.some(id=>evidence.some(value=>value.id===id&&!isNotice(value)&&isError(value))))
  // Prefer a validated model conclusion to the generic rule template, retaining rules as fallback.
  const usableModel=report.engine!=='rules'&&report.investigation?.status!=='failed'&&report.investigation?.status!=='cancelled'
  const modelFinding=usableModel?[...supported].filter(item=>item.confidence!=='low'&&(item.origin==='model'||(!item.origin&&!direct.some(rule=>rule.category===item.category&&rule.title===item.title&&rule.explanation===item.explanation)))).sort((a,b)=>rank[a.confidence]-rank[b.confidence])[0]:undefined
  const primary=modelFinding??direct[0]??[...supported].sort((a,b)=>rank[a.confidence]-rank[b.confidence])[0]??report.findings.find(item=>item.category==='unknown')
  const ids=new Set(primary?.evidenceIds??[])
  const cited=evidence.filter(item=>ids.has(item.id)&&!isNotice(item))
  const relevant=cited.filter(isError)
  const selected=(relevant.length?relevant:cited).filter(item=>!technicalStatus.test(item.text)&&!/ERROR\s+conda\.cli\.main_run:execute/i.test(item.text)).slice(0,3)
  const steps=[...new Set(primary?.steps??[])].filter(step=>!(/配置模型后|检查任务退出码与完整错误日志|补充环境信息和错误附近/.test(step)&&primary?.category!=='unknown'))
  const suggested=report.engine!=='rules'?steps.filter(step=>!/配置模型后/.test(step)):steps
  const visibleSteps=[...new Set(suggested.map(actionableDiagnosisText).filter(Boolean))]
  if(!visibleSteps.length&&primary)visibleSteps.push(...(direct[0]?.steps??['在运行记录中核对具体报错及本次配置，再决定需要修改的内容。']).map(actionableDiagnosisText).filter(Boolean))
  const visiblePrimary=primary?{...primary,title:actionableDiagnosisText(primary.title)||direct[0]?.title||'本次运行未正常完成',explanation:actionableDiagnosisText(primary.explanation)||direct[0]?.explanation||'请根据日志中的具体报错核对本次运行配置。'}:undefined
  return {primary:visiblePrimary,evidence:selected,steps:visibleSteps.slice(0,3),uncertainty:primary?.category==='interpreter'?'尚未确认：该运行是否正确激活 Conda 环境、解释器是否存在，以及启动时的 PATH 是否正确。':undefined}
}
