import { FolderOpen, Search } from 'lucide-react'
import type { ExperimentTask } from '@shared/types'
import type { DiagnosisReport } from '@shared/intelligence'
import { reportForRun } from '@shared/experiment-workflow'
interface Props {
  tasks:ExperimentTask[];reports:DiagnosisReport[];demoTaskId?:string;historyReady:boolean
  onStart():void;onExisting():void;onExternal():void;onPaste():void
  onFailure(task:ExperimentTask,runId:string):void;onReport(id:string):void
  onTask(task:ExperimentTask,runId?:string):void
}
const sources={remote:'任务池运行',external:'服务器手动实验',pasted:'粘贴日志',sample:'示例'}
export function IntelligenceOverview(props:Props):React.JSX.Element {
  const failures=props.tasks.filter(task=>!task.archived&&task.id!==props.demoTaskId).flatMap(task=>task.runs.filter(run=>run.status==='failed').map(run=>({task,run})))
    .sort((a,b)=>(b.run.finishedAt??b.run.startedAt??b.task.updatedAt).localeCompare(a.run.finishedAt??a.run.startedAt??a.task.updatedAt)).slice(0,5)
  const recent=props.reports.filter(r=>r.source!=='sample').slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,5)
  return <section className="intelligence-overview" aria-label="智能实验起点">
    <div className="intelligence-entry-grid">
      <article><FolderOpen size={22}/><h2>启动新实验</h2><p>选择服务器上的仓库，描述本次目标。整理最小启动方式、待补信息与准备事项，审查后送入任务池。</p><button className="primary-button" onClick={props.onStart}>分析仓库启动方式</button></article>
      <article><Search size={22}/><h2>诊断已有实验</h2><p>实验已经运行过，无论是否经过任务池，都可以从失败运行或现有日志接手，无需重新启动一次。</p><div><button className="primary-button" onClick={props.onExisting}>选择任务池运行</button><button className="secondary-button" onClick={props.onExternal}>指定服务器日志</button><button className="wb-text-button" onClick={props.onPaste}>粘贴错误日志</button></div></article>
    </div>
    <div className="intelligence-recent-grid"><section><h2>最近失败运行</h2>{!failures.length?<p>目前没有任务池失败记录。手动运行的实验可通过“指定服务器日志”诊断。</p>:failures.map(({task,run})=>{
      const report=reportForRun(props.reports,task.id,run.id)
      return <article className="intelligence-recent-item" key={run.id}><div><strong>{task.title}</strong><span>第 {run.number} 次运行 · {task.runs.at(-1)?.id===run.id?'最近一次运行失败':'历史失败运行'}</span>{run.message&&<p>{run.message}</p>}</div><div>{report&&<button className="secondary-button" onClick={()=>props.onReport(report.id)}>查看诊断</button>}<button className="secondary-button" onClick={()=>props.onFailure(task,run.id)}>{report?'重新诊断这次运行':'诊断这次运行'}</button><button className="wb-text-button" onClick={()=>props.onTask(task,run.id)}>打开任务</button></div></article>
    })}</section><section><h2>最近诊断</h2>{!props.historyReady?<p>正在读取诊断记录…</p>:!recent.length?<p>分析后会保留报告，可以从这里继续处理。</p>:recent.map(report=><article className="intelligence-recent-item" key={report.id}><div><strong>{report.title}</strong><span>{sources[report.source]} · {new Date(report.createdAt).toLocaleString('zh-CN')}</span><p>{report.summary??report.findings[0]?.title??'查看已有证据'}</p></div><button className="secondary-button" onClick={()=>props.onReport(report.id)}>继续查看</button></article>)}</section></div>
  </section>
}
