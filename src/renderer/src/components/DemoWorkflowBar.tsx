import type { DemoWorkflow } from '@shared/demo-workflow'
interface Props {
  demo: DemoWorkflow; onReset(): void; onExit(): void; onTask(): void; onDiagnose(): void;
  onInitialFailure(): void; onStart(): void; onFinish(success: boolean): void; onReport(id: string): void
}
export function DemoWorkflowBar(props: Props): React.JSX.Element {
  const {demo} = props, run = demo.task.runs.at(-1)
  const current = demo.reports.find(r => r.runId === run?.id)
  const origin = demo.reports.find(r => r.retryRunId === run?.id)
  const message = !run ? '预设计划已载入。先在任务栏检查配置，再模拟首次显存不足。'
    : run.status === 'queued' ? '修复已确认，模拟排队中。下一步模拟开始运行。'
    : run.status === 'running' ? '模拟修复运行中。可以选择成功或再次失败，展示两条状态确认路径。'
    : run.status === 'completed' ? '模拟进程正常退出。返回任务栏核对原运行与修复运行。'
    : current ? '错误日志已诊断。打开报告，审查参数变化并确认模拟修复。'
    : '首轮模拟运行失败。前往任务栏，从指定运行记录进入诊断。'
  const phase = !run ? 0 : run.number === 1 && !current ? 1 : run.status === 'queued' ? 3 : run.status === 'running' ? 4 : run.number > 1 ? 5 : 2
  return <section className="workflow-demo" aria-label="离线演示控制台">
    <header><div><strong>离线演示 · 模拟数据</strong><span>演示操作不连接服务器、不调用模型；数据仅留在本次窗口中。</span></div><div><button className="wb-text-button" onClick={props.onReset}>重置演示</button><button className="wb-text-button" onClick={props.onExit}>退出演示</button></div></header>
    <ol aria-label="演示步骤">{['预设计划','首次失败','诊断证据','确认修复','新运行','结果状态确认'].map((name,i)=><li key={name} className={i===phase?'current':i<phase?'done':''}>{name}</li>)}</ol>
    <p role="status">{message}</p>
    <div className="workflow-demo-actions"><button className="secondary-button" onClick={props.onTask}>查看演示任务</button>
      {!run&&<button className="primary-button" onClick={props.onInitialFailure}>模拟首次显存不足</button>}
      {run?.status==='failed'&&!current&&<button className="primary-button" onClick={props.onDiagnose}>去诊断此运行</button>}
      {current&&<button className="primary-button" onClick={()=>props.onReport(current.id)}>打开模拟诊断</button>}
      {run?.status==='queued'&&<button className="primary-button" onClick={props.onStart}>模拟修复开始</button>}
      {run?.status==='running'&&<><button className="primary-button" onClick={()=>props.onFinish(true)}>模拟正常退出</button><button className="secondary-button" onClick={()=>props.onFinish(false)}>模拟再次失败</button></>}
      {origin&&<button className="secondary-button" onClick={()=>props.onReport(origin.id)}>查看模拟状态确认</button>}
    </div>
  </section>
}
