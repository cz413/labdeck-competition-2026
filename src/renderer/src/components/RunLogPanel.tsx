import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, RotateCcw, X } from 'lucide-react'
import type { ExperimentRunLog } from '@shared/types'

export function RunLogPanel({taskId,runId,number,onClose}:{taskId:string;runId:string;number:number;onClose():void}):React.JSX.Element{
  const [log,setLog]=useState<ExperimentRunLog|null>(null)
  const [busy,setBusy]=useState(true),[error,setError]=useState('')
  const request=useRef(0)
  async function reload():Promise<void>{
    const id=++request.current;setBusy(true);setError('')
    try{const result=await window.labApi.experiments.readRunLog(taskId,runId);if(id===request.current)setLog(result)}
    catch(cause){if(id===request.current)setError(cause instanceof Error?cause.message:String(cause))}
    finally{if(id===request.current)setBusy(false)}
  }
  useEffect(()=>{void reload();return()=>{request.current++}},[taskId,runId])
  return <section className="experiment-log-panel" aria-label={`第 ${number} 次运行日志`}>
    <header><div><h4>运行日志</h4><span>第 {number} 次运行{log ? ` · 更新于 ${new Date(log.readAt).toLocaleTimeString('zh-CN')}` : ''}</span></div><div><button type="button" className="secondary-button" disabled={busy} onClick={()=>void reload()}>{busy?<LoaderCircle size={13} className="spin"/>:<RotateCcw size={13}/>}刷新</button><button type="button" className="icon-button" aria-label="关闭运行日志" onClick={onClose}><X size={15}/></button></div></header>
    {error&&<p role="alert" className="experiment-log-error">{error}</p>}
    {busy&&!log?<p role="status">正在读取服务器输出…</p>:log&&<><p className="experiment-log-scope">{log.truncated?'日志较大，展示末尾最多 128 KiB 的输出。':'本次运行的标准输出与错误输出。'}</p><pre tabIndex={0}>{log.text||'日志为空，程序未输出内容。'}</pre></>}
  </section>
}
