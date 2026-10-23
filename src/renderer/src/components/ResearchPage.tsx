import { userFacingError } from '@shared/user-facing-error'
import { parameterExperimentReason } from '@shared/parameter-engine'
import { resultConfigSchema } from '@shared/research-results'
import { useEffect, useState } from 'react'
import { ChevronDown, FileDown, FlaskConical, History, LoaderCircle, FolderOpen, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import type { ExperimentTask, ServerProfile } from '@shared/types'
import type { ResultCollectionConfig } from '@shared/research-results'
import { baselineDraft } from '@shared/research'
import type { ParameterAxis, ResearchSuggestion, ResearchView } from '@shared/research'
import type { ConfirmationRequest } from './ConfirmDialog'
import './research.css'
import { ResearchResults } from './ResearchResults'
import { RemoteResultFilePicker } from './RemoteResultFilePicker'
interface Props {tasks:ExperimentTask[];servers:ServerProfile[];modelEnabled:boolean;initialTaskId?:string;initialCampaignId?:string;onChanged:(task:ExperimentTask)=>void;onOpenTask:(task:ExperimentTask,runId?:string)=>void;onOpenDiagnosis?:(id:string)=>void;confirm:(request:ConfirmationRequest)=>Promise<boolean>;notify:(message:string,kind?:'success'|'error')=>void}
const stageNames={review:'待确认',waiting:'运行跟踪中',analysis:'结果已汇总'}
const runNames:Record<string,string>={planned:'草稿',queued:'排队中',preparing:'准备中',running:'运行中',paused:'运行暂停',completed:'正常结束',failed:'运行故障',cancelled:'已取消'}
function baselineReason(task:ExperimentTask,runId?:string):string {try{const draft=baselineDraft(task,runId);return parameterExperimentReason(draft.launchCommand,draft.launchMode)}catch(error){return error instanceof Error?error.message:'配置不可用'}}
const collectionKey=(config?:ResultCollectionConfig):string=>JSON.stringify([config?.metricsFile??'',config?.resultFiles??[],config?.artifacts??[]])
const nodes=[['review','确认配置'],['observe','运行跟踪'],['analyze','结果分析']]
export function ResearchPage(props:Props):React.JSX.Element {
  const candidates=props.tasks.filter(t=>props.servers.some(s=>s.mode==='real'&&(s.id===t.serverId||t.runs.some(run=>run.serverId===s.id))))
  const eligible=candidates.filter(t=>t.runs.length?t.runs.some(run=>!baselineReason(t,run.id)):!baselineReason(t))
  const [taskId,setTaskId]=useState(props.initialTaskId||eligible[0]?.id||'')
  const [sourceRunId,setSourceRunId]=useState('')
  const [objective,setObjective]=useState('比较学习率对训练稳定性的影响，保留其他配置。')
  const [rows,setRows]=useState([{flag:'',values:''}])
  const [design,setDesign]=useState<ResearchSuggestion|null>(null)
  const [maxRunsInput,setMaxRunsInput]=useState('9')
  const maxRuns=Number(maxRunsInput)
  const maxRunsValid=/^\d+$/.test(maxRunsInput)&&Number.isSafeInteger(maxRuns)&&maxRuns>=1&&maxRuns<=32
  const [history,setHistory]=useState<ResearchView[]>([]),[selectedId,setSelectedId]=useState(props.initialCampaignId||'')
  const [busy,setBusy]=useState(''),[error,setError]=useState('')
  const [ready,setReady]=useState(false)
  const [historyOpen,setHistoryOpen]=useState(false)
  const [deletingId,setDeletingId]=useState('')
  const [resultFiles,setResultFiles]=useState([''])
  const [pickingFile,setPickingFile]=useState<{index:number;campaignId:string}|null>(null)
  const [resultSource,setResultSource]=useState<'log'|'file'>('log')
  const selected=history.find(c=>c.id===selectedId),task=props.tasks.find(t=>t.id===taskId)
  let baseline:ReturnType<typeof baselineDraft>|undefined
  let unsupported=''
  if(task){
    if(task.runs.length&&!sourceRunId)unsupported='请选择作为基准的运行记录'
    else try{baseline=baselineDraft(task,sourceRunId||undefined);unsupported=parameterExperimentReason(baseline.launchCommand,baseline.launchMode)}catch(cause){unsupported=cause instanceof Error?cause.message:'基准配置不可用'}
  }
  const sampleTask=selected?.members.map(member=>props.tasks.find(task=>task.id===member.taskId)).find(task=>!!task)
  const sampleMember=selected?.members.find(member=>member.taskId===sampleTask?.id)
  const sampleRun=sampleTask?.runs.find(run=>run.id===sampleMember?.runId)
  const browseServerId=sampleRun?.serverId??sampleTask?.serverId??selected?.baseline.serverId
  const browseRouteId=sampleRun?.accessRouteId??sampleTask?.accessRouteId??selected?.baseline.accessRouteId
  const browseCodePath=sampleMember?.outputDirectory??sampleRun?.codePath??sampleTask?.codePath??selected?.baseline.codePath
  const missingRequested=ready&&!!props.initialCampaignId&&selectedId===props.initialCampaignId&&!selected
  const axes:ParameterAxis[]=rows.filter(r=>r.flag.trim()).map(r=>({flag:r.flag.trim(),values:r.values.split(/[,，\n]/).map(v=>v.trim()).filter(Boolean)}))
  const resultConfig={metricsFile:'',artifacts:[],resultFiles:resultSource==='file'?resultFiles.map(path=>path.trim()).filter(Boolean):[]}
  const resultConfigCheck=resultConfigSchema.safeParse(resultConfig)
  const missingMetricsPath=resultSource==='file'&&!resultConfig.resultFiles.length
  const sharedResultPaths=[...resultConfig.resultFiles].filter(path=>path&&!path.includes('{runDir}')&&!path.includes('{runId}')&&(selected?.outputIsolation?.status!=='verified'||path.startsWith('/')))
  const resultConfigDirty=!!selected&&collectionKey(resultConfig)!==collectionKey(selected.resultConfig)
  const count=axes.reduce((n,a)=>n*new Set(a.values).size,axes.length?1:0)
  useEffect(()=>{if(props.initialTaskId&&candidates.some(t=>t.id===props.initialTaskId)){setTaskId(props.initialTaskId);setSourceRunId('');setDesign(null)}},[props.initialTaskId])
  useEffect(()=>{
    let live=true,revision=0
    const refresh=():void=>{const request=++revision;void window.labApi.research.list().then(items=>{if(live&&request===revision){setHistory(items);setReady(true)}}).catch(e=>{if(live){setError(userFacingError(e,'无法读取对照记录，请重试。'));setReady(true)}})}
    refresh()
    const unsubscribe=window.labApi.research.onChanged(refresh)
    return()=>{live=false;unsubscribe()}
  },[])
  useEffect(()=>{
    if(props.initialCampaignId)setSelectedId(props.initialCampaignId)
  },[props.initialCampaignId])
  useEffect(()=>{
    setPickingFile(null)
    const config=selected?.resultConfig
    setResultFiles(config?.resultFiles?.length?config.resultFiles:[config?.metricsFile??''])
    setResultSource(config?.resultFiles?.length||config?.metricsFile?'file':'log')
  },[selected?.id])
  async function action(name:string,fn:()=>Promise<void>):Promise<void>{if(busy)return;setBusy(name);setError('');try{await fn();setHistory(await window.labApi.research.list())}catch(e){setError(userFacingError(e,'本次操作未完成，请检查配置后重试。'))}finally{setBusy('')}}
  async function deleteRecord(campaign:ResearchView):Promise<void>{
    if(busy||deletingId)return
    const confirmed=await props.confirm({title:'删除对照记录？',message:'删除这条对照记录及已保存的结果和分析内容，无法恢复。实验任务、运行记录和服务器文件将保留；已提交的训练任务会继续运行。',details:campaign.objective,detailsLabel:'对照实验',confirmLabel:'删除记录',tone:'danger'})
    if(!confirmed)return
    setDeletingId(campaign.id);setBusy('delete')
    try{
      await window.labApi.research.remove(campaign.id)
      setHistory(await window.labApi.research.list())
      if(selectedId===campaign.id){setSelectedId('');setPickingFile(null)}
      props.notify('对照记录已删除')
    }catch(cause){props.notify(cause instanceof Error?cause.message:'删除对照记录失败','error')}
    finally{setDeletingId('');setBusy('')}
  }
  async function reloadTasks():Promise<void>{for(const item of await window.labApi.experiments.list())props.onChanged(item)}
  async function approve():Promise<void>{
    if(!selected)return
    const accepted=await props.confirm({title:'确认本批对照实验',message:`将 ${selected.members.length} 个配置加入任务队列。运行预算为 ${selected.maxRuns} 次。此确认仅针对当前批次，下一批和故障修复需要重新确认。`,details:`基准：${selected.sourceRunNumber!==undefined?'第 '+selected.sourceRunNumber+' 次运行':'任务配置'}\n服务器：${props.servers.find(s=>s.id===selected.baseline.serverId)?.name??'原服务器'}\n代码目录：${selected.baseline.codePath}\nConda：${selected.baseline.condaEnvironment?.environmentName??selected.baseline.condaEnvironment?.environmentPrefix??'未指定'}\n数据：${selected.baseline.dataPath||'未指定'}\n产物目录：${selected.baseline.artifactPath||'由训练脚本决定'}\n${selected.members.map((m,i)=>`${i+1}. ${m.command}`).join('\n')}`,confirmLabel:'确认本批加入队列'})
    if(accepted)await action('approve',async()=>{await window.labApi.research.approve(selected.id,true);await reloadTasks();props.notify('本批实验已加入任务队列')})
  }
  const currentStep=selected?.stage==='analysis'?2:selected?.stage==='waiting'?1:0
  return <section className="research-page" aria-label="对照实验工作流">
    <header className="research-heading"><div><h2>创建对照组</h2><p>沿用基准实验配置，只比较你指定的参数。</p></div><button type="button" className="secondary-button research-history-trigger" aria-haspopup="dialog" disabled={!!busy} onClick={()=>setHistoryOpen(true)}><History size={15}/>对照记录</button></header>
    {error&&<div className="intel-error" role="alert">{error}</div>}{missingRequested&&<div className="intel-error" role="alert">关联的对照批次已不存在，请在历史批次中重新选择。</div>}
    <div className="research-layout"><aside><section className="research-form"><div className="research-section-heading"><span>1</span><div><h3>基准与目标</h3></div></div>
      <label>来源实验任务<select aria-label="对照来源任务" disabled={!!busy} value={taskId} onChange={e=>{setTaskId(e.target.value);setSourceRunId('');setDesign(null)}}><option value="" disabled hidden>选择来源实验任务</option>{candidates.map(t=><option key={t.id} value={t.id} disabled={!eligible.some(item=>item.id===t.id)}>{t.title}{!eligible.some(item=>item.id===t.id)?'（无可用基准配置）':''}</option>)}</select></label>
      {task&&<label>基准运行记录<select aria-label="基准运行记录" disabled={!!busy||!task.runs.length} value={sourceRunId} onChange={event=>{setSourceRunId(event.target.value);setDesign(null);setError('')}}><option value="" disabled hidden>{task.runs.length?'请选择一次运行':'当前任务配置（尚无运行记录）'}</option>{[...task.runs].reverse().map(run=><option key={run.id} value={run.id} disabled={!!baselineReason(task,run.id)}>第 {run.number} 次运行 · {runNames[run.status]}{run.startedAt||run.queuedAt?` · ${new Date(run.startedAt??run.queuedAt!).toLocaleString('zh-CN')}`:''}{baselineReason(task,run.id)?'（配置不支持）':''}</option>)}</select></label>}
      {unsupported&&<p className="research-note" role="status">{unsupported}</p>}
      {baseline&&<details className="research-baseline"><summary>{sourceRunId?`基于第 ${task?.runs.find(run=>run.id===sourceRunId)?.number} 次运行`:'查看当前基准配置'}<ChevronDown size={13}/></summary><code>{baseline.launchCommand}</code><p>{props.servers.find(s=>s.id===baseline.serverId)?.name} · {baseline.computeDevice==='cpu'?'CPU':'GPU'} · {baseline.codePath}</p>{baseline.condaEnvironment&&<p>Conda · {baseline.condaEnvironment.environmentName??baseline.condaEnvironment.environmentPrefix}</p>}</details>}
      <label>对比目标<textarea aria-label="研究问题" placeholder="例如：比较不同学习率对训练结果的影响" rows={3} disabled={!!busy} value={objective} onChange={e=>{setObjective(e.target.value);setDesign(null)}}/></label>
      <div className="research-axis-heading"><div className="research-section-heading"><span>2</span><div><h3>对比参数</h3></div></div><button className="secondary-button" disabled={!!busy||!props.modelEnabled||!taskId||!!unsupported||!objective.trim()||!maxRunsValid||maxRuns<2} onClick={()=>void action('suggest',async()=>{const suggestion=await window.labApi.research.suggest(taskId,objective,maxRuns,sourceRunId||undefined);setDesign(suggestion);if(suggestion.axes.length)setRows(suggestion.axes.map(a=>({flag:a.flag,values:a.values.join(', ')})))})}>{busy==='suggest'?<LoaderCircle size={13} className="spin"/>:<FlaskConical size={13}/>}{busy==='suggest'?'正在读取项目并设计…':'智能设计对照方案'}</button></div>
      <p className="research-note">手动填写参数，或读取项目文件生成单变量方案。所读文件会发送给已配置的模型。</p>
      {design&&<section className={`research-design ${design.status==='needs_info'?'needs-info':''}`} role="status">
        <header><strong>{design.status==='ready'?'单变量对照方案':'需要补充信息'}</strong>{design.axes.length>0&&<span>{design.axes[0].values.length} 组 · 含基线</span>}</header>
        {design.hypothesis&&<p>{design.hypothesis}</p>}
        {design.variable&&<dl><div><dt>比较变量</dt><dd><code>{design.variable.flag}</code></dd></div><div><dt>基线值</dt><dd><code>{design.variable.baselineValue}</code></dd></div><div><dt>候选值</dt><dd>{design.axes[0]?.values.join(' / ')}</dd></div></dl>}
        {design.rationale&&<p>{design.rationale}</p>}
        {design.assumptions.length>0&&<ul>{design.assumptions.map((item,i)=><li key={i}>{item}</li>)}</ul>}
        <details><summary>基线与项目依据</summary><code>{design.baselineCommand}</code>{design.variable&&<blockquote><span>{design.variable.source.path}:{design.variable.source.startLine}</span><pre>{design.variable.source.quote}</pre></blockquote>}{!!design.readFiles?.length&&<p>已读取：{design.readFiles.join('、')}</p>}</details>
      </section>}
      <p className="research-note">多个候选值用逗号分隔。</p>
      <div className="research-axis-labels"><span>参数名</span><span>候选值</span><span/></div>
      {rows.map((row,i)=><div className="research-axis" key={i}><input aria-label={`参数 ${i+1}`} disabled={!!busy} placeholder="--lr" value={row.flag} onChange={e=>{setRows(rows.map((r,j)=>i===j?{...r,flag:e.target.value}:r));setDesign(null)}}/><input aria-label={`候选值 ${i+1}`} disabled={!!busy} placeholder="0.001, 0.0001" value={row.values} onChange={e=>{setRows(rows.map((r,j)=>i===j?{...r,values:e.target.value}:r));setDesign(null)}}/><button aria-label={`移除参数 ${i+1}`} type="button" className="icon-button" disabled={!!busy||rows.length===1} onClick={()=>{setRows(rows.filter((_,j)=>j!==i));setDesign(null)}}><X size={14}/></button></div>)}
      <button className="research-text-button" disabled={!!busy||rows.length>=5} onClick={()=>{setRows([...rows,{flag:'',values:''}]);setDesign(null)}}><Plus size={13}/>添加参数</button>
      <label>运行数量上限<input aria-label="实验运行预算" type="number" min={1} max={32} step={1} inputMode="numeric" disabled={!!busy} value={maxRunsInput} aria-invalid={maxRunsInput!==''&&!maxRunsValid} onChange={event=>{setMaxRunsInput(event.target.value.replace(/^0+(?=\d)/,''));setDesign(null)}} onBlur={()=>{if(/^\d+$/.test(maxRunsInput))setMaxRunsInput(String(Number(maxRunsInput)))}}/>{maxRunsInput!==''&&!maxRunsValid&&<small>请输入 1～32 之间的整数</small>}</label>
      <p className={`research-count ${maxRunsValid&&count>maxRuns?'over':''}`}><span>将生成 <strong>{count}</strong> 组配置</span><span>{maxRunsValid?`上限 ${maxRuns} 组`:'上限需填写 1～32'}</span></p>
      <button className="primary-button" disabled={!!busy||!ready||!taskId||!!unsupported||!objective.trim()||!count||count>maxRuns||!maxRunsValid} onClick={()=>void action('create',async()=>{const result=await window.labApi.research.create({taskId,sourceRunId:sourceRunId||undefined,objective,axes,maxRuns,expectedBaselineCommand:design?.baselineCommand,design:design?.status==='ready'?design:undefined});setSelectedId(result.id);props.notify('对照方案已生成，等待审查')})}>{busy==='create'?<LoaderCircle size={14} className="spin"/>:<FlaskConical size={14}/>}生成对照方案</button>
    </section></aside>
    <div className="research-output">{!selected?<div className="research-empty"><div className="research-empty-icon"><FlaskConical size={28}/></div><h2>对照方案会在这里展开</h2><ol><li><span>1</span>设置对比参数</li><li><span>2</span>预览生成的配置</li><li><span>3</span>确认并运行</li></ol></div>:<>
      <header className="research-campaign-heading"><div><h2>{selected.objective}</h2><p>{selected.baseline.title}{selected.sourceRunNumber!==undefined?` · 基于第 ${selected.sourceRunNumber} 次运行`:''} · {stageNames[selected.stage]}{selected.paused?' · 跟踪已暂停':''}</p></div><button className="secondary-button" disabled={!!busy} onClick={()=>void action('export',async()=>{if(await window.labApi.research.export(selected.id))props.notify('实验研究记录已导出')})}><FileDown size={14}/>导出</button></header>
      {selected.design&&<details className="research-design"><summary>实验假设与设计依据</summary><p>{selected.design.hypothesis}</p><p>{selected.design.rationale}</p>{selected.design.variable&&<p><code>{selected.design.variable.flag}</code> · 基线 {selected.design.variable.baselineValue} · {selected.design.variable.source.path}:{selected.design.variable.source.startLine}</p>}</details>}
      {selected.outputIsolation&&<section className="research-output-isolation">
        {selected.outputIsolation.status==='verified'?<><strong>各组使用独立输出目录</strong><p>已根据项目源码调整 {selected.outputIsolation.flag}，具体位置见下方配置。</p>{selected.outputIsolation.source&&<details><summary>查看输出参数依据</summary><span>{selected.outputIsolation.source.path}:{selected.outputIsolation.source.startLine}</span><pre>{selected.outputIsolation.source.quote}</pre></details>}</>:<p className="intel-error" role="alert">{selected.outputIsolation.reason} 当前方案暂不能提交。</p>}
      </section>}
      <ol className="research-flow" aria-label="对照实验进度">{nodes.map(([node,label],index)=><li key={node} className={index===currentStep?'current':index<currentStep?'done':''}><i>{index+1}</i>{label}</li>)}</ol>
      <div className="research-stats"><div><span>本批配置</span><strong>{selected.members.length}<small>组</small></strong></div><div><span>已采集结果</span><strong>{selected.observations.length}<small>/ {selected.members.length}</small></strong></div><div><span>当前阶段</span><strong className="research-stage-text">{selected.paused?'跟踪已暂停':stageNames[selected.stage]}</strong></div></div>
      {selected.error&&<div className="intel-error">{userFacingError(selected.error,'本批对照实验处理遇到问题，请检查配置或稍后重试。')}<p>已有入队记录保留。处理原因后检查进度，系统会核对运行编号再继续。</p></div>}
      {selected.warnings.length>0&&<details className="research-review-notes"><summary>本批需要核对 · {selected.warnings.length} 项</summary><ul>{selected.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></details>}
      <div className="research-toolbar"><span>{selected.members.length} 组配置 · {selected.stage==='review'?'确认后运行':selected.stage==='waiting'?'按记录跟踪本批任务':'本批结果已汇总'}</span><div>
        {(selected.pending.includes('review')||selected.pending.includes('queue'))&&<button className="primary-button" disabled={!!busy||selected.paused||selected.outputIsolation?.status==='unverified'} onClick={()=>void approve()}>{selected.pending.includes('queue')?'恢复已确认的提交':'确认并运行本批'}</button>}
        {selected.pending.length>0&&!selected.pending.includes('review')&&!selected.pending.includes('queue')&&<button className="secondary-button" disabled={!!busy||selected.paused} onClick={()=>void action('refresh',async()=>{await window.labApi.research.refresh(selected.id);await reloadTasks()})}><RefreshCw size={13}/>检查进度</button>}
        {selected.paused&&<button className="secondary-button" disabled={!!busy} onClick={()=>void action('resume',async()=>{await window.labApi.research.setPaused(selected.id,false)})}><Play size={13}/>恢复跟踪</button>}
      </div></div>
      <div className="research-table-wrap"><table className="research-table"><thead><tr><th>对照配置</th><th>启动命令与修改</th><th>运行</th></tr></thead><tbody>{selected.members.map((member,i)=>{
        const linked=props.tasks.find(t=>t.id===member.taskId),run=linked?.runs.find(r=>r.id===member.runId),observation=selected.observations.find(o=>o.runId===member.runId)
        return <tr key={member.key}><td><strong>{selected.design&&i===0?'基线':`对照 ${selected.design?i:i+1}`}</strong>{Object.entries(member.parameters).map(([flag,value])=><span key={flag}>{flag} = {value}</span>)}</td><td><code>{member.command}</code>{member.outputDirectory&&<span className="research-member-output">输出：{member.outputDirectory}</span>}<details><summary>查看完整命令与修改</summary><code>{member.command}</code>{member.changes.map((change,j)=><p key={j}>{change}</p>)}</details></td><td><span>{run?runNames[run.status]??run.status:member.runId?'关联记录不可用':'尚未提交'}</span>{linked&&run&&<button className="research-text-button" onClick={()=>props.onOpenTask(linked,run.id)}>打开运行</button>}{observation?.diagnosisId&&props.onOpenDiagnosis&&<button className="research-text-button" onClick={()=>props.onOpenDiagnosis?.(observation.diagnosisId!)}>查看故障诊断</button>}</td></tr>
      })}</tbody></table></div>
      {selected.stage==='analysis'&&!selected.pending.length&&<>
      <section className="research-result-source" aria-labelledby="research-result-source-title">
        <h3 id="research-result-source-title">结果来源</h3>
        <div className="research-result-source-options" role="radiogroup" aria-label="指标结果来源">
          <label><input type="radio" name="research-result-source" value="log" checked={resultSource==='log'} disabled={!!busy} onChange={()=>setResultSource('log')}/>控制台输出</label>
          <label><input type="radio" name="research-result-source" value="file" checked={resultSource==='file'} disabled={!!busy} onChange={()=>setResultSource('file')}/>结果日志文件</label>
        </div>
        {resultSource==='log'?<p className="research-note">采集运行时的控制台输出，运行结束后可选择 AI 分析。</p>:<div className="research-result-files">
          {resultFiles.map((path,index)=><div className="research-result-file-row" key={index}><label>结果文件 {index+1}<input aria-label={`结果文件 ${index+1}`} disabled={!!busy} value={path} onChange={event=>setResultFiles(current=>current.map((item,i)=>i===index?event.target.value:item))} placeholder={index===0?'outputs/log.txt':'outputs/results.csv'}/></label><button type="button" className="secondary-button research-select-file" disabled={!!busy||!browseServerId||!browseCodePath?.startsWith('/')} onClick={()=>selected&&setPickingFile({index,campaignId:selected.id})}><FolderOpen size={14}/>选择文件</button><button type="button" className="icon-button" aria-label={`移除结果文件 ${index+1}`} disabled={!!busy||resultFiles.length===1} onClick={()=>setResultFiles(current=>current.filter((_,i)=>i!==index))}><X size={14}/></button></div>)}
          <button type="button" className="research-text-button" disabled={!!busy||resultFiles.length>=8} onClick={()=>setResultFiles(current=>[...current,''])}><Plus size={13}/>添加结果文件</button>
          <p className="research-note">支持日志、JSON、CSV 等文本格式，最多 8 个文件。相对路径以{selected.outputIsolation?.status==='verified'?'各组独立输出目录':'各次运行的代码目录'}为起点；采集内容会在你点击 AI 分析后发送给模型。</p>
        </div>}
        {selected.members.length>1&&sharedResultPaths.length>0&&<p className="research-path-warning" role="status">各组将读取相同的结果路径，可能覆盖结果。请确认脚本会分别保存，并配置对应路径。</p>}
        {!resultConfigCheck.success&&<p className="intel-error" role="alert">{userFacingError(resultConfigCheck.error.issues[0]?.message,'结果文件路径有问题，请检查填写内容。')}</p>}
        {missingMetricsPath&&<p className="research-note">请至少填写一个结果文件路径。</p>}
        <div className="research-result-actions">
        <button className="secondary-button" disabled={!!busy||selected.paused||missingMetricsPath||!resultConfigCheck.success} onClick={()=>void action('recollect',async()=>{const result=await window.labApi.research.recollect(selected.id,resultConfig);const issues=result.observations.flatMap(o=>o.files??[]).filter(file=>file.status!=='available').length;props.notify(issues?`采集完成，${issues} 项文件存在问题，请查看下方详情`:'检查与采集完成',issues?'error':'success')})}>{busy==='recollect'?<LoaderCircle size={13} className="spin"/>:<RefreshCw size={13}/>}{busy==='recollect'?'检查并采集中…':'检查并采集'}</button>
        <button className="secondary-button" disabled={!!busy||selected.paused||resultConfigDirty||!props.modelEnabled||selected.events.filter(e=>e.node==='result_analysis').length>=2} title={resultConfigDirty?'请先检查并采集当前结果来源':!props.modelEnabled?'请先在设置中启用模型':selected.events.filter(e=>e.node==='result_analysis').length>=2?'已达到本批分析次数上限':undefined} onClick={()=>void action('analysis',async()=>{const result=await window.labApi.research.analyze(selected.id);if(result.analysis?.engine!=='model')props.notify('AI 分析未完成，已保留结果汇总','error')})}>{busy==='analysis'?<LoaderCircle size={13} className="spin"/>:<FlaskConical size={13}/>}{busy==='analysis'?'正在分析…':selected.analysis?.engine==='model'?'重新进行 AI 分析':'AI 分析结果'}</button></div>
        {resultConfigDirty&&<p className="research-note" role="status">结果来源已修改，请先检查并采集，再进行 AI 分析。</p>}
      </section>
      </>}
      {resultConfigDirty&&selected.observations.length>0&&<p className="research-note">下方为上次采集的结果，重新采集后更新。</p>}
      {selected.observations.length>0&&<ResearchResults observations={selected.observations} config={selected.resultConfig}/>}
      {selected.analysis&&selected.analysis.contentVersion!==2&&<p className="research-note">结果分析已更新，请点击 AI 分析结果重新生成。</p>}
      {selected.analysis?.contentVersion===2&&<section className="research-analysis"><header><h3>结果分析</h3></header><p>{selected.analysis.summary}</p><ul>{selected.analysis.observations.map((item,i)=><li key={i}>{item}</li>)}</ul></section>}
    </>}</div></div>
    {pickingFile&&selected?.id===pickingFile.campaignId&&browseServerId&&browseCodePath&&<RemoteResultFilePicker serverId={browseServerId} accessRouteId={browseRouteId} initialPath={browseCodePath} serverName={props.servers.find(server=>server.id===browseServerId)?.name} onClose={()=>setPickingFile(null)} onSelect={path=>{const root=browseCodePath.replace(/\/+$/,'');const value=path.startsWith(root+'/')?path.slice(root.length+1):path;setResultFiles(current=>current.map((item,index)=>index===pickingFile.index?value:item));setPickingFile(null)}}/>}
    {historyOpen&&<div className="app-modal-overlay" onMouseDown={event=>{if(event.target===event.currentTarget)setHistoryOpen(false)}} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setHistoryOpen(false)}}}><section className="app-modal research-history-dialog" role="dialog" aria-modal="true" aria-labelledby="research-history-title"><header className="dialog-header app-modal-header"><div className="dialog-title-wrap app-modal-title"><div className="dialog-icon"><History size={18}/></div><div><h2 id="research-history-title">对照实验记录</h2></div></div><button type="button" className="icon-button" autoFocus aria-label="关闭对照实验记录" onClick={()=>setHistoryOpen(false)}><X size={16}/></button></header>
<div className="research-history">{history.length?history.map(c=><article className="research-history-entry" key={c.id}><button type="button" className={`research-history-open ${selectedId===c.id?'active':''}`} disabled={!!busy||!!deletingId} onClick={()=>{setSelectedId(c.id);setHistoryOpen(false)}}><strong>{c.objective}</strong><span>{c.error?'需要处理':c.paused?'跟踪已暂停':stageNames[c.stage]} · {c.members.length} 项配置{c.sourceRunNumber!==undefined?` · 基于第 ${c.sourceRunNumber} 次运行`:''}</span></button><button type="button" className="icon-button" aria-label={`删除对照记录：${c.objective}`} title={c.busy?'正在处理，请稍后再删除':'删除对照记录'} disabled={!!busy||!!deletingId||c.busy} onClick={()=>void deleteRecord(c)}>{deletingId===c.id?<LoaderCircle size={15} className="spin"/>:<Trash2 size={15}/>}</button></article>):<p className="research-note">暂无对照实验记录。</p>}</div>
    </section></div>}
  </section>
}




