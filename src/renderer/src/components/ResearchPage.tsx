import { parameterExperimentReason } from '@shared/parameter-engine'
import { useEffect, useState } from 'react'
import { ArrowRight, ChevronDown, FileDown, FlaskConical, History, LoaderCircle, Pause, Play, Plus, RefreshCw, X } from 'lucide-react'
import type { ExperimentTask, ServerProfile } from '@shared/types'
import type { ParameterAxis, ResearchView } from '@shared/research'
import type { ConfirmationRequest } from './ConfirmDialog'
import './research.css'
import { ResearchResults } from './ResearchResults'
import { createResearchDemo, finishResearchDemo, queueResearchDemo, researchDemoAxes, researchDemoCommand } from '@shared/research-demo'
interface Props {tasks:ExperimentTask[];servers:ServerProfile[];modelEnabled:boolean;initialTaskId?:string;initialCampaignId?:string;onChanged:(task:ExperimentTask)=>void;onOpenTask:(task:ExperimentTask,runId?:string)=>void;onOpenDiagnosis?:(id:string)=>void;confirm:(request:ConfirmationRequest)=>Promise<boolean>;notify:(message:string,kind?:'success'|'error')=>void}
const stageNames={review:'待确认',waiting:'运行跟踪中',analysis:'结果已汇总'}
const runNames:Record<string,string>={planned:'草稿',queued:'排队中',preparing:'准备中',running:'运行中',paused:'运行暂停',completed:'正常结束',failed:'运行故障',cancelled:'已取消'}
const nodes=[['review','确认配置'],['observe','运行跟踪'],['analyze','结果分析']]
export function ResearchPage(props:Props):React.JSX.Element {
  const candidates=props.tasks.filter(t=>props.servers.some(s=>s.id===t.serverId&&s.mode==='real'))
  const eligible=candidates.filter(t=>!parameterExperimentReason(t.launchCommand,t.launchMode))
  const [taskId,setTaskId]=useState(props.initialTaskId||eligible[0]?.id||'')
  const [objective,setObjective]=useState('比较学习率对训练稳定性的影响，保留其他配置。')
  const [rows,setRows]=useState([{flag:'',values:''}])
  const [maxRuns,setMaxRuns]=useState(9),[useModel,setUseModel]=useState(false)
  const [history,setHistory]=useState<ResearchView[]>([]),[selectedId,setSelectedId]=useState(props.initialCampaignId||'')
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[assumptions,setAssumptions]=useState<string[]>([])
  const [ready,setReady]=useState(false)
  const [historyOpen,setHistoryOpen]=useState(false)
  const [metricsFile,setMetricsFile]=useState(''),[artifactFiles,setArtifactFiles]=useState('')
  const [demo,setDemo]=useState<ResearchView|null>(null)
  const selected=demo?.id===selectedId?demo:history.find(c=>c.id===selectedId),task=props.tasks.find(t=>t.id===taskId)
  const simulated=!!demo&&selected?.id===demo.id
  const unsupported=task?parameterExperimentReason(task.launchCommand,task.launchMode):''
  const missingRequested=ready&&!!props.initialCampaignId&&selectedId===props.initialCampaignId&&!selected
  const axes:ParameterAxis[]=rows.filter(r=>r.flag.trim()).map(r=>({flag:r.flag.trim(),values:r.values.split(/[,，\n]/).map(v=>v.trim()).filter(Boolean)}))
  const resultConfig={metricsFile:metricsFile.trim(),artifacts:artifactFiles.split(/\r?\n/).map(path=>path.trim()).filter(Boolean)}
  const count=axes.reduce((n,a)=>n*new Set(a.values).size,axes.length?1:0)
  useEffect(()=>{if(props.initialTaskId&&candidates.some(t=>t.id===props.initialTaskId))setTaskId(props.initialTaskId)},[props.initialTaskId])
  useEffect(()=>{
    let live=true,revision=0
    const refresh=():void=>{const request=++revision;void window.labApi.research.list().then(items=>{if(live&&request===revision){setHistory(items);setReady(true)}}).catch(e=>{if(live){setError(e.message??String(e));setReady(true)}})}
    refresh()
    const unsubscribe=window.labApi.research.onChanged(refresh)
    return()=>{live=false;unsubscribe()}
  },[])
  useEffect(()=>{
    if(props.initialCampaignId){setDemo(null);setSelectedId(props.initialCampaignId)}
  },[props.initialCampaignId])
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
  const currentStep=selected?.stage==='analysis'?2:selected?.stage==='waiting'?1:0
  return <section className="research-page" aria-label="对照实验工作流">
    <header className="research-heading"><div><h2>创建对照组</h2><p>沿用基准实验配置，只比较你指定的参数。</p></div><button type="button" className="secondary-button research-history-trigger" aria-haspopup="dialog" disabled={!!busy} onClick={()=>setHistoryOpen(true)}><History size={15}/>对照记录</button></header>
    {error&&<div className="intel-error" role="alert">{error}</div>}{missingRequested&&<div className="intel-error" role="alert">关联的对照批次已不存在，请在历史批次中重新选择。</div>}
    <div className="research-layout"><aside><section className="research-form"><div className="research-section-heading"><span>1</span><div><h3>基准与目标</h3></div></div>
      <label>来源实验任务<select aria-label="对照来源任务" disabled={!!busy} value={taskId} onChange={e=>{setTaskId(e.target.value);setAssumptions([])}}><option value="">选择实际服务器上的 Python 命令任务</option>{candidates.map(t=><option key={t.id} value={t.id} disabled={!!parameterExperimentReason(t.launchCommand,t.launchMode)}>{t.title}{parameterExperimentReason(t.launchCommand,t.launchMode)?'（暂不支持参数展开）':''}</option>)}</select></label>
      {unsupported&&<p className="intel-error" role="status">{unsupported}</p>}
      {task&&<details className="research-baseline"><summary>查看基准配置<ChevronDown size={13}/></summary><code>{task.launchCommand}</code><p>{props.servers.find(s=>s.id===task.serverId)?.name} · {task.computeDevice==='cpu'?'CPU':'GPU'} · {task.codePath}</p></details>}
      <label>对比目标<textarea aria-label="研究问题" placeholder="例如：比较不同学习率对训练结果的影响" rows={3} disabled={!!busy} value={objective} onChange={e=>setObjective(e.target.value)}/></label>
      <div className="research-axis-heading"><div className="research-section-heading"><span>2</span><div><h3>对比参数</h3></div></div><button className="secondary-button" disabled={!!busy||!props.modelEnabled||!taskId||!!unsupported||!objective.trim()} onClick={()=>void action('suggest',async()=>{const suggestion=await window.labApi.research.suggest(taskId,objective,maxRuns);setRows(suggestion.axes.length?suggestion.axes.map(a=>({flag:a.flag,values:a.values.join(', ')})):[{flag:'',values:''}]);setAssumptions([suggestion.hypothesis,...suggestion.assumptions])})}>{busy==='suggest'?<LoaderCircle size={13} className="spin"/>:<FlaskConical size={13}/>}AI 建议参数</button></div>
      <p className="research-note">填写脚本支持的参数名，多个候选值用逗号分隔。</p>
      <div className="research-axis-labels"><span>参数名</span><span>候选值</span><span/></div>
      {rows.map((row,i)=><div className="research-axis" key={i}><input aria-label={`参数 ${i+1}`} disabled={!!busy} placeholder="--lr" value={row.flag} onChange={e=>{setRows(rows.map((r,j)=>i===j?{...r,flag:e.target.value}:r));setAssumptions([])}}/><input aria-label={`候选值 ${i+1}`} disabled={!!busy} placeholder="0.001, 0.0001" value={row.values} onChange={e=>{setRows(rows.map((r,j)=>i===j?{...r,values:e.target.value}:r));setAssumptions([])}}/><button aria-label={`移除参数 ${i+1}`} type="button" className="icon-button" disabled={!!busy||rows.length===1} onClick={()=>setRows(rows.filter((_,j)=>j!==i))}><X size={14}/></button></div>)}
      <button className="research-text-button" disabled={!!busy||rows.length>=5} onClick={()=>setRows([...rows,{flag:'',values:''}])}><Plus size={13}/>添加参数</button>
      <label>运行数量上限<input aria-label="实验运行预算" type="number" min={1} max={32} disabled={!!busy} value={maxRuns} onChange={e=>setMaxRuns(Number(e.target.value))}/></label>
      <p className={`research-count ${count>maxRuns?'over':''}`}><span>将生成 <strong>{count}</strong> 组配置</span><span>上限 {maxRuns} 组</span></p>
      <details className="research-result-options"><summary><span>结果采集设置</span><span>{metricsFile.trim()||artifactFiles.trim()?'已配置':'使用默认采集'}</span><ChevronDown size={14}/></summary><fieldset className="research-result-config"><legend>结果采集</legend>
        <label>结构化指标文件<input aria-label="结构化指标文件" disabled={!!busy} value={metricsFile} onChange={e=>setMetricsFile(e.target.value)} placeholder="{runDir}/metrics.json"/></label>
        <p className="research-note">留空则从日志提取指标。路径支持 {'{runDir}'} / {'{runId}'}。</p>
        <label>预期产物路径<textarea aria-label="预期产物路径" rows={3} disabled={!!busy} value={artifactFiles} onChange={e=>setArtifactFiles(e.target.value)} placeholder={'{runDir}/model.pt\n{runDir}/predictions.json'}/></label>
        <p className="research-note">每行一个路径，最多 8 项。仅检查文件是否生成。</p>
      </fieldset></details>
      <label className="intel-checkbox research-model-toggle"><input type="checkbox" disabled={!!busy||!props.modelEnabled} checked={useModel&&props.modelEnabled} onChange={e=>setUseModel(e.target.checked)}/>运行结束后用 AI 分析结果</label>
      {assumptions.length>0&&<details className="research-review-notes"><summary>参数建议与待核对项</summary><ul>{assumptions.map((a,i)=><li key={i}>{a}</li>)}</ul></details>}
      <button className="primary-button" disabled={!!busy||!ready||!taskId||!!unsupported||!objective.trim()||!count||count>maxRuns||maxRuns<1||maxRuns>32} onClick={()=>void action('create',async()=>{const result=await window.labApi.research.create({taskId,objective,axes,maxRuns,useModel:useModel&&props.modelEnabled,resultConfig});setSelectedId(result.id);props.notify('对照方案已生成，等待审查')})}>{busy==='create'?<LoaderCircle size={14} className="spin"/>:<FlaskConical size={14}/>}生成对照方案</button>
    </section></aside>
    <div className="research-output">{!selected?<div className="research-empty"><div className="research-empty-icon"><FlaskConical size={28}/></div><h2>对照方案会在这里展开</h2><ol><li><span>1</span>设置对比参数</li><li><span>2</span>预览生成的配置</li><li><span>3</span>确认并运行</li></ol></div>:<>
      <header className="research-campaign-heading"><div><h2>{selected.objective}</h2>{simulated&&<span className="research-engine">离线演示 · 模拟运行</span>}<p>{selected.baseline.title} · {stageNames[selected.stage]}{selected.paused?' · 跟踪已暂停':''}</p></div><button className="secondary-button" disabled={!!busy||simulated} onClick={()=>void action('export',async()=>{if(await window.labApi.research.export(selected.id))props.notify('实验研究记录已导出')})}><FileDown size={14}/>导出</button></header>
      <ol className="research-flow" aria-label="对照实验进度">{nodes.map(([node,label],index)=><li key={node} className={index===currentStep?'current':index<currentStep?'done':''}><i>{index+1}</i>{label}</li>)}</ol>
      <div className="research-stats"><div><span>本批配置</span><strong>{selected.members.length}<small>组</small></strong></div><div><span>已采集结果</span><strong>{selected.observations.length}<small>/ {selected.members.length}</small></strong></div><div><span>当前阶段</span><strong className="research-stage-text">{selected.paused?'跟踪已暂停':stageNames[selected.stage]}</strong></div></div>
      {selected.error&&<div className="intel-error">{selected.error}<p>已有入队记录保留。处理原因后检查进度，系统会核对运行编号再继续。</p></div>}
      {selected.warnings.length>0&&<details className="research-review-notes"><summary>本批需要核对 · {selected.warnings.length} 项</summary><ul>{selected.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></details>}
      <details className="research-collection-summary"><summary>结果采集配置</summary><code>指标：{selected.resultConfig?.metricsFile||'日志末值（未指定结构化文件）'}</code>{selected.resultConfig?.artifacts.map(path=><code key={path}>产物：{path}</code>)}</details><div className="research-toolbar"><span>{selected.members.length} 组配置 · {selected.stage==='review'?'确认后运行':selected.stage==='waiting'?'按记录跟踪本批任务':'本批结果已汇总'}</span><div>
        {(selected.pending.includes('review')||selected.pending.includes('queue'))&&<button className="primary-button" disabled={!!busy||selected.paused} onClick={()=>void approve()}>{selected.pending.includes('queue')?'恢复已确认的提交':'确认并运行本批'}</button>}
        {!simulated&&selected.pending.length>0&&!selected.pending.includes('review')&&!selected.pending.includes('queue')&&<button className="secondary-button" disabled={!!busy||selected.paused} onClick={()=>void action('refresh',async()=>{await window.labApi.research.refresh(selected.id);await reloadTasks()})}><RefreshCw size={13}/>检查进度</button>}
        {!simulated&&selected.pending.length>0&&<button className="secondary-button" disabled={!!busy} onClick={()=>void action('pause',async()=>{await window.labApi.research.setPaused(selected.id,!selected.paused)})}>{selected.paused?<Play size={13}/>:<Pause size={13}/>} {selected.paused?'恢复跟踪':'暂停跟踪'}</button>}
        {!simulated&&selected.stage==='analysis'&&!selected.pending.length&&<button className="secondary-button" disabled={!!busy||selected.paused} onClick={()=>void action('recollect',async()=>{await window.labApi.research.recollect(selected.id);props.notify('结果证据已重新采集，未启动新运行')})}><RefreshCw size={13}/>重新采集结果</button>}
        {simulated&&selected.stage==='waiting'&&<><button className="secondary-button" onClick={()=>setDemo(finishResearchDemo(selected,false))}>模拟正常结束（含指标变差）</button><button className="secondary-button" onClick={()=>setDemo(finishResearchDemo(selected,true))}>模拟一项运行故障</button></>}
      </div></div>
      <div className="research-table-wrap"><table className="research-table"><thead><tr><th>对照配置</th><th>启动命令与修改</th><th>运行</th></tr></thead><tbody>{selected.members.map((member,i)=>{
        const linked=props.tasks.find(t=>t.id===member.taskId),run=linked?.runs.find(r=>r.id===member.runId),observation=selected.observations.find(o=>simulated?o.key===member.key:o.runId===member.runId)
        return <tr key={member.key}><td><strong>对照 {i+1}</strong>{Object.entries(member.parameters).map(([flag,value])=><span key={flag}>{flag} = {value}</span>)}</td><td><code>{member.command}</code><details><summary>查看完整命令与修改</summary><code>{member.command}</code>{member.changes.map((change,j)=><p key={j}>{change}</p>)}</details></td><td><span>{run?runNames[run.status]??run.status:simulated?(observation?runNames[observation.status]:selected.stage==='waiting'?'模拟排队中':'尚未模拟提交'):member.runId?'关联记录不可用':'尚未提交'}</span>{linked&&run&&<button className="research-text-button" onClick={()=>props.onOpenTask(linked,run.id)}>打开运行</button>}{observation?.diagnosisId&&props.onOpenDiagnosis&&<button className="research-text-button" onClick={()=>props.onOpenDiagnosis?.(observation.diagnosisId!)}>查看故障诊断</button>}</td></tr>
      })}</tbody></table></div>
      {selected.observations.length>0&&<ResearchResults observations={selected.observations}/>}
      {selected.analysis&&<section className="research-analysis"><header><h3>结果观察与下一步</h3><span>{selected.analysis.engine==='model'?'模型分析 + 运行证据':'结构化观察'}</span></header><p>{selected.analysis.summary}</p><ul>{selected.analysis.observations.map((item,i)=><li key={i}>{item}</li>)}</ul><details><summary>比较范围与限制</summary><ul>{selected.analysis.limitations.map((item,i)=><li key={i}>{item}</li>)}</ul></details>{selected.analysis.nextSuggestion&&<div className="research-next"><p>{selected.analysis.nextSuggestion.objective}</p><button className="secondary-button" onClick={continueWithSuggestion}>载入下一批建议<ArrowRight size={13}/></button><span>载入后需生成方案并重新确认</span></div>}<button className="secondary-button" disabled={!!busy||simulated||selected.events.filter(e=>e.node==='reanalyze').length>=2} onClick={()=>void action('analysis',async()=>{await window.labApi.research.analyze(selected.id)})}>补充分析（最多 2 次）</button></section>}
      <details className="research-timeline"><summary>{simulated?'模拟记录':'流程记录'}</summary><ol>{selected.events.map((e,i)=><li key={i}><time>{new Date(e.at).toLocaleString('zh-CN')}</time><span>{e.message}</span></li>)}</ol><p className="research-note">暂停跟踪只暂停此流程，已提交的远程实验仍由任务栏管理。</p></details>
    </>}</div></div>
    <div className="research-secondary-options">
    <details className="research-demo-options"><summary>离线演示</summary><div className="research-demo-bar"><div><strong>离线对照演示</strong><p>使用模拟数据体验对照流程，离开页面后清除。</p></div><div><button className="secondary-button" disabled={!!busy} onClick={()=>void action('demo',async()=>{const preview=await window.labApi.research.preview(researchDemoCommand,researchDemoAxes,4);const temporary=createResearchDemo(preview);setDemo(temporary);setSelectedId(temporary.id)})}>{demo?'重置对照演示':'载入对照演示'}</button>{demo&&<button className="secondary-button" onClick={()=>{setDemo(null);setSelectedId(history[0]?.id??'')}}>退出对照演示</button>}</div></div></details>
    </div>
    {historyOpen&&<div className="app-modal-overlay" onMouseDown={event=>{if(event.target===event.currentTarget)setHistoryOpen(false)}} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setHistoryOpen(false)}}}><section className="app-modal research-history-dialog" role="dialog" aria-modal="true" aria-labelledby="research-history-title"><header className="dialog-header app-modal-header"><div className="dialog-title-wrap app-modal-title"><div className="dialog-icon"><History size={18}/></div><div><h2 id="research-history-title">对照实验记录</h2></div></div><button type="button" className="icon-button" autoFocus aria-label="关闭对照实验记录" onClick={()=>setHistoryOpen(false)}><X size={16}/></button></header>
<div className="research-history">{demo&&<button className={simulated?'active':''} onClick={()=>{setSelectedId(demo.id);setHistoryOpen(false)}}><strong>{demo.objective}</strong><span>临时模拟 · {stageNames[demo.stage]}</span></button>}{history.length?history.map(c=><button key={c.id} className={selectedId===c.id?'active':''} onClick={()=>{setSelectedId(c.id);setHistoryOpen(false)}}><strong>{c.objective}</strong><span>{c.error?'需要处理':c.paused?'跟踪已暂停':stageNames[c.stage]} · {c.members.length} 项配置</span></button>):<p className="research-note">暂无对照实验记录。</p>}</div>
    </section></div>}
  </section>
}




