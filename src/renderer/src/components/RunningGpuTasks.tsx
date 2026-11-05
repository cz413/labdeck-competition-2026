import {useCallback,useState} from 'react'
import {Cpu,ListTodo,Server,SquareTerminal} from 'lucide-react'
import type {RunningGpuTask} from '@shared/live-gpu-tasks'
import {RemoteLogPanel} from './RemoteLogPanel'

function RunLog({row,active,onClose}:{row:RunningGpuTask;active:boolean;onClose():void}){
  const readLog=useCallback(()=>window.labApi.experiments.readRunLog(row.task.id,row.run.id),[row.task.id,row.run.id])
  return <RemoteLogPanel enabled={active} label={`${row.task.title} · 第 ${row.run.number} 次运行`} logPath={row.run.logPath??row.run.stdoutLogPath} running readLog={readLog} onClose={onClose}/>
}

export function RunningGpuTasks({rows,active}:{rows:RunningGpuTask[];active:boolean}):React.JSX.Element{
  const [logId,setLogId]=useState<string|null>(null)
  const selected=rows.find(row=>`${row.task.id}:${row.run.id}`===logId)
  const servers=new Set(rows.map(row=>row.serverId).filter(Boolean)).size
  const gpus=new Set(rows.filter(row=>row.serverId&&row.gpuIndex!=null).map(row=>`${row.serverId}:${row.gpuIndex}`)).size
  return <section className="my-tasks-page">
    <div className="my-task-summary running-gpu-summary">
      <div><ListTodo size={18}/><span>运行中任务</span><strong>{rows.length}</strong></div>
      <div><Server size={18}/><span>涉及服务器</span><strong>{servers}</strong></div>
      <div><Cpu size={18}/><span>已分配 GPU</span><strong>{gpus}</strong></div>
    </div>
    <div className="my-task-panel">
      <div className="my-task-heading"><div><h2>当前 GPU 任务</h2><p>任务开始运行后自动显示，结束后自动移除。</p></div></div>
      {rows.length?<div className="my-task-table running-gpu-table">
        <div className="my-task-table-head"><span>任务</span><span>服务器 / GPU</span><span>启动时间</span><span>操作</span></div>
        {rows.map(row=><div className="my-task-row" key={`${row.task.id}:${row.run.id}`}>
          <div className="my-task-process"><i><ListTodo size={15}/></i><span><strong>{row.task.title}</strong><small>第 {row.run.number} 次运行{row.run.runTitle?` · ${row.run.runTitle}`:''}</small></span></div>
          <span className="my-task-target"><strong>{row.server?.name??row.run.serverNameSnapshot??row.task.serverNameSnapshot??'服务器未指定'} · {row.gpuIndex!=null?`GPU ${row.gpuIndex}`:'GPU'}</strong><small>{row.run.gpuNameSnapshot??row.task.gpuNameSnapshot??'GPU 运行'}</small></span>
          <time>{row.run.startedAt?new Date(row.run.startedAt).toLocaleTimeString('zh-CN'):'—'}</time>
          <div className="my-task-log-actions"><button type="button" className="secondary-button" onClick={()=>setLogId(`${row.task.id}:${row.run.id}`)}><SquareTerminal size={13}/>实时日志</button></div>
        </div>)}
      </div>:<div className="my-task-empty"><ListTodo size={38}/><strong>当前没有运行中的 GPU 任务</strong><span>GPU 任务开始运行后会自动出现在这里。</span></div>}
    </div>
    {selected&&<RunLog key={logId} row={selected} active={active} onClose={()=>setLogId(null)}/>}
  </section>
}
