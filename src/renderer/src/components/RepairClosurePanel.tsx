import { Activity, CheckCircle2, RefreshCw } from 'lucide-react'
import type { DiagnosisReport } from '@shared/intelligence'
export const closureNames={waiting:'等待资源',running:'修复运行中',verifying:'正在验收',passed:'进程验收通过',failed:'修复后仍失败',attention:'待确认',paused:'跟踪已暂停'}
interface Props {report:DiagnosisReport;busy:boolean;simulated?:boolean;onOpenRun?:()=>void;onCheck:()=>void;onToggle:(enabled:boolean)=>void;onOpenDiagnosis:(id:string)=>void}
export function RepairClosurePanel({report,busy,simulated,onOpenRun,onCheck,onToggle,onOpenDiagnosis}:Props):React.JSX.Element {
 const closure=report.closure
 const status=closure?.status??'paused'
 const finished=status==='passed'||status==='failed'
 const phase=status==='waiting'?2:status==='running'?2:status==='verifying'?3:finished?4:2
 return <section className={`intel-closure ${status}`} aria-label="修复闭环">
  <header><h3><Activity size={16}/>{simulated?'模拟修复闭环':'修复闭环'}</h3><span className="intel-closure-status">{closureNames[status]}</span></header>
  <ol className="intel-closure-flow" aria-label="闭环阶段">{['诊断证据','确认修复','新运行','退出码核验','结果'].map((name,i)=><li key={name} className={i<phase?'done':i===phase?'current':''}>{i<phase?<CheckCircle2 size={13}/>:<i/>}{name}</li>)}</ol>
  <p role="status">{closure?.message??'这份历史报告未启用自动跟踪，可手动验收或继续跟踪。'}</p>
  <dl><div><dt>修复运行</dt><dd>{report.retryRunId}</dd></div>{closure?.checkedAt&&<div><dt>核验时间</dt><dd>{new Date(closure.checkedAt).toLocaleString('zh-CN')}</dd></div>}{closure?.exitCode!==undefined&&<div><dt>{simulated?'模拟退出码':'远程退出码'}</dt><dd>{closure.exitCode}</dd></div>}</dl>
  {closure?.nextCheckAt&&<p className="intel-closure-note">下次自动核验：{new Date(closure.nextCheckAt).toLocaleTimeString('zh-CN')}。最多自动核验 3 次。</p>}
  {status==='passed'&&!simulated&&<p className="intel-closure-note">本次验收证明进程正常退出；训练指标与产物仍需检查。</p>}
  <div className="intel-closure-actions">{onOpenRun&&<button className="secondary-button" onClick={onOpenRun}>打开修复运行</button>}{!simulated&&<><button className="secondary-button" disabled={busy||status==='verifying'} onClick={onCheck}><RefreshCw size={14}/>立即验收</button>{!finished&&<button className="secondary-button" disabled={busy} onClick={()=>onToggle(!closure?.enabled)}>{closure?.enabled?'暂停跟踪':'继续跟踪'}</button>}</>}{closure?.nextDiagnosisId&&<button className="primary-button" disabled={busy} onClick={()=>onOpenDiagnosis(closure.nextDiagnosisId!)}>查看新诊断</button>}</div>
  {simulated&&<p className="intel-closure-note">离线演示：由上方控制条模拟运行与验收，不读取远程退出码。退出演示后清除临时数据。</p>}
  {!finished&&!simulated&&<p className="intel-closure-note">应用运行或留在托盘时自动跟踪。暂停跟踪不会停止远程任务；重新打开应用会恢复已启用的跟踪。</p>}
 </section>
}
