import { useEffect, useRef, useState } from 'react'
import { ArrowRight, BookOpen, CheckCircle2, FileCode2, FolderOpen, LoaderCircle } from 'lucide-react'
import type { CondaEnvironmentInfo, ExperimentTask, ServerProfile } from '@shared/types'
import type { RepositoryCandidate, RepositoryCitation, RepositoryDirectoryView, RepositoryGuideStep, RepositoryProgress, RepositorySnapshot, RepositoryWorkflowAction, RepositoryWorkflowView } from '@shared/repository-guide'
import { recommendRepositoryFiles, repositoryReviewQuestions, repositoryFieldAnswer } from '@shared/repository-guide'
import { getDefaultAccessRouteId } from '@shared/access-routes'
import { AccessRouteSelect } from './AccessRouteSelect'
import { ModelUsageLine } from './ModelUsageLine'
import './repository-guide.css'

interface Props {
  servers:ServerProfile[];tasks:ExperimentTask[];modelEnabled:boolean;initialTask?:ExperimentTask
  onQuickPlan():void;onModelSettings():void;onChanged(task:ExperimentTask):void;onOpenTask(task:ExperimentTask,runId?:string,start?:boolean):void;onDiagnose(task:ExperimentTask,runId?:string):void
  notify(message:string,kind?:'success'|'error'):void
}
const phases={analyzing:'正在分析',needs_info:'需要补充信息',preparing:'完成启动前准备',ready:'可以保存并选择 GPU',draft:'草稿已保存',queued:'正在排队',running:'正在运行',paused:'运行已暂停',cancelled:'运行已取消',completed:'进程正常结束',failed:'运行异常',task_missing:'关联任务已删除',run_missing:'关联运行缺失'}
const formatBytes=(bytes:number):string=>bytes>=1024*1024?`${(bytes/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.round(bytes/1024))} KB`
const nextStep={analyzing:'正在读取所选文件并整理启动方式。',needs_info:'补充缺少的信息，再检查启动配置。',preparing:'完成下方环境或数据准备，再确认已完成。',ready:'核对配置后保存，直接打开 GPU 选择。',draft:'GPU 选择窗口应已打开；确认后才会入队。',queued:'任务池正在等待资源与启动前检查。',running:'到任务池查看这次运行的日志。',paused:'到任务池查看暂停原因。',cancelled:'可查看原记录，再决定是否创建新运行。',completed:'到任务池核对指标与产物。正常退出不代表实验目标达成。',failed:'从这次运行进入诊断，修复仍需审查。',task_missing:'原任务已删除。可以新建分析，再创建任务。',run_missing:'关联运行已删除；保留原关联，不切换到其他运行。'}
function Citations({items}:{items:RepositoryCitation[]}):React.JSX.Element|null {
  return items.length?<details className="repository-citations"><summary>查看文件依据</summary>{items.map((c,i)=><div key={i}><strong>{c.path}:{c.startLine}–{c.endLine}</strong><pre>{c.quote}</pre></div>)}</details>:null
}
export function RepositoryGuidePage(props:Props):React.JSX.Element {
  const real=props.servers.filter(s=>s.mode==='real')
  const [serverId,setServerId]=useState(props.initialTask?.serverId??real[0]?.id??'')
  const [routeId,setRouteId]=useState(props.initialTask?.accessRouteId??'')
  const [path,setPath]=useState(props.initialTask?.codePath??'')
  const [goal,setGoal]=useState(props.initialTask?.objective??'')
  const [snapshot,setSnapshot]=useState<RepositorySnapshot|null>(null)
  const [files,setFiles]=useState<string[]>([])
  const [flows,setFlows]=useState<RepositoryWorkflowView[]>([])
  const [selectedId,setSelectedId]=useState('')
  const [busy,setBusy]=useState(''),[error,setError]=useState('')
  const [progress,setProgress]=useState<RepositoryProgress|null>(null)
  const [progressLog,setProgressLog]=useState<string[]>([])
  const [title,setTitle]=useState(''),[targetPath,setTargetPath]=useState(''),[command,setCommand]=useState(''),[environment,setEnvironment]=useState(''),[dataPath,setDataPath]=useState('')
  const [answers,setAnswers]=useState<Record<string,string>>({})
  const [condaEnvs,setCondaEnvs]=useState<CondaEnvironmentInfo[]>([])
  const [condaLoading,setCondaLoading]=useState(false)
  const [repositories,setRepositories]=useState<RepositoryCandidate[]>([])
  const [discovering,setDiscovering]=useState(false)
  const [browser,setBrowser]=useState<RepositoryDirectoryView|null>(null)
  const [browserOpen,setBrowserOpen]=useState(false)
  const [browserBusy,setBrowserBusy]=useState(false)
  const [browserError,setBrowserError]=useState('')
  const busyRef=useRef(false),initialized=useRef(false),snapshotScope=useRef('')
  const server=real.find(s=>s.id===serverId),accessRouteId=server?(routeId||getDefaultAccessRouteId(server)):''
  const scope=`${serverId}\n${accessRouteId}\n${path.trim()}`
  const flow=flows.find(item=>item.id===selectedId),guide=flow?.guide,task=props.tasks.find(t=>t.id===flow?.taskId)
  const run=task?.runs.find(r=>r.id===flow?.runId)??(!flow?.runId?task?.runs.find(r=>r.number===1):undefined)
  const questions=guide?repositoryReviewQuestions(guide):[]
  const selectedBytes=snapshot?snapshot.files.filter(file=>files.includes(file.path)).reduce((total,file)=>total+file.sizeBytes,0):0
  const condaMatched=!!environment&&condaEnvs.some(env=>env.name===environment)
  const dataNote=guide&&dataPath?guide.warnings.find(warning=>warning.startsWith('数据目录')&&warning.includes(dataPath)):undefined
  const stepVerification=(step:RepositoryGuideStep):string|undefined=>{
    if(step.environment&&condaEnvs.some(env=>env.name===step.environment))return `Conda 环境 ${step.environment} 已在服务器确认存在；依赖是否安装仍需确认`
    if(dataPath&&dataNote?.includes('已确认')&&/数据|下载|dataset|data/i.test(`${step.title} ${step.explanation} ${step.commands.join(' ')}`))return `数据目录 ${dataPath} 已确认存在`
    return undefined
  }
  const recentPaths=[...new Set([...flows.map(item=>item.input.path),...props.tasks.map(task=>task.codePath).filter((item):item is string=>!!item)])].slice(0,12)
  function fill(item:RepositoryWorkflowView):void {
    setSelectedId(item.id);setServerId(item.input.serverId);setRouteId(item.input.accessRouteId??'');setPath(item.input.path);setGoal(item.input.goal);setFiles(item.input.filePaths)
    if(item.guide){const g=item.guide;setSnapshot(g.snapshot);setTitle(g.summary.split(/[。\n]/)[0].slice(0,80)||'仓库实验');setTargetPath(g.snapshot.input.path.replace(/\/$/,'')+(g.workingDirectory?'/'+g.workingDirectory:'')||'/');setCommand(g.launchCommand);setEnvironment(g.environmentName);setDataPath(g.dataPath);setAnswers(Object.fromEntries(item.resolutions.map(r=>[r.question,r.answer])))}
  }
  useEffect(()=>{
    let live=true,revision=0
    const refresh=():void=>{const request=++revision;void window.labApi.intelligence.repositoryWorkflows().then(items=>{if(!live||request!==revision)return;setFlows(items);if(!initialized.current){initialized.current=true;const initial=props.initialTask;const item=initial?items.find(f=>f.taskId===initial.id||f.input.serverId===initial.serverId&&f.input.path===initial.codePath):undefined;if(item)fill(item)}}).catch(e=>{if(live)setError(e.message??String(e))})}
    refresh();const unsubscribe=window.labApi.intelligence.onRepositoryChanged(refresh)
    return()=>{live=false;unsubscribe()}
  },[])
  useEffect(()=>{
    const unsubscribe=window.labApi.intelligence.onRepositoryProgress(event=>{
      setProgress(event)
      setProgressLog(items=>[...items.slice(-7),event.message])
    })
    return unsubscribe
  },[])
  useEffect(()=>{
    let live=true
    setCondaEnvs([])
    setRepositories([])
    if(!server||server.mode!=='real'||!accessRouteId){setCondaLoading(false);return}
    setCondaLoading(true)
    void window.labApi.experiments.listCondaEnvironments(serverId,accessRouteId,'conda').then(result=>{
      if(!live)return
      if(result.status==='success')setCondaEnvs(result.value.environments)
    }).catch(()=>{if(live)setCondaEnvs([])}).finally(()=>{if(live)setCondaLoading(false)})
    return()=>{live=false}
  },[serverId,accessRouteId])
  useEffect(()=>{
    if(props.initialTask){setServerId(props.initialTask.serverId??'');setRouteId(props.initialTask.accessRouteId??'');setPath(props.initialTask.codePath);setGoal(props.initialTask.objective||props.initialTask.title);setSelectedId('');setSnapshot(null);setFiles([])}},[props.initialTask?.id])
  useEffect(()=>{if(flow?.taskId&&run&&!flow.busy&&!busy)void window.labApi.intelligence.actRepositoryWorkflow(flow.id,{kind:'sync'}).then(item=>setFlows(items=>[item,...items.filter(f=>f.id!==item.id)])).catch(e=>setError(e.message??String(e)))},[flow?.id,run?.id,run?.status])
  async function action(name:string,fn:()=>Promise<void>):Promise<void>{if(busyRef.current)return;busyRef.current=true;setBusy(name);setError('');try{await fn()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{busyRef.current=false;setBusy('')}}
  function fresh(clearFiles=true):void {setSelectedId('');setProgress(null);setProgressLog([]);if(clearFiles){setSnapshot(null);setFiles([]);snapshotScope.current=''}setError('')}
  async function act(input:RepositoryWorkflowAction,updateForm=false):Promise<RepositoryWorkflowView|undefined>{
    if(!flow)return
    const item=await window.labApi.intelligence.actRepositoryWorkflow(flow.id,input)
    setFlows(items=>[item,...items.filter(f=>f.id!==item.id)])
    if(updateForm)fill(item)
    if(item.error)throw new Error(item.error)
    return item
  }
  async function discover():Promise<void>{
    if(!server||!accessRouteId||discovering)return
    setDiscovering(true);setError('')
    try{
      const found=await window.labApi.intelligence.discoverRepositories({serverId,accessRouteId})
      setRepositories(found)
      if(!found.length)setError('未找到带 .git 或 README 的目录；请手动填写仓库路径，或确认仓库在更深层级。')
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{setDiscovering(false)}
  }
  async function openBrowser(): Promise<void>{
    setBrowserOpen(true);setBrowser(null);setBrowserError('')
    await browse(path.trim().startsWith('/')?path.trim():undefined)
  }
  async function browse(target?:string):Promise<void>{
    if(!server||!accessRouteId||browserBusy)return
    setBrowserBusy(true);setBrowserError('')
    try{const view=await window.labApi.intelligence.browseRepositoryDirectory({serverId,accessRouteId,path:target});setBrowser(view)}
    catch(e){setBrowserError(e instanceof Error?e.message:String(e))}
    finally{setBrowserBusy(false)}
  }
  async function inspect():Promise<{snapshot:RepositorySnapshot;files:string[]}>{
    const result=await window.labApi.intelligence.inspectRepository({source:'remote',serverId,path:path.trim(),accessRouteId})
    const selected=recommendRepositoryFiles(result.files,goal)
    setSnapshot(result);setFiles(selected);snapshotScope.current=scope
    if(!selected.length)throw new Error('此目录中没有可阅读的说明或入口文件，请确认仓库路径。')
    return {snapshot:result,files:selected}
  }
  async function analyze():Promise<void>{await action('analyze',async()=>{
    setProgress(null);setProgressLog([])
    const reading=snapshot&&snapshotScope.current===scope?{snapshot,files}:await inspect()
    if(!reading.files.length)throw new Error('请至少选择一个阅读文件。')
    const id=crypto.randomUUID();setSelectedId(id)
    const item=await window.labApi.intelligence.createRepositoryWorkflow({...reading.snapshot.input,filePaths:reading.files,goal:goal.trim()},id)
    setFlows(items=>[item,...items.filter(f=>f.id!==id)]);fill(item)
    if(item.error)throw new Error(item.error)
  })}
  async function review():Promise<void>{if(!guide)return;await action('review',async()=>{
    const root=guide.snapshot.input.path.replace(/\/$/,'')
    if(targetPath!==root&&targetPath!==(root||'/')&&!targetPath.startsWith(root+'/'))throw new Error('启动目录必须在当前仓库内；更换仓库请重新分析。')
    const relative=targetPath===(root||'/')?'':targetPath.slice(root.length+1)
    const resolutions=new Map(flow?.resolutions.map(r=>[r.question,r.answer])??[])
    for(const question of questions){
      const auto=repositoryFieldAnswer(question,{dataPath,environmentName:environment})
      resolutions.set(question,answers[question]?.trim()||auto)
    }
    await act({kind:'review',input:{launchCommand:command,workingDirectory:relative,environmentName:environment,dataPath,resolutions:[...resolutions].map(([question,answer])=>({question,answer}))}},true)
    props.notify('配置已保存，启动目录和入口已重新检查')
  })}
  async function save(force=false):Promise<void>{
    if(!flow||!guide)return
    await action(force?'save-force':'save',async()=>{const item=await act({kind:'save',title,force});if(item?.taskId){const saved=(await window.labApi.experiments.list()).find(t=>t.id===item.taskId);if(saved){props.onChanged(saved);props.onOpenTask(saved,undefined,true)}}})
  }
  const root=guide?.snapshot.input.path.replace(/\/$/,'')??''
  const expected=root+(guide?.workingDirectory?'/'+guide.workingDirectory:'')||'/'
  const dirty=!!guide&&(targetPath!==expected||command!==guide.launchCommand||environment!==guide.environmentName||dataPath!==guide.dataPath)
  const prepareIndices=guide?.steps.map((step,index)=>({step,index})).filter(item=>(item.step.role??'prepare')==='prepare').map(item=>item.index)??[]
  const preparePending=prepareIndices.some(index=>!flow?.confirmedSteps.includes(index))
  const allPrepared=!!flow&&prepareIndices.length>0&&prepareIndices.every(index=>flow.confirmedSteps.includes(index))
  const locked=!!busy||!!flow?.busy
  const stage=task?2:guide?1:0
  const reviewed=flow?.events.some(event=>event.message.startsWith('用户补充启动配置'))
  return <section className="repository-guide" aria-label="从仓库启动实验">
    <header className="repository-intro"><div><h2><BookOpen size={20}/>从仓库启动实验</h2><p>告诉我们代码在哪里、这次想跑什么，先得到一份有依据的最小启动方案。</p></div><button className="wb-text-button" onClick={props.onQuickPlan}>已有明确需求？使用快捷计划<ArrowRight size={14}/></button></header>
    <ol className="repository-stages" aria-label="启动步骤">{['选择仓库与目标','核对启动方案','到任务池运行'].map((label,index)=><li key={label} aria-current={stage===index?'step':undefined}><span>{index<stage?<CheckCircle2 size={15}/>:index+1}</span>{label}</li>)}</ol>
    {error&&<div className="intel-error" role="alert">{error}</div>}
    <div className="repository-launch-layout">
      <aside className="repository-input">
        <fieldset disabled={locked}>
          <label>服务器<select value={serverId} onChange={e=>{setServerId(e.target.value);setRouteId('');fresh()}}><option value="">选择实际服务器</option>{real.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label>
          {server&&<AccessRouteSelect server={server} value={accessRouteId} onChange={value=>{setRouteId(value);fresh()}}/>}
          <label>仓库目录<div className="repository-path-input"><input list="repository-recent-paths" maxLength={4096} value={path} onChange={e=>{setPath(e.target.value);fresh()}} placeholder="例如：/home/user/SASRec.pytorch"/><button type="button" className="secondary-button" disabled={!server||discovering} onClick={()=>void discover()}>{discovering?'扫描中…':'扫描'}</button><button type="button" className="secondary-button" disabled={!server||browserBusy} onClick={()=>void openBrowser()}>{browserBusy?'读取中…':'浏览'}</button></div><datalist id="repository-recent-paths">{recentPaths.map(item=><option key={item} value={item}/>)}</datalist></label>
          {repositories.length>0&&<div className="repository-repo-list"><p className="repository-note">扫描到 {repositories.length} 个候选仓库，点击填入：</p>{repositories.map(repo=><button type="button" key={repo.path} className="repository-repo" onClick={()=>{setPath(repo.path);fresh()}}><strong>{repo.name}</strong><span>{repo.path}</span></button>)}</div>}
          <label>这次想跑什么<textarea rows={4} maxLength={2000} value={goal} onChange={e=>{setGoal(e.target.value);fresh(false);if(snapshot)setFiles(recommendRepositoryFiles(snapshot.files,e.target.value))}} placeholder="例如：先用已有数据跑通一次 SASRec 训练，运行 1 个 epoch。"/></label>
          <button className="primary-button repository-analyze" disabled={!props.modelEnabled||!server||!path.trim().startsWith('/')||!goal.trim()} onClick={()=>void analyze()}>{busy==='analyze'?<LoaderCircle size={15} className="spin"/>:<BookOpen size={15}/>} {busy==='analyze'?'正在读取与分析…':guide?'重新分析启动方式':'分析启动方式'}</button>
          <p className="repository-note">自动读取仓库内的文本文件，说明、依赖与相关入口优先；单次分析最多发送约 30 万字符，超出部分会跳过并在结果中说明。本次已选 {files.length} 个文件，约 {formatBytes(selectedBytes)}。本次最多 4 次模型请求（侦察最多 3 次、生成方案 1 次），失败不自动重试；安装、下载和运行均由后续操作确认。</p>
          {busy==='analyze'&&progress&&<p className="repository-note repository-progress" role="status">{progress.round?`第 ${progress.round} 轮 · `:''}{progress.message}</p>}
          {!props.modelEnabled&&<button className="wb-text-button" onClick={props.onModelSettings}>先配置模型</button>}
          <details className="repository-reading"><summary>阅读范围{snapshot?` · 已选 ${files.length} / ${snapshot.files.length} 个文件 · 约 ${formatBytes(selectedBytes)}`:''}</summary><button className="secondary-button" disabled={!server||!path.trim().startsWith('/')} onClick={()=>void action('inspect',async()=>{fresh();await inspect()})}>{busy==='inspect'?'正在读取…':'读取或刷新文件清单'}</button>{snapshot&&<><p className="repository-note">默认选中全部文本文件；分析时模型会按需补读 README 引用的文件，取消勾选的文件不会发送给模型，也不会被自动补读。单次分析最多发送约 30 万字符。这里只列目录，不调用模型。</p>{snapshot.files.length>0&&<div className="repository-reading-actions"><button type="button" className="wb-text-button" onClick={()=>setFiles(snapshot.files.map(file=>file.path))}>全选</button><button type="button" className="wb-text-button" onClick={()=>setFiles([])}>清空</button></div>}<div className="repository-file-list">{snapshot.files.map(file=><label key={file.path}><input type="checkbox" checked={files.includes(file.path)} onChange={e=>{setFiles(items=>e.target.checked?[...items,file.path]:items.filter(p=>p!==file.path));setSelectedId('')}}/><span>{file.path}</span></label>)}</div>{snapshot.warnings.map((warning,index)=><p className="repository-note" key={index}>{warning}</p>)}</>}</details>
        </fieldset>
        {busy==='analyze'&&<button type="button" className="secondary-button" onClick={()=>void window.labApi.intelligence.cancelRepositoryWorkflow(selectedId).catch(error=>props.notify(String(error),'error'))}>取消分析</button>}
        {flows.length>0&&<details className="repository-saved"><summary>已保存的分析（{flows.length}）</summary><select aria-label="选择已有仓库分析" disabled={locked} value={selectedId} onChange={e=>{const item=flows.find(f=>f.id===e.target.value);if(item)fill(item);else fresh()}}><option value="">新建分析</option>{flows.map(item=><option key={item.id} value={item.id}>{item.input.goal.slice(0,36)} · {phases[item.phase]}</option>)}</select><button className="wb-text-button" disabled={locked} onClick={()=>fresh()}>新建分析</button></details>}
      </aside>
      <section className="repository-result" aria-label="启动方案">
        {!guide?<div className="repository-empty"><FileCode2 size={36}/><h3>{busy==='analyze'?'正在整理启动方式':'先明确这次要跑通的实验'}</h3>{busy==='analyze'&&progressLog.length>0?<ol className="repository-trace">{progressLog.map((message,index)=><li key={index}>{message}</li>)}</ol>:<p>分析后会给出启动命令、准备事项和缺少的信息。文件依据可以随时展开查看。</p>}{flow?.error&&<button className="secondary-button" disabled={locked} onClick={()=>void action('retry',async()=>{await act({kind:'retry'},true)})}>重新分析（会请求模型）</button>}</div>:<>
          <div className="repository-result-heading"><div><span className="repository-status">{flow?phases[flow.phase]:'待核对'}</span><h3>这次实验的启动方案</h3></div>{flow&&<p>{nextStep[flow.phase]}</p>}</div>
          <p className="repository-summary">{reviewed?'已保存你的补充。请核对下方启动配置，并完成准备事项。':guide.summary}</p>
          <div className="repository-evidence-status"><span>{guide.launchOrigin==='documented'?'启动命令来自已读文档':guide.launchOrigin==='user'?'启动命令由你补充':'启动命令需要人工核对'}</span><span>{guide.checks.some(check=>check.expected==='file'&&check.status==='confirmed')?'入口文件已找到':'入口文件待核对'}</span>{environment&&condaEnvs.length>0&&<span>{condaMatched?'Conda 环境已确认':'Conda 环境待核对'}</span>}{dataPath&&<span>{dataNote?.includes('已确认')?'数据目录已确认':'数据目录待核对'}</span>}{preparePending&&<span>准备事项待确认</span>}{guide.missingInputs.length>0&&<span title={guide.missingInputs.join('\n')}>待补充：{guide.missingInputs[0].slice(0,40)}{guide.missingInputs[0].length>40?'…':''}{guide.missingInputs.length>1?` 等 ${guide.missingInputs.length} 项`:''}</span>}</div>
          <fieldset className="repository-task-draft" disabled={locked||!!task}>
            <label>启动命令<textarea rows={3} value={command} onChange={e=>setCommand(e.target.value)} placeholder="尚未确定入口，请补充后检查配置"/></label>
            <Citations items={guide.launchCitations}/>
            <div className="repository-config-grid"><label>启动目录<input value={targetPath} onChange={e=>setTargetPath(e.target.value)}/></label><label>Conda 环境名（可选）<input list="repository-conda-envs" value={environment} onChange={e=>setEnvironment(e.target.value)} placeholder={condaLoading?'正在读取服务器环境…':condaEnvs.length?'选择或填写环境名':'不确定时留空，在任务池核对'}/><datalist id="repository-conda-envs">{condaEnvs.map(env=><option key={env.prefix} value={env.name}>{env.prefix}</option>)}</datalist></label></div>
            {condaEnvs.length>0&&<p className="repository-note">已从服务器读取 {condaEnvs.length} 个 Conda 环境{environment?(condaMatched?'；当前环境已确认存在。':'；当前环境名未在服务器找到，请核对。'):'，可直接选择'}；仍需在任务池核对。</p>}
            <label>数据目录（可选）<input value={dataPath} onChange={e=>setDataPath(e.target.value)} placeholder="服务器上的实际数据目录"/></label>
            {dataNote&&<p className="repository-note">{dataNote}</p>}
            <details className="repository-title"><summary>任务名称</summary><label>任务名称<input maxLength={160} value={title} onChange={e=>setTitle(e.target.value)}/></label></details>
            {questions.length>0&&<section className="repository-missing"><h4>还需要你补充</h4>{questions.map(question=><label key={question}>{question}<textarea rows={2} maxLength={1200} value={answers[question]??repositoryFieldAnswer(question,{dataPath,environmentName:environment})} onChange={e=>setAnswers(values=>({...values,[question]:e.target.value}))}/></label>)}</section>}
            {(!task&&(dirty||guide.status==='needs_info'))&&<div className="repository-review-action"><button className="secondary-button" disabled={!command.trim()} onClick={()=>void review()}>{busy==='review'?'正在核对…':'检查并保存配置'}</button><p className="repository-note">核对启动目录和入口文件，不请求模型。{dirty?' 配置有修改，需要重新核对。':''}</p></div>}
          </fieldset>
          {guide.steps.filter(step=>(step.role??'prepare')==='prepare').length>0&&<section className="repository-preparation"><h3>启动前需要完成 <button type="button" className="wb-text-button" style={{marginLeft:12,fontSize:12}} disabled={locked||!!task||dirty||guide.status==='needs_info'||!prepareIndices.length} onClick={()=>void action('steps',async()=>{await act({kind:'steps',confirmed:!allPrepared})})}>{allPrepared?'撤销全部确认':'全部确认（我已完成）'}</button></h3><p className="repository-note">以下操作由你在服务器完成。勾选表示你的确认，不代表平台已执行或验证。</p>{guide.steps.map((step,index)=>(step.role??'prepare')!=='prepare'?null:<article className="repository-step" key={index}><label className="repository-step-confirm"><input type="checkbox" checked={!!flow?.confirmedSteps.includes(index)} disabled={locked||!!task||dirty||guide.status==='needs_info'} onChange={e=>void action('step',async()=>{await act({kind:'step',index,confirmed:e.target.checked})})}/><strong>{step.title}</strong></label><p>{step.explanation}</p><p className="repository-note">目录：{guide.snapshot.input.path}{step.workingDirectory?'/'+step.workingDirectory:''}；环境：{step.environment||'未确认'}；{step.origin==='documented'?'文档中已有的操作':'AI 建议，请核对'}</p>{stepVerification(step)&&<p className="repository-note repository-verified">✓ {stepVerification(step)}</p>}{step.commands.map((line,i)=><pre key={i}><code>{line}</code></pre>)}<Citations items={step.citations}/></article>)}</section>}
          {task?<div className="repository-workflow-handoff"><button className="primary-button" onClick={()=>props.onOpenTask(task,flow?.runId)}>打开任务{flow?.runId?'与运行':''}<ArrowRight size={15}/></button>{flow?.phase==='failed'&&flow.runId&&<button className="secondary-button" onClick={()=>props.onDiagnose(task,flow.runId)}>诊断这次失败运行</button>}<button className="wb-text-button" disabled={locked} onClick={()=>void action('sync',async()=>{await act({kind:'sync'})})}>同步任务状态</button></div>:<div className="repository-save"><div className="repository-save-actions"><button className="primary-button" disabled={locked||guide.status!=='ready_for_review'||dirty||preparePending||!title.trim()} onClick={()=>void save()}>保存并选择 GPU<ArrowRight size={15}/></button>{guide.status==='needs_info'&&<button className="secondary-button" disabled={locked||dirty||preparePending||!command.trim()||!title.trim()} onClick={()=>void save(true)}>仍然保存为草稿</button>}</div><p>{guide.status==='needs_info'?'先补齐信息并检查配置；也可以先保存草稿，待确认项会写入任务备注。':dirty?'先检查修改后的配置。':preparePending?'完成并确认上方准备事项后，即可保存。':'保存后直接打开 GPU 选择；确认入队后才会运行。'}</p></div>}
          <details className="repository-excerpts"><summary>查看核对结果、用量与阅读依据</summary><ModelUsageLine usage={guide.usage}/>{reviewed&&<p>最初分析：{guide.summary}</p>}{guide.checks.map((check,index)=><p key={index}>{check.expected==='file'?'入口文件':'启动目录'} {check.path}：{check.message}</p>)}{[...guide.snapshot.warnings,...guide.warnings,...guide.questions].map((warning,index)=><p key={index}>{warning}</p>)}{guide.snapshot.excerpts.map(file=><details key={`${file.path}-${file.startLine}`}><summary>{file.path}:{file.startLine}{file.truncated?' · 部分内容':''}</summary><pre>{file.text.split('\n').map((line,index)=>`${file.startLine+index}: ${line}`).join('\n')}</pre></details>)}<ol>{flow?.events.map((event,index)=><li key={index}>{new Date(event.at).toLocaleString('zh-CN')} · {event.message}</li>)}</ol></details>
        </>}
      </section>
    </div>
    {browserOpen&&<div className="app-modal-overlay" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget&&!browserBusy)setBrowserOpen(false)}}>
      <section className="app-modal repository-browser" role="dialog" aria-modal="true" aria-label="浏览服务器目录">
        <header className="dialog-header app-modal-header"><div className="dialog-title-wrap app-modal-title"><div className="dialog-icon"><FolderOpen size={19}/></div><div><h2>选择仓库目录</h2><p>{browser?.path??'正在读取服务器目录'}</p></div></div><button type="button" className="icon-button" onClick={()=>setBrowserOpen(false)} disabled={browserBusy} aria-label="关闭">×</button></header>
        <div className="repository-browser-body">
          {browserBusy?<p className="repository-note">正在读取目录…</p>:browserError?<div><p className="intel-error" role="alert">{browserError}</p><button type="button" className="secondary-button" onClick={()=>void browse()}>回到主目录</button></div>:browser?<>
            <div className="repository-browser-path"><code>{browser.path}</code><div><button type="button" className="wb-text-button" disabled={browserBusy} onClick={()=>void browse(browser.home)}>主目录</button>{browser.parent&&<button type="button" className="wb-text-button" disabled={browserBusy} onClick={()=>void browse(browser.parent??undefined)}>上一级</button>}</div></div>
            <div className="repository-browser-list">{browser.entries.map(entry=><button type="button" key={entry.path} className="repository-browser-entry" onClick={()=>void browse(entry.path)}><FolderOpen size={14}/><span>{entry.name}</span></button>)}{browser.entries.length===0&&<p className="repository-note">没有子目录</p>}</div>
          </>:null}
        </div>
        <footer className="dialog-footer app-modal-footer"><button type="button" className="secondary-button" onClick={()=>setBrowserOpen(false)} disabled={browserBusy}>取消</button><button type="button" className="primary-button" disabled={!browser||browserBusy} onClick={()=>{if(browser){setPath(browser.path);setBrowserOpen(false);fresh()}}}>选择此目录</button></footer>
      </section>
    </div>}
  </section>
}
