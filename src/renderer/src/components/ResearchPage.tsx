import { useEffect, useState } from 'react'
import { ArrowRight, FileDown, FlaskConical, LoaderCircle, Pause, Play, RefreshCw } from 'lucide-react'
import type { ExperimentTask, ServerProfile } from '@shared/types'
import type { ParameterAxis, ResearchView } from '@shared/research'
import type { ConfirmationRequest } from './ConfirmDialog'
import './research.css'
import { ResearchResults } from './ResearchResults'
import { createResearchDemo, finishResearchDemo, queueResearchDemo, researchDemoAxes, researchDemoCommand } from '@shared/research-demo'
interface Props {tasks:ExperimentTask[];servers:ServerProfile[];modelEnabled:boolean;initialTaskId?:string;onChanged:(task:ExperimentTask)=>void;onOpenTask:(task:ExperimentTask,runId?:string)=>void;onOpenDiagnosis:(id:string)=>void;confirm:(request:ConfirmationRequest)=>Promise<boolean>;notify:(message:string,kind?:'success'|'error')=>void}
const stageNames={review:'待审查',waiting:'等待本批运行结束',analysis:'已完成结果分析'}
const runNames:Record<string,string>={planned:'草稿',queued:'排队中',preparing:'准备中',running:'运行中',paused:'运行暂停',completed:'正常结束',failed:'运行故障',cancelled:'已取消'}
const nodes=[['expand','配置展开'],['review','人工确认'],['queue','任务入队'],['observe','运行跟踪'],['collect','证据采集'],['analyze','结果分析']]
export function ResearchPage(props:Props):React.JSX.Element {
  const eligible=props.tasks.filter(t=>t.launchMode!=='script'&&props.servers.some(s=>s.id===t.serverId&&s.mode==='real'))
  const [taskId,setTaskId]=useState(props.initialTaskId||eligible[0]?.id||'')
  const [objective,setObjective]=useState('比较学习率对训练稳定性的影响，保留其他配置。')
  const [rows,setRows]=useState([{flag:'--lr',values:'0.001, 0.0003, 0.0001'},{flag:'--seed',values:'42, 43'}])
  const [maxRuns,setMaxRuns]=useState(9),[useModel,setUseModel]=useState(false)
  const [history,setHistory]=useState<ResearchView[]>([]),[selectedId,setSelectedId]=useState('')
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[assumptions,setAssumptions]=useState<string[]>([])
  const [engine,setEngine]=useState<{available:boolean;message:string}>({available:false,message:'正在检查参数引擎…'})
  const [ready,setReady]=useState(false)
  const [metricsFile,setMetricsFile]=useState(''),[artifactFiles,setArtifactFiles]=useState('')
  const [demo,setDemo]=useState<ResearchView|null>(null)
  const selected=demo?.id===selectedId?demo:history.find(c=>c.id===selectedId),task=props.tasks.find(t=>t.id===taskId)
  const simulated=!!demo&&selected?.id===demo.id
  const axes:ParameterAxis[]=rows.filter(r=>r.flag.trim()).map(r=>({flag:r.flag.trim(),values:r.values.split(/[,，\n]/).map(v=>v.trim()).filter(Boolean)}))
  const resultConfig={metricsFile:metricsFile.trim(),artifacts:artifactFiles.split(/\r?\n/).map(path=>path.trim()).filter(Boolean)}
  const count=axes.reduce((n,a)=>n*new Set(a.values).size,axes.length?1:0)
  useEffect(()=>{if(props.initialTaskId&&eligible.some(t=>t.id===props.initialTaskId))setTaskId(props.initialTaskId)},[props.initialTaskId])
  useEffect(()=>{
    let live=true,revision=0
    const refresh=():void=>{const request=++revision;void window.labApi.research.list().then(items=>{if(live&&request===revision){setHistory(items);setSelectedId(id=>id||items[0]?.id||'');setReady(true)}}).catch(e=>{if(live){setError(e.message??String(e));setReady(true)}})}
    refresh();void window.labApi.research.engine().then(result=>{if(live)setEngine(result)}).catch(e=>{if(live)setError(e.message??String(e))})
    const unsubscribe=window.labApi.research.onChanged(refresh)
    return()=>{live=false;unsubscribe()}
  },[])
  async function action(name:string,fn:()=>Promise<void>):Promise<void>{if(busy)return;setBusy(name);setError('');try{await fn();setHistory(await window.labApi.research.list())}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy('')}}
  async function reloadTasks():Promise<void>{for(const item of await window.labApi.experiments.list())props.onChanged(item)}
  async function approve():Promise<void>{
    if(!selected)return
    if(simulated){const approved=await props.confirm({title:'确认模拟本批入队',message:'只改变当前窗口的模拟状态，不创建任务、不连接服务器。',confirmLabel:'确认模拟入队'});if(approved)setDemo(queueResearchDemo(selected));return}
    const accepted=await props.confirm({title:'确认本批对照实验',message:`将 ${selected.members.length} 个配置加入已有 GPU 队列。运行预算为 ${selected.maxRuns} 次。此确认仅针对当前批次，下一批和故障修复需要重新确认。`,details:`服务器：${props.servers.find(s=>s.id===selected.baseline.serverId)?.name??'原服务器'}\n代码目录：${selected.baseline.codePath}\nConda：${selected.baseline.condaEnvironment?.environmentName??selected.baseline.condaEnvironment?.environmentPrefix??'未指定'}\n数据：${selected.baseline.dataPath||'未指定'}\n产物目录：${selected.baseline.artifactPath||'由训练脚本决定'}\n指标文件：${selected.resultConfig?.metricsFile||'仅提取日志末值'}\n预期产物：${selected.resultConfig?.artifacts.join('、')||'未指定'}\n${selected.members.map((m,i)=>`${i+1}. ${m.command}`).join('\n')}`,confirmLabel:'确认本批加入队列'})
    if(accepted)await action('approve',async()=>{await window.labApi.research.approve(selected.id,true);await reloadTasks();props.notify('本批实验已加入任务队列')})
  }
  function continueWithSuggestion():void {
    if(!selected?.analysis?.nextSuggestion)return
    if(!props.tasks.some(t=>t.id===selected.sourceTaskId)){setError('来源任务已删除，请重新选择任务并核对建议参数');return}
    setTaskId(selected.sourceTaskId);setObjective(selected.analysis.nextSuggestion.objective);setRows(selected.analysis.nextSuggestion.axes.map(a=>({flag:a.flag,values:a.values.join(', ')})));setMaxRuns(selected.maxRuns);setUseModel(selected.useModel);setMetricsFile(selected.resultConfig?.metricsFile??'');setArtifactFiles(selected.resultConfig?.artifacts.join('\n')??'');setAssumptions(['已载入上一批的模型建议；需要生成并重新审查配置，尚未提交任务。']);document.querySelector('.research-form')?.scrollIntoView({block:'start'})
  }
  const currentStep=selected?.pending[0]??(selected?.stage==='analysis'?'done':'expand')
  return <section className="research-page" aria-label="对照实验工作流">
    <header className="research-heading"><div><h2>围绕一个问题，组织一组实验</h2><p>配置展开 → 审查 → 排队 → 收集观察。指标不提升也会记录为正常实验结果。</p></div><span title={engine.message} className={`research-engine ${engine.available?'ready':''}`}>{engine.available?'仓颉参数引擎':'TypeScript 参数引擎'}</span></header>
    <div className="research-demo-bar"><div><strong>离线对照演示</strong><p>实际展开参数，模拟运行和指标。无需服务器或 API 密钥，退出或离开页面会清除模拟状态。</p></div><div><button className="secondary-button" disabled={!!busy} onClick={()=>void action('demo',async()=>{const preview=await window.labApi.research.preview(researchDemoCommand,researchDemoAxes,4);const temporary=createResearchDemo(preview);setDemo(temporary);setSelectedId(temporary.id)})}>{demo?'重置对照演示':'载入对照演示'}</button>{demo&&<button className="secondary-button" onClick={()=>{setDemo(null);setSelectedId(history[0]?.id??'')}}>退出对照演示</button>}</div></div>
    {!engine.available&&<p className="research-note" role="status">{engine.message}</p>}
    {error&&<div className="intel-error" role="alert">{error}</div>}
    <div className="research-layout"><aside><section className="research-form"><h3>设计对照方案</h3><p className="research-note">左侧用于设计新批次，右侧展示已保存方案；输入修改不改变历史配置。</p>
      <label>来源实验任务<select aria-label="对照来源任务" disabled={!!busy} value={taskId} onChange={e=>{setTaskId(e.target.value);setAssumptions([])}}><option value="">选择实际服务器上的 Python 命令任务</option>{eligible.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
      {task&&<div className="research-baseline"><span>基准命令</span><code>{task.launchCommand}</code><p>{props.servers.find(s=>s.id===task.serverId)?.name} · {task.codePath}</p></div>}
      <label>研究问题<textarea aria-label="研究问题" rows={3} disabled={!!busy} value={objective} onChange={e=>setObjective(e.target.value)}/></label>
      <div className="research-axis-heading"><h3>参数与候选值</h3><button className="secondary-button" disabled={!!busy||!props.modelEnabled||!taskId||!objective.trim()} onClick={()=>void action('suggest',async()=>{const suggestion=await window.labApi.research.suggest(taskId,objective,maxRuns);setRows(suggestion.axes.map(a=>({flag:a.flag,values:a.values.join(', ')})));setAssumptions([suggestion.hypothesis,...suggestion.assumptions])})}>{busy==='suggest'?<LoaderCircle size={13} className="spin"/>:<FlaskConical size={13}/>}AI 设计范围</button></div>
      <p className="research-note">参数须由脚本支持；候选值用逗号分隔。第一版支持简单数值或无空格文本。</p>
      {rows.map((row,i)=><div className="research-axis" key={i}><input aria-label={`参数 ${i+1}`} disabled={!!busy} placeholder="--lr" value={row.flag} onChange={e=>{setRows(rows.map((r,j)=>i===j?{...r,flag:e.target.value}:r));setAssumptions([])}}/><input aria-label={`候选值 ${i+1}`} disabled={!!busy} placeholder="0.001, 0.0001" value={row.values} onChange={e=>{setRows(rows.map((r,j)=>i===j?{...r,values:e.target.value}:r));setAssumptions([])}}/><button aria-label={`移除参数 ${i+1}`} disabled={!!busy||rows.length===1} onClick={()=>setRows(rows.filter((_,j)=>j!==i))}>×</button></div>)}
      <button className="research-text-button" disabled={!!busy||rows.length>=5} onClick={()=>setRows([...rows,{flag:'',values:''}])}>添加参数</button>
      <label>本批最多运行次数<input aria-label="实验运行预算" type="number" min={1} max={32} disabled={!!busy} value={maxRuns} onChange={e=>setMaxRuns(Number(e.target.value))}/></label>
      <p className={`research-count ${count>maxRuns?'over':''}`}>{count} 组配置 / {maxRuns} 次预算</p>
      <fieldset className="research-result-config"><legend>结果采集</legend>
        <label>结构化指标文件<input aria-label="结构化指标文件" disabled={!!busy} value={metricsFile} onChange={e=>setMetricsFile(e.target.value)} placeholder="{runDir}/metrics.json"/></label>
        <p className="research-note">留空时提取日志末值。支持绝对路径、相对代码目录的路径，以及 {'{runDir}'} / {'{runId}'}。推荐每次运行单独输出。</p>
        <label>预期产物路径<textarea aria-label="预期产物路径" rows={3} disabled={!!busy} value={artifactFiles} onChange={e=>setArtifactFiles(e.target.value)} placeholder={'{runDir}/model.pt\n{runDir}/predictions.json'}/></label>
        <p className="research-note">每行一项，最多 8 项。只检查存在、大小和修改时间，不读取模型内容。指定文件无效时不会用日志指标替代它。</p>
      </fieldset>
      <label className="intel-checkbox"><input type="checkbox" disabled={!!busy||!props.modelEnabled} checked={useModel&&props.modelEnabled} onChange={e=>setUseModel(e.target.checked)}/>运行结束后使用模型分析观察和下一步建议</label>
      <p className="research-note">启用后，末尾日志、指标口径、文件元信息和运行配置会发送到已配置的模型。训练等待期间不调用模型。每批自动诊断最多 4 项故障，其余可在任务栏手动诊断。</p>
      {assumptions.length>0&&<div className="intel-assumptions"><h3>方案依据与待核对项</h3><ul>{assumptions.map((a,i)=><li key={i}>{a}</li>)}</ul></div>}
      <button className="primary-button" disabled={!!busy||!ready||!taskId||!objective.trim()||!count||count>maxRuns||maxRuns<1||maxRuns>32} onClick={()=>void action('create',async()=>{const result=await window.labApi.research.create({taskId,objective,axes,maxRuns,useModel:useModel&&props.modelEnabled,resultConfig});setSelectedId(result.id);props.notify('对照方案已生成，等待审查')})}>{busy==='create'?<LoaderCircle size={14} className="spin"/>:<FlaskConical size={14}/>}生成待审查方案</button>
      <p className="research-note">生成方案会保存流程，确认前不创建运行。原任务保留。</p>
    </section><section className="research-history"><h3>实验研究记录</h3>{demo&&<button className={simulated?'active':''} onClick={()=>setSelectedId(demo.id)}><strong>{demo.objective}</strong><span>临时模拟 · {stageNames[demo.stage]}</span></button>}{history.length?history.map(c=><button key={c.id} className={selectedId===c.id?'active':''} onClick={()=>setSelectedId(c.id)}><strong>{c.objective}</strong><span>{c.error?'需要处理':c.paused?'跟踪已暂停':stageNames[c.stage]} · {c.members.length} 项配置</span></button>):<p className="research-note">确认前后的配置、运行编号和结果会保存在本机。</p>}</section></aside>
    <div className="research-output">{!selected?<div className="intel-empty"><FlaskConical size={34}/><h2>先明确问题，再展开配置</h2><p>选择已有实验任务，填写要比较的参数。这里会列出每份配置及修改内容，供你确认。</p></div>:<>
      <header className="research-campaign-heading"><div><h2>{selected.objective}</h2>{simulated&&<span className="research-engine">离线演示 · 模拟运行</span>}<p>{selected.baseline.title} · {stageNames[selected.stage]}{selected.paused?' · 跟踪已暂停':''}</p></div><button className="secondary-button" disabled={!!busy||simulated} onClick={()=>void action('export',async()=>{if(await window.labApi.research.export(selected.id))props.notify('实验研究记录已导出')})}><FileDown size={14}/>导出</button></header>
      <ol className="research-flow" aria-label="实验流程节点">{nodes.map(([node,label])=><li key={node} className={currentStep===node?'current':selected.events.some(e=>e.node===node)?'done':''}><i/>{label}</li>)}</ol>
      {selected.error&&<div className="intel-error">{selected.error}<p>已有入队记录保留。处理原因后检查进度，系统会核对运行编号再继续。</p></div>}
      {selected.warnings.length>0&&<div className="intel-assumptions"><h3>本批需要核对</h3><ul>{selected.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></div>}
      <div className="research-collection-summary"><strong>本批采集配置</strong><code>指标：{selected.resultConfig?.metricsFile||'日志末值（未指定结构化文件）'}</code>{selected.resultConfig?.artifacts.map(path=><code key={path}>产物：{path}</code>)}</div><div className="research-toolbar"><span>{selected.members.length} 项 / 最多 {selected.maxRuns} 次 · {selected.expansionEngine==='cangjie'?'仓颉展开':'TypeScript 展开'}</span><div>
        {(selected.pending.includes('review')||selected.pending.includes('queue'))&&<button className="primary-button" disabled={!!busy||selected.paused} onClick={()=>void approve()}>{selected.pending.includes('queue')?'恢复已确认的提交':'审查并确认本批入队'}</button>}
        {!simulated&&selected.pending.length>0&&!selected.pending.includes('review')&&!selected.pending.includes('queue')&&<button className="secondary-button" disabled={!!busy||selected.paused} onClick={()=>void action('refresh',async()=>{await window.labApi.research.refresh(selected.id);await reloadTasks()})}><RefreshCw size={13}/>检查进度</button>}
        {!simulated&&selected.pending.length>0&&<button className="secondary-button" disabled={!!busy} onClick={()=>void action('pause',async()=>{await window.labApi.research.setPaused(selected.id,!selected.paused)})}>{selected.paused?<Play size={13}/>:<Pause size={13}/>} {selected.paused?'恢复跟踪':'暂停跟踪'}</button>}
        {!simulated&&selected.stage==='analysis'&&!selected.pending.length&&<button className="secondary-button" disabled={!!busy||selected.paused} onClick={()=>void action('recollect',async()=>{await window.labApi.research.recollect(selected.id);props.notify('结果证据已重新采集，未启动新运行')})}><RefreshCw size={13}/>重新采集结果</button>}
        {simulated&&selected.stage==='waiting'&&<><button className="secondary-button" onClick={()=>setDemo(finishResearchDemo(selected,false))}>模拟正常结束（含指标变差）</button><button className="secondary-button" onClick={()=>setDemo(finishResearchDemo(selected,true))}>模拟一项运行故障</button></>}
      </div></div>
      <div className="research-table-wrap"><table className="research-table"><thead><tr><th>对照配置</th><th>启动命令与修改</th><th>运行</th></tr></thead><tbody>{selected.members.map((member,i)=>{
        const linked=props.tasks.find(t=>t.id===member.taskId),run=linked?.runs.find(r=>r.id===member.runId),observation=selected.observations.find(o=>simulated?o.key===member.key:o.runId===member.runId)
        return <tr key={member.key}><td><strong>对照 {i+1}</strong>{Object.entries(member.parameters).map(([flag,value])=><span key={flag}>{flag} = {value}</span>)}</td><td><code>{member.command}</code><details><summary>查看配置修改</summary>{member.changes.map((change,j)=><p key={j}>{change}</p>)}</details></td><td><span>{run?runNames[run.status]??run.status:simulated?(observation?runNames[observation.status]:selected.stage==='waiting'?'模拟排队中':'尚未模拟提交'):member.runId?'关联记录不可用':'尚未提交'}</span>{linked&&run&&<button className="research-text-button" onClick={()=>props.onOpenTask(linked,run.id)}>打开运行</button>}{observation?.diagnosisId&&<button className="research-text-button" onClick={()=>props.onOpenDiagnosis(observation.diagnosisId!)}>查看故障诊断</button>}</td></tr>
      })}</tbody></table></div>
      {selected.observations.length>0&&<ResearchResults observations={selected.observations}/>}
      {selected.analysis&&<section className="research-analysis"><header><h3>结果观察与下一步</h3><span>{selected.analysis.engine==='model'?'模型分析 + 运行证据':'结构化观察'}</span></header><p>{selected.analysis.summary}</p><ul>{selected.analysis.observations.map((item,i)=><li key={i}>{item}</li>)}</ul><details open><summary>比较范围与限制</summary><ul>{selected.analysis.limitations.map((item,i)=><li key={i}>{item}</li>)}</ul></details>{selected.analysis.nextSuggestion&&<div className="research-next"><p>{selected.analysis.nextSuggestion.objective}</p><button className="secondary-button" onClick={continueWithSuggestion}>载入下一批建议<ArrowRight size={13}/></button><span>载入后需生成方案并重新确认</span></div>}<button className="secondary-button" disabled={!!busy||simulated||selected.events.filter(e=>e.node==='reanalyze').length>=2} onClick={()=>void action('analysis',async()=>{await window.labApi.research.analyze(selected.id)})}>补充分析（最多 2 次）</button></section>}
      <details className="research-timeline" open><summary>{simulated?'流程演示记录 · 当前窗口临时状态':'流程记录 · 已保存检查点'}</summary><ol>{selected.events.map((e,i)=><li key={i}><time>{new Date(e.at).toLocaleString('zh-CN')}</time><span>{e.message}</span></li>)}</ol><p className="research-note">暂停跟踪只暂停此流程，已提交的远程实验仍由任务栏管理。</p></details>
    </>}</div></div>
  </section>
}




