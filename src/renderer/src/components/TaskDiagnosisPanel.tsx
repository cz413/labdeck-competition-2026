import { cleanDiagnosisText, diagnosisPresentation } from '@shared/diagnosis-presentation'
import { useEffect, useRef, useState } from 'react'
import type { DiagnosisReport } from '@shared/intelligence'
import type { ExperimentTask } from '@shared/types'
import type { ConfirmationRequest } from './ConfirmDialog'
import { RepairClosurePanel } from './RepairClosurePanel'
import './task-diagnosis.css'

interface Props {
  task:ExperimentTask;runId:string;reportId?:string
  onChanged(task:ExperimentTask):void
  onEdit():void
  onOpenRun(runId:string):void
  onClose():void
  confirm(request:ConfirmationRequest):Promise<boolean>
}

/** Task-scoped interaction: the caller supplies the run; users never select a source or engine. */
export function TaskDiagnosisPanel(props:Props):React.JSX.Element {
  const [report,setReport]=useState<DiagnosisReport|null>(null)
  const [busy,setBusy]=useState('loading')
  const [message,setMessage]=useState('正在读取诊断记录…')
  const [error,setError]=useState('')
  const mounted=useRef(false),request=useRef<string|null>(null)
  const currentReport=useRef<DiagnosisReport|null>(null)
  const run=props.task.runs.find(item=>item.id===(report?.runId??props.runId))
  function show(value:DiagnosisReport):void{currentReport.current=value;setReport(value)}

  async function analyze(refresh=false,inspect=false):Promise<void>{
    if(request.current)return
    const requestId=crypto.randomUUID();request.current=requestId
    setBusy('analysis');setError('');setMessage('正在分析本次运行，请稍候…')
    try{
      const result=await window.labApi.intelligence.diagnoseTask({taskId:props.task.id,runId:currentReport.current?.runId??props.runId,requestId,refresh,inspect})
      if(mounted.current&&request.current===requestId)show(result)
    }catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:String(cause))}
    finally{if(request.current===requestId){request.current=null;if(mounted.current)setBusy('')}}
  }

  useEffect(()=>{
    mounted.current=true
    let live=true
    const reload=async()=>{
      const history=await window.labApi.intelligence.history()
      if(!live)return
      const id=currentReport.current?.id
      const updated=history.find(item=>item.id===id)
      if(updated)show({...updated,...(currentReport.current?.cacheHit?{cacheHit:true}:{})})
    }
    const historyChanged=window.labApi.intelligence.onHistoryChanged(()=>{void reload().catch(()=>{})})
    void window.labApi.intelligence.history().then(history=>{
      if(!live)return
      const existing=props.reportId?history.find(item=>item.id===props.reportId&&item.taskId===props.task.id):history.filter(item=>item.taskId===props.task.id&&item.runId===props.runId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]
      if(existing){show(existing);setBusy('')}
      else void analyze()
    }).catch(()=>{if(live)void analyze()})
    return()=>{live=false;mounted.current=false;historyChanged();if(request.current)void window.labApi.intelligence.cancelDiagnosis(request.current).catch(()=>{})}
  },[])

  async function operate(name:string,action:()=>Promise<void>):Promise<void>{
    if(busy)return
    setBusy(name);setError('')
    try{await action()}catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:String(cause))}
    finally{if(mounted.current)setBusy('')}
  }
  async function refreshReport():Promise<void>{
    const history=await window.labApi.intelligence.history()
    const updated=history.find(item=>item.id===currentReport.current?.id)
    if(updated&&mounted.current)show(updated)
  }
  async function repair():Promise<void>{
    if(!report?.repair||busy)return
    const approved=await props.confirm({title:'确认修改并重新运行',message:'在原服务器创建新运行并跟踪结果，原运行记录保留。',details:`原命令：${report.repair.before}\n新命令：${report.repair.after}`,confirmLabel:'确认重新运行'})
    if(!approved||!mounted.current)return
    await operate('repair',async()=>{
      const task=await window.labApi.intelligence.retry(report.id,true,false)
      props.onChanged(task);await refreshReport()
    })
  }
  const presentation=report?diagnosisPresentation(report):undefined
  const strongest=presentation?.primary
  const steps=presentation?.steps??[]
  const cited=presentation?.evidence??[]
  const cancelled=report?.investigation?.status==='cancelled'
  return <section className="task-diagnosis" aria-label="运行诊断">
    <header className="task-diagnosis-header"><div><h3>运行诊断</h3><p>第 {run?.number??'—'} 次运行 · {props.task.title}</p></div><button type="button" className="secondary-button" onClick={props.onClose}>收起</button></header>
    {error&&<p className="task-diagnosis-error" role="alert">{error}</p>}
    {busy==='loading'||busy==='analysis'?<div className="task-diagnosis-progress" role="status"><span>{message}</span>{busy==='analysis'&&<button type="button" className="secondary-button" onClick={()=>{if(request.current){setMessage('正在停止，保留已读取的证据…');void window.labApi.intelligence.cancelDiagnosis(request.current).catch(()=>setError('未能停止，请稍后重试。'))}}}>停止分析</button>}</div>:null}
    {report&&<>
      <div className="task-diagnosis-result"><span className="task-diagnosis-label">{cancelled?'分析已停止':strongest?.confidence==='high'?'已识别的问题':'当前判断'}</span><h4>{strongest?.title??'现有证据不足，暂时无法确定原因'}</h4><p>{strongest?.explanation||'请查看运行日志，补充错误上下文后重新分析。'}</p>{presentation?.uncertainty&&<p className="task-diagnosis-uncertainty">{presentation.uncertainty}</p>}</div>
      {cited.length>0&&<section className="task-diagnosis-evidence"><h4>判断依据</h4>{cited.slice(0,3).map(item=><blockquote key={item.id}><span>{item.label}</span><pre>{item.text}</pre></blockquote>)}</section>}
      {steps.length>0&&<section><h4>建议下一步</h4><ol>{steps.slice(0,5).map(step=><li key={step}>{step}</li>)}</ol></section>}
      {report.repair&&!report.retryRunId&&<section className="task-diagnosis-repair"><h4>可确认的修改方案</h4><div><span>原命令</span><pre>{report.repair.before}</pre><span>修改后</span><pre>{report.repair.after}</pre></div><button type="button" className="primary-button" disabled={!!busy} onClick={()=>void repair()}>确认修改并重新运行</button></section>}
      {report.retryRunId&&<RepairClosurePanel report={report} busy={!!busy} onOpenRun={()=>props.onOpenRun(report.retryRunId!)} onCheck={()=>void operate('verify',async()=>{await window.labApi.intelligence.verify(report.id);await refreshReport()})} onToggle={enabled=>void operate('tracking',async()=>{await window.labApi.intelligence.setTracking(report.id,enabled);await refreshReport()})} onOpenDiagnosis={id=>void operate('history',async()=>{const found=(await window.labApi.intelligence.history()).find(item=>item.id===id&&item.taskId===props.task.id);if(found)show(found);else throw new Error('未找到后续诊断记录')})}/>}
      <details className="task-diagnosis-details"><summary>错误日志片段</summary>
        <pre>{cleanDiagnosisText(report.logExcerpt)||'未读取到日志'}</pre>
      </details>
    </>}
    {!busy&&<footer className="task-diagnosis-actions"><button type="button" className="secondary-button" onClick={props.onEdit}>编辑配置</button><button type="button" className="secondary-button" onClick={()=>void analyze(true)}>{report?'重新分析':'重试分析'}</button>{report&&!strongest?.confidence.startsWith('high')&&report.investigation?.inspections===0&&report.engine!=='rules'&&<button type="button" className="secondary-button" onClick={()=>void analyze(true,true)}>进一步检查</button>}</footer>}
  </section>
}
