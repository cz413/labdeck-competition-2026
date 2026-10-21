import { AccessRouteSelect } from './AccessRouteSelect'
import { getDefaultAccessRouteId } from '@shared/access-routes'
import { ModelUsageLine } from './ModelUsageLine'
import type { ExternalExperimentContext } from '@shared/external-experiment'
import { externalExperimentSchema } from '@shared/external-experiment'
import { ExternalExperimentForm, ExternalExperimentDraft } from './ExternalExperimentDiagnosis'
import { IntelligenceOverview } from './IntelligenceOverview'
import { useEffect, useRef, useState } from 'react'
import { Activity, ArrowRight, CheckCircle2, FileDown, FlaskConical, FolderOpen, LoaderCircle, RefreshCw, Search, Settings2, ShieldCheck } from 'lucide-react'
import type { DiagnosisProgress, DiagnosisReport, ExperimentPlan, ModelSettings } from '@shared/intelligence'
import type { ExperimentTask, ServerProfile, CondaEnvironmentInfo } from '@shared/types'
import type { ConfirmationRequest } from './ConfirmDialog'
import { RepairClosurePanel } from './RepairClosurePanel'
import type { IntelligenceRequest } from '@shared/experiment-workflow'
import type { DemoWorkflow } from '@shared/demo-workflow'
import './intelligence.css'
import { ResearchPage } from './ResearchPage'
import { RepositoryGuidePage } from './RepositoryGuidePage'

type Tab = 'plan' | 'overview' | 'repository' | 'diagnosis' | 'model' | 'demo' | 'research'
interface Props { tasks: ExperimentTask[]; servers: ServerProfile[]; onChanged: (task: ExperimentTask) => void; onOpenTask: (task: ExperimentTask, runId?: string, start?: boolean) => void; request?: IntelligenceRequest | null; onRequestHandled?(): void; demo?: DemoWorkflow | null; onStartDemo?(): void; onDemoDiagnose?(taskId: string, runId: string): DiagnosisReport; onDemoRetry?(reportId: string): DiagnosisReport; notify: (message: string, kind?: 'success'|'error') => void; confirm: (request: ConfirmationRequest) => Promise<boolean> }
const sourceNames = {remote:'任务池运行',external:'服务器日志',pasted:'粘贴日志',sample:'示例日志'}
const confidenceNames = {high:'明确错误信号',medium:'需要进一步验证',low:'证据不足'}

export function IntelligencePage(props: Props): React.JSX.Element {
  const [tab,setTab]=useState<Tab>('overview')
  const [settings,setSettings]=useState<ModelSettings>({enabled:false,endpoint:'http://127.0.0.1:11434/v1',model:'',hasApiKey:false})
  const [apiKey,setApiKey]=useState('')
  const [clearKey,setClearKey]=useState(false)
  const [busy,setBusy]=useState('')
  const activeDiagnosis=useRef<string|null>(null)
  const [progress,setProgress]=useState<DiagnosisProgress|null>(null)
  const [stopping,setStopping]=useState(false)
  const [error,setError]=useState('')
  const [history,setHistory]=useState<DiagnosisReport[]>([])
  const [historyReady,setHistoryReady]=useState(false)
  const [repositoryTaskId,setRepositoryTaskId]=useState('')
  const [researchTaskId,setResearchTaskId]=useState('')
  const [researchCampaignId,setResearchCampaignId]=useState('')
  const allHistory=[...(props.demo?.reports??[]),...history]
  const isDemoReport=(id:string):boolean=>!!props.demo?.reports.some(r=>r.id===id)
  const [report,setReport]=useState<DiagnosisReport|null>(null)
  useEffect(()=>setRetryWithModel(false),[report?.id])
  const [source,setSource]=useState<'remote'|'external'|'pasted'|'sample'>('remote')
  const [externalContext,setExternalContext]=useState<ExternalExperimentContext>({serverId:props.servers.find(server=>server.mode==='real')?.id??'',logPath:'',codePath:'',launchCommand:'',environmentName:''})
  const [sample,setSample]=useState<'oom'|'dependency'|'path'>('oom')
  const [taskId,setTaskId]=useState('')
  const [runId,setRunId]=useState('')
  const [logText,setLogText]=useState('')
  const [useModel,setUseModel]=useState(false)
  const [forceDiagnosis,setForceDiagnosis]=useState(false)
  const [diagnosticDepth,setDiagnosticDepth]=useState<'quick'|'inspect'>('quick')
  const [retryWithModel,setRetryWithModel]=useState(false)
  const [selectedEvidence,setSelectedEvidence]=useState<string|null>(null)
  const [planSourceTaskId,setPlanSourceTaskId]=useState('')
  const planSourceTask=props.tasks.find(t=>t.id===planSourceTaskId)
  const [intent,setIntent]=useState('')
  const [serverId,setServerId]=useState('')
  const [planRouteId,setPlanRouteId]=useState('')
  const planServer=props.servers.find(s=>s.id===serverId)
  const [useReadme,setUseReadme]=useState(false)
  const [readmeStatus,setReadmeStatus]=useState<'idle'|'loading'|'found'|'manual'>('idle')
  const [manualReadmeChecked,setManualReadmeChecked]=useState(false)
  const [manualReadmeBusy,setManualReadmeBusy]=useState(false)
  const [manualReadmeMessage,setManualReadmeMessage]=useState('')
  const manualReadmeRequest=useRef(0)
  const [readmePath,setReadmePath]=useState('')
  const [codePath,setCodePath]=useState('')
  const [environmentName,setEnvironmentName]=useState('')
  const [planEnvs,setPlanEnvs]=useState<CondaEnvironmentInfo[]>([])
  const [planConnection,setPlanConnection]=useState<'idle'|'connecting'|'success'|'failed'>('idle')
  const [connectionMessage,setConnectionMessage]=useState('')
  const [envLoading,setEnvLoading]=useState(false)
  const [,setEnvError]=useState('')
  const [condaAdvanced,setCondaAdvanced]=useState(false)
  const [condaDirectory,setCondaDirectory]=useState('')
  const [resolvedCondaPath,setResolvedCondaPath]=useState('')
  const [envReload,setEnvReload]=useState(0)
  const previousEnvTarget=useRef('')
  const verifiedPlanTarget=useRef('')
  const envRouteId=planServer?(planRouteId||getDefaultAccessRouteId(planServer)):''
  useEffect(()=>{
    let live=true
    let connected=false
    const target=serverId+':'+envRouteId
    const checkConnection=verifiedPlanTarget.current!==target
    if(checkConnection){setPlanConnection('idle');setConnectionMessage('')}
    if(previousEnvTarget.current&&previousEnvTarget.current!==target)setEnvironmentName('')
    previousEnvTarget.current=target
    setPlanEnvs([]);setEnvError('');setEnvLoading(false);setResolvedCondaPath('')
    if(!planServer||planServer.mode!=='real'||!envRouteId)return
    const directory=condaDirectory.trim().replace(/\/+$/,'')
    if(directory&&(!directory.startsWith('/')||/[\0\r\n]/.test(directory))){setEnvError('请填写服务器上的 Conda 安装目录绝对路径');return}
    setEnvLoading(true)
    if(checkConnection)setPlanConnection('connecting')
    const connectionCheck=checkConnection?window.labApi.servers.test(serverId,envRouteId):Promise.resolve({status:'success' as const,message:''})
    void connectionCheck.then(async connection=>{
      if(!live)return null
      if(connection.status!=='success')throw new Error(connection.message||'请先在资源页检查连接并确认主机指纹')
      connected=true;verifiedPlanTarget.current=target;setPlanConnection('success');setConnectionMessage('')
      return window.labApi.experiments.listCondaEnvironments(serverId,envRouteId,'conda',directory?directory+'/bin/conda':undefined)
    }).then(result=>{
      if(!result)return
      if(!live)return
      if(result.status==='host-key-required')throw new Error(result.message+'；请先在资源页确认主机指纹，再重新读取。')
      setResolvedCondaPath(result.value.managerPath);setPlanEnvs(result.value.environments);if(!result.value.environments.length)setCondaAdvanced(true)

    }).catch(error=>{if(live){if(!connected){setPlanConnection('failed');setConnectionMessage(error instanceof Error?error.message:String(error))}else{setEnvError('未能读取环境');setCondaAdvanced(true)}}}).finally(()=>{if(live)setEnvLoading(false)})
    return()=>{live=false}
  },[serverId,envRouteId,envReload])

  useEffect(()=>{
    let live=true
    manualReadmeRequest.current+=1;setManualReadmeChecked(false);setManualReadmeBusy(false);setManualReadmeMessage('')
    setReadmeStatus('idle');setReadmePath('')
    if(!useReadme||!serverId||!codePath.trim().startsWith('/')||planConnection!=='success')return
    setReadmeStatus('loading')
    const timer=setTimeout(()=>{void window.labApi.intelligence.detectReadme({serverId,accessRouteId:envRouteId,codePath:codePath.trim(),intent:'',environmentName:''}).then(result=>{
      if(!live)return
      if(result.status==='found'){setReadmePath(result.name??'');setReadmeStatus('found')}else setReadmeStatus('manual')
    }).catch(()=>{if(live)setReadmeStatus('manual')})},400)
    return()=>{live=false;clearTimeout(timer)}
  },[useReadme,serverId,envRouteId,codePath,planConnection])
  async function checkManualReadme():Promise<void>{
    const request=++manualReadmeRequest.current
    setManualReadmeBusy(true);setManualReadmeChecked(false);setManualReadmeMessage('')
    try{
      const result=await window.labApi.intelligence.detectReadme({serverId,accessRouteId:envRouteId,codePath:codePath.trim(),readmePath:readmePath.trim(),intent:'',environmentName:''})
      if(request!==manualReadmeRequest.current)return
      setManualReadmeChecked(result.status==='found')
      setManualReadmeMessage(result.status==='found'?'README 可读取':'无法读取，请检查路径、连接和文件权限。')
    }catch{if(request===manualReadmeRequest.current)setManualReadmeMessage('无法读取，请检查路径、连接和文件权限。')}
    finally{if(request===manualReadmeRequest.current)setManualReadmeBusy(false)}
  }
  const [plan,setPlan]=useState<ExperimentPlan|null>(null)
  const [savedTask,setSavedTask]=useState<ExperimentTask|null>(null)
  const chosenTask=props.tasks.find(t=>t.id===taskId)
  const chosenDemo=!!props.demo&&source==='remote'&&chosenTask?.id===props.demo.task.id
  const reportTask=props.tasks.find(t=>t.id===report?.taskId)
  const simulated=!!report&&isDemoReport(report.id)
  const runs=chosenTask?[...chosenTask.runs].reverse():[]
  const failedCount=props.tasks.filter(t=>t.runs.some(r=>r.status==='failed')).length
  const chosenEvidence=report?.evidence.find(e=>e.id===selectedEvidence)
  useEffect(()=>{
    let live=true
    void Promise.all([window.labApi.intelligence.settings(),window.labApi.intelligence.history()]).then(([config,reports])=>{if(live){setSettings(config);setHistory(reports);setHistoryReady(true)}}).catch(e=>{if(live){setHistoryReady(true);setError(String(e.message??e))}})
    const unsubscribe=window.labApi.intelligence.onDiagnosisProgress(update=>{if(live&&update.requestId===activeDiagnosis.current)setProgress(update)})
    const unsubscribeHistory=window.labApi.intelligence.onHistoryChanged(()=>{void window.labApi.intelligence.history().then(reports=>{if(live){setHistory(reports);setReport(current=>current?({...reports.find(r=>r.id===current.id)??current,...(current.cacheHit?{cacheHit:true}:{} )}):current)}}).catch(e=>{if(live)setError(String(e.message??e))})})
    return()=>{live=false;unsubscribe();unsubscribeHistory();if(activeDiagnosis.current)void window.labApi.intelligence.cancelDiagnosis(activeDiagnosis.current)}
  },[])
  const previousDemoReports=useRef(new Set<string>())
  useEffect(()=>{
    const currentIds=new Set(props.demo?.reports.map(r=>r.id)??[])
    const previousIds=previousDemoReports.current
    setReport(current=>current&&previousIds.has(current.id)?props.demo?.reports.find(r=>r.id===current.id)??null:current)
    previousDemoReports.current=currentIds
    if(taskId&&!props.tasks.some(t=>t.id===taskId)){setTaskId('');setRunId('')}
  },[props.demo?.reports,props.demo?.task.id])
  useEffect(()=>{
    const request=props.request
    if(!request)return
    if(request.reportId&&!allHistory.some(r=>r.id===request.reportId)&&!historyReady)return
    const destination=request.tab==='plan'?'repository':request.tab==='closure'?'diagnosis':request.tab
    setTab(destination);setError('');setSelectedEvidence(null)
    document.querySelector('.workbench-page')?.scrollTo({top:0})
    const task=props.tasks.find(t=>t.id===request.taskId)
    if(destination==='repository')setRepositoryTaskId(task?.id??'')
    if(request.tab==='plan'&&task){
      setPlanRouteId(task.accessRouteId??'');setReadmePath('');setServerId(task.serverId??'');setCodePath(task.codePath);setEnvironmentName(task.condaEnvironment?.environmentName??'')
      setIntent(`${task.objective||task.title}\n参考启动配置：${task.launchCommand||task.scriptPath||'尚未填写'}\n请生成一个新的任务草稿。`)
      setPlanSourceTaskId(task.id);setPlan(null);setSavedTask(null)
    }
    if(destination==='research'){setResearchTaskId(task?.id??'');setResearchCampaignId(request.campaignId??'')}
    if(destination==='diagnosis'){
      if(task){setSource('remote');setTaskId(task.id);setRunId(request.runId??[...task.runs].reverse().find(run=>run.status==='failed')?.id??task.runs.at(-1)?.id??'');if(task.id===props.demo?.task.id)setUseModel(false)}
      if(request.reportId){
        const selected=allHistory.find(r=>r.id===request.reportId)
        setReport(selected??null)
        if(selected?.externalContext){setSource('external');setExternalContext(selected.externalContext)}
        else if(selected?.source==='pasted'){setSource('pasted');setLogText(selected.logExcerpt)}
        if(selected?.taskId){setSource('remote');setTaskId(selected.taskId);setRunId(selected.runId??'');if(isDemoReport(selected.id))setUseModel(false)}
        if(!selected)setError('该诊断已不在最近 100 份历史中')
      }else setReport(null)
    }
    props.onRequestHandled?.()
  },[props.request?.id,historyReady,history,props.demo?.reports])
  function openLinkedRun(runId?:string):void{
    if(!reportTask||!runId||!reportTask.runs.some(r=>r.id===runId)){setError('关联任务或运行已被删除');return}
    props.onOpenTask(reportTask,runId)
  }
  async function action(name:string,fn:()=>Promise<void>):Promise<void>{
    if(busy)return
    setBusy(name);setError('')
    try{await fn()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy('')}
  }
  async function refreshHistory():Promise<void>{const reports=await window.labApi.intelligence.history();setHistory(reports);setReport(current=>current?({...reports.find(r=>r.id===current.id)??current,...(current.cacheHit?{cacheHit:true}:{} )}):current)}
  function openReport(id:string):void {
    const next=allHistory.find(r=>r.id===id)
    if(!next){setError('该诊断已不在最近 100 份历史中');return}
    setReport(next);setTab('diagnosis');setSelectedEvidence(null);setError('')
    if(next.externalContext){setSource('external');setExternalContext(next.externalContext)}
    else if(next.source==='remote'){setSource('remote');setTaskId(next.taskId??'');setRunId(next.runId??'');if(isDemoReport(next.id))setUseModel(false)}
    else if(next.source==='pasted'){setSource('pasted');setLogText(next.logExcerpt)}
    else setSource('sample')
  }
  function openExisting(task?:ExperimentTask,selectedRunId?:string):void {
    const selected=task??props.tasks.find(t=>!t.archived&&t.id!==props.demo?.task.id&&t.runs.some(r=>r.status==='failed'))
    setTab('diagnosis');setSource('remote');setTaskId(selected?.id??'')
    setRunId(selectedRunId??[...(selected?.runs??[])].reverse().find(r=>r.status==='failed')?.id??selected?.runs.at(-1)?.id??'')
    setReport(null);setSelectedEvidence(null);setError('');setForceDiagnosis(false)
  }
  function openLogSource(next:'external'|'pasted'):void {setTab('diagnosis');setSource(next);setReport(null);setSelectedEvidence(null);setError('');setForceDiagnosis(false)}

  async function diagnose():Promise<void>{
    await action('diagnosis',async()=>{
      if(chosenDemo){
        if(!chosenTask||!props.onDemoDiagnose)throw new Error('演示会话不可用')
        const selected=runId||chosenTask.runs.at(-1)?.id
        if(!selected)throw new Error('先模拟一次失败运行')
        setReport(props.onDemoDiagnose(chosenTask.id,selected));setSelectedEvidence(null);return
      }
      const input=source==='remote'?{taskId,runId:runId||undefined,useModel}:source==='external'?{external:externalContext,useModel}:source==='pasted'?{logText,useModel}:{sample,useModel}
      const requestId=crypto.randomUUID();activeDiagnosis.current=requestId;setStopping(false)
      setProgress({requestId,stage:'collect',message:'正在读取运行证据…'})
      try{
        const next=await window.labApi.intelligence.diagnose({...input,force:forceDiagnosis,depth:diagnosticDepth,requestId})
        setReport(next);setSelectedEvidence(null);if(next.cacheHit)props.notify('日志与输入配置未变化，已复用已有诊断，本次未调用模型');await refreshHistory()
      }finally{activeDiagnosis.current=null;setProgress(null);setStopping(false)}
    })
  }
  async function stopDiagnosis():Promise<void>{
    if(!activeDiagnosis.current||stopping)return
    setStopping(true)
    try{await window.labApi.intelligence.cancelDiagnosis(activeDiagnosis.current)}catch(e){setStopping(false);setError(e instanceof Error?e.message:String(e))}
  }
  async function retry():Promise<void>{
    if(!report?.repair)return
    const current=report
    if(isDemoReport(current.id)){
      const approved=await props.confirm({title:'确认模拟修复',message:'仅在临时演示数据中创建一次模拟排队，不执行命令、不连接服务器。',details:`原命令：${current.repair!.before}\n新命令：${current.repair!.after}`,confirmLabel:'确认模拟排队'})
      if(approved)await action('demo-retry',async()=>{if(!props.onDemoRetry)throw new Error('演示会话不可用');setReport(props.onDemoRetry(current.id))})
      return
    }
    const approved=await props.confirm({title:'确认修复并创建新运行',message:`会把 batch size 减半，在原服务器加入 GPU 队列，并自动跟踪运行状态。若仍失败，会生成${retryWithModel?'含一次模型分析的':'规则'}诊断；再次运行需要你确认。`,details:`服务器：${props.servers.find(s=>s.id===props.tasks.find(t=>t.id===current.taskId)?.serverId)?.name??'原运行服务器'}\n原命令：${current.repair!.before}\n新命令：${current.repair!.after}`,confirmLabel:'确认加入队列'})
    if(!approved)return
    await action('retry',async()=>{
      const task=await window.labApi.intelligence.retry(current.id,true,retryWithModel)
      props.onChanged(task);await refreshHistory()
      const reports=await window.labApi.intelligence.history()
      setReport(reports.find(r=>r.id===current.id)??current)
      props.notify('修复运行已加入队列，自动跟踪已启用')
    })
  }
  async function saveModel(test=false):Promise<void>{
    await action('model',async()=>{
      const result=await window.labApi.intelligence.saveSettings({enabled:settings.enabled,endpoint:settings.endpoint,model:settings.model,apiKey:apiKey||undefined,clearApiKey:clearKey})
      setSettings(result);setApiKey('');setClearKey(false)
      props.notify(test?await window.labApi.intelligence.testModel():'模型配置已保存')
    })
  }
  async function savePlan():Promise<void>{
    if(!plan)return
    const approved=await props.confirm({title:'保存实验任务草稿',message:'请核对脚本、参数和目录。保存后可在实验任务中检查配置并加入队列。',details:`代码目录：${plan.draft.codePath}\n启动命令：${plan.draft.launchCommand}`,confirmLabel:'保存草稿'})
    if(!approved)return
    await action('save-plan',async()=>{
      const selected=props.servers.find(s=>s.id===plan.draft.serverId)
      const task=await window.labApi.experiments.save({...plan.draft,id:undefined,status:'planned',accessRouteId:plan.draft.accessRouteId??(selected?getDefaultAccessRouteId(selected):undefined)})
      props.onChanged(task);setSavedTask(task);props.notify('实验草稿已保存')
    })
  }
  const taskOptions=props.tasks.filter(t=>t.runs.length>0&&(!t.archived||t.id===taskId)).sort((a,b)=>Number(b.runs.some(r=>r.status==='failed'))-Number(a.runs.some(r=>r.status==='failed'))||b.updatedAt.localeCompare(a.updatedAt))
  return <section className="intel-page">
    <header className="intel-heading"><div><h1><FlaskConical size={22}/>智能实验</h1><p>启动新实验、诊断已有失败运行，或围绕已有任务设计对照。</p></div><span className="intel-model-status"><i className={settings.enabled?'configured':''}/>{tab==='diagnosis'&&chosenDemo?'离线演示 · 不调用模型':settings.enabled?`模型：${settings.model}`:'模型未启用 · 规则诊断可用'}</span></header>
    <div className="intel-navigation"><nav className="intel-tabs" aria-label="智能实验功能"><button className={tab==='overview'?'active':''} onClick={()=>setTab('overview')}>概览</button><button className={tab==='repository'?'active':''} onClick={()=>setTab('repository')}><FolderOpen size={15}/>仓库启动</button><button className={tab==='diagnosis'?'active':''} onClick={()=>setTab('diagnosis')}><Search size={15}/>故障诊断</button><button className={tab==='research'?'active':''} onClick={()=>setTab('research')}><FlaskConical size={15}/>对照实验</button></nav><details className="intel-more"><summary>更多</summary><div><button onClick={e=>{e.currentTarget.closest('details')?.removeAttribute('open');setTab('model')}}><Settings2 size={14}/>模型设置</button><button onClick={e=>{e.currentTarget.closest('details')?.removeAttribute('open');setTab('demo')}}>演示模式</button></div></details></div>
    {(tab==='model'||tab==='demo')&&<button className="wb-text-button" onClick={()=>setTab('overview')}>返回智能实验</button>}
    {error&&<div className="intel-error" role="alert">{error}</div>}
    {tab==='overview'&&<IntelligenceOverview tasks={props.tasks} reports={allHistory} demoTaskId={props.demo?.task.id} historyReady={historyReady} onStart={()=>setTab('repository')} onExisting={()=>openExisting()} onExternal={()=>openLogSource('external')} onPaste={()=>openLogSource('pasted')} onFailure={openExisting} onReport={openReport} onTask={props.onOpenTask}/>}
    <div hidden={tab!=='repository'}><RepositoryGuidePage onQuickPlan={()=>setTab('plan')} servers={props.servers} modelEnabled={settings.enabled} initialTask={props.tasks.find(t=>t.id===repositoryTaskId)} tasks={props.tasks} onDiagnose={openExisting} onModelSettings={()=>setTab('model')} onChanged={props.onChanged} onOpenTask={props.onOpenTask} notify={props.notify}/></div>
    {tab==='diagnosis'&&<div className="intel-layout"><aside className="intel-input-column">
      <section className="intel-source"><h2>选择诊断来源</h2><div className="intel-source-switch">{(['remote','external','pasted','sample'] as const).map(s=><button key={s} disabled={!!busy} className={source===s?'active':''} onClick={()=>{setSource(s);setReport(null);setSelectedEvidence(null)}}>{sourceNames[s]}</button>)}</div>
        {source==='remote'?<><label>实验任务<select aria-label="诊断任务" disabled={!!busy} value={taskId} onChange={e=>{setTaskId(e.target.value);const task=props.tasks.find(t=>t.id===e.target.value);setRunId([...(task?.runs??[])].reverse().find(r=>r.status==='failed')?.id??task?.runs.at(-1)?.id??'');setReport(null);if(e.target.value===props.demo?.task.id)setUseModel(false)}}><option value="">选择有运行记录的任务</option>{taskOptions.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label><label>运行记录<select aria-label="诊断运行" disabled={!!busy} value={runId} onChange={e=>setRunId(e.target.value)}><option value="">选择具体运行</option>{runs.map(r=><option value={r.id} key={r.id}>第 {r.number} 次 · {r.status}</option>)}</select></label><p>{chosenDemo?'当前选择模拟任务：规则分析预设日志，不连接服务器、不调用模型。':'通过 SSH 读取运行日志。启用模型后，由模型选择后续检查。'}已有 {failedCount} 项任务包含失败运行。</p></>:source==='external'?<ExternalExperimentForm servers={props.servers} value={externalContext} disabled={!!busy} onChange={value=>{setExternalContext(value);setReport(null)}}/>:source==='pasted'?<><label>错误日志<textarea aria-label="错误日志" disabled={!!busy} value={logText} onChange={e=>setLogText(e.target.value)} rows={10} placeholder="粘贴 traceback 和错误附近的日志"/></label><p>粘贴日志只用于分析，不关联远程运行，也不会执行修复。</p></>:<><label>示例问题<select aria-label="示例问题" disabled={!!busy} value={sample} onChange={e=>setSample(e.target.value as typeof sample)}><option value="oom">CUDA 显存不足</option><option value="dependency">缺少 Python 依赖</option><option value="path">数据路径不存在</option></select></label><p className="intel-sample-note">示例日志用于体验诊断流程，不连接服务器，不代表真实实验结果。</p></>}
        <label className="intel-checkbox"><input type="checkbox" checked={chosenDemo?false:useModel} disabled={chosenDemo||!settings.enabled||!!busy} onChange={e=>setUseModel(e.target.checked)}/>启用模型诊断</label>{useModel&&!chosenDemo&&<><label>分析方式<select disabled={!!busy} value={diagnosticDepth} onChange={e=>setDiagnosticDepth(e.target.value as 'quick'|'inspect')}><option value="quick">快速分析 · 1 次模型请求</option><option value="inspect">深入检查 · 最多 4 轮 / 4 项只读检查</option></select></label><p>默认仅分析已有证据。深入检查由模型选择只读工具；脱敏结果会发送给所配置的模型。</p></>}
        <label className="intel-checkbox"><input type="checkbox" checked={forceDiagnosis} disabled={!!busy||chosenDemo} onChange={e=>setForceDiagnosis(e.target.checked)}/>强制重新分析（不复用原报告；启用模型时会再次请求）</label>
        <button className="primary-button intel-primary" disabled={!!busy||(source==='remote'&&(!taskId||!runId))||(source==='external'&&(!externalExperimentSchema.safeParse(externalContext).success||!props.servers.some(server=>server.id===externalContext.serverId&&server.mode==='real')))||(source==='pasted'&&!logText.trim())} onClick={()=>void diagnose()}>{busy==='diagnosis'?<LoaderCircle size={15} className="spin"/>:<Search size={15}/>} {busy==='diagnosis'?'正在收集与分析…':'收集证据并诊断'}</button>
        {busy==='diagnosis'&&<div className="intel-progress" role="status"><p>{stopping?'正在停止，保留已采集证据…':progress?.message??'正在分析…'}</p><button className="secondary-button" disabled={stopping} onClick={()=>void stopDiagnosis()}>{stopping?'正在停止…':'停止诊断'}</button></div>}
      </section>
      <section className="intel-history"><header><h2>诊断记录</h2><span>{allHistory.length}</span></header>{allHistory.length===0?<p>完成一次诊断后，报告会保存在本机。</p>:allHistory.slice(0,20).map(item=><button key={item.id} disabled={!!busy} className={report?.id===item.id?'active':''} onClick={()=>openReport(item.id)}><strong>{item.findings[0]?.title??item.title}</strong><span>{isDemoReport(item.id)?'离线演示 · 模拟':sourceNames[item.source]} · {new Date(item.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</span></button>)}</section>
    </aside><div className="intel-report-column">
      {!report?<div className="intel-empty"><Search size={36}/><h2>先收集证据，再判断原因</h2><p>选择任务池中的具体运行、指定服务器现有日志，或粘贴错误日志。无需先创建任务或重跑，每个结论都应能回到日志证据。</p><div className="intel-flow"><span>日志与环境</span><ArrowRight size={14}/><span>原因与方案</span><ArrowRight size={14}/><span>新运行验证</span></div></div>:<article className="intel-report">
        <header className="intel-report-heading"><div><div className="intel-badges"><span>{simulated?'离线演示 · 模拟数据':sourceNames[report.source]}</span><span>{report.engine==='agent+rules'?'模型多轮诊断 + 规则':report.engine==='model+rules'?'模型 + 规则':'规则诊断'}</span></div><h2>{report.title}</h2><time>{new Date(report.createdAt).toLocaleString('zh-CN')}</time></div>{!simulated&&<button className="secondary-button" disabled={!!busy} onClick={()=>void action('export',async()=>{const path=await window.labApi.intelligence.exportReport(report.id);if(path)props.notify('诊断证据报告已导出')})}><FileDown size={14}/>导出</button>}</header>
        {report.taskId&&<div className="workflow-report-links"><span>{reportTask?.title??'关联任务已删除'}{reportTask?.runs.find(r=>r.id===report.runId)?.number?` · 第 ${reportTask.runs.find(r=>r.id===report.runId)!.number} 次运行`:''}</span><div><button className="secondary-button" disabled={!reportTask?.runs.some(r=>r.id===report.runId)} onClick={()=>openLinkedRun(report.runId)}>查看原运行</button>{report.retryRunId&&<button className="secondary-button" disabled={!reportTask?.runs.some(r=>r.id===report.retryRunId)} onClick={()=>openLinkedRun(report.retryRunId)}>查看修复运行</button>}</div></div>}
        {report.summary&&<p className="intel-summary">{report.summary}</p>}
        {report.investigation&&<section className="intel-investigation"><header><h3>检查过程</h3><span>{{completed:'已完成',partial:'部分完成',cancelled:'已停止',failed:'模型未完成'}[report.investigation.status]} · {report.investigation.rounds}/4 轮 · {report.investigation.inspections}/4 项检查</span></header><p>展示实际选择的检查和返回结果；点击证据可核对内容。</p><ol className="intel-trace">{report.investigation.trace.map((step,i)=><li key={i} className={`intel-trace-step ${step.status}`}><span className="intel-trace-round">{step.round>0?`第 ${step.round} 轮`:'准备'}</span><div><div className="intel-trace-label"><strong>{step.label}</strong><span>{{completed:'完成',failed:'未完成',unavailable:'不可用'}[step.status]}{step.elapsedMs>0?` · ${(step.elapsedMs/1000).toFixed(1)}s`:''}</span></div>{step.reason&&<p>{step.reason}</p>}{step.arguments&&Object.keys(step.arguments).length>0&&<code>{Object.entries(step.arguments).map(([key,value])=>`${key}: ${value}`).join(' · ')}</code>}<div className="intel-evidence-links">{step.evidenceIds.map(id=><button key={id} onClick={()=>setSelectedEvidence(id)}>{report.evidence.find(e=>e.id===id)?.label??id}</button>)}</div></div></li>)}</ol></section>}
        <div className="intel-findings">{report.findings.map((f,i)=><section className="intel-finding" key={`${f.category}-${i}`}><header><h3>{f.title}</h3><span className={`intel-confidence ${f.confidence}`}>{confidenceNames[f.confidence]}</span></header><p>{f.explanation}</p><div className="intel-evidence-links">{f.evidenceIds.map(id=><button key={id} onClick={()=>setSelectedEvidence(id)}>{report.evidence.find(e=>e.id===id)?.label??id}</button>)}</div><ol>{f.steps.map((s,j)=><li key={j}>{s}</li>)}</ol></section>)}</div>
        <section className="intel-evidence"><h3>证据记录 <span>{report.evidence.length} 条</span></h3>{chosenEvidence&&<div className="intel-highlight" role="status"><strong>{chosenEvidence.label}</strong><pre>{chosenEvidence.text}</pre></div>}<details open><summary>日志片段 · 行号相对于本片段</summary><pre className="intel-log">{report.logExcerpt?report.logExcerpt.split('\n').map((line,i)=><span key={i} className={selectedEvidence===`log-${i+1}`?'selected':''}><b>{i+1}</b>{line||' '}</span>):'没有采集到日志'}</pre></details>{report.evidence.filter(e=>e.source!=='log').map(e=><details key={e.id}><summary>{e.label}</summary><pre>{e.text}</pre></details>)}</section>
        {(report.useModel||report.cacheHit)&&<ModelUsageLine usage={report.usage} reused={report.cacheHit}/>}
        {report.source==='external'&&<ExternalExperimentDraft report={report} tasks={props.tasks} busy={!!busy} confirm={props.confirm} onSaved={props.onChanged} onOpenTask={props.onOpenTask} notify={props.notify}/>}
        {report.repair&&<section className="intel-repair"><header><ShieldCheck size={18}/><h3>可审查的修复方案</h3><span>batch size {report.repair.previousBatch} → {report.repair.nextBatch}</span></header><p>{simulated?'模拟参数调整与新运行；此处不会执行命令。':'仅调整本次启动参数，创建新的实验运行。脚本和原运行记录保持原样。'}</p><div className="intel-command-diff"><div><span>原命令</span><code>{report.repair.before}</code></div><div><span>新命令</span><code>{report.repair.after}</code></div></div>{!report.retryRunId?<><label className="intel-checkbox"><input type="checkbox" checked={retryWithModel} disabled={!!busy||simulated||!settings.enabled} onChange={e=>setRetryWithModel(e.target.checked)}/>再次失败时调用模型快速分析（最多 1 次；默认关闭）</label><button className="primary-button" disabled={!!busy} onClick={()=>void retry()}>审查并创建修复运行</button></>:<RepairClosurePanel report={report} simulated={simulated} onOpenRun={()=>openLinkedRun(report.retryRunId)} busy={!!busy} onCheck={()=>void action('verify',async()=>{await window.labApi.intelligence.verify(report.id);await refreshHistory()})} onToggle={enabled=>void action('tracking',async()=>{await window.labApi.intelligence.setTracking(report.id,enabled);await refreshHistory()})} onOpenDiagnosis={openReport}/>}</section>}
        {report.warnings.length>0&&<details className="intel-limitations" open><summary>证据范围与待确认事项</summary><ul>{report.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></details>}
      </article>}
    </div></div>}
    {tab==='plan'&&<header className="repository-quick-plan"><div><h2>快捷实验计划</h2><p>已明确要运行什么时，在这里生成配置草稿。需要先理解仓库时，从仓库分析开始。</p></div><button className="secondary-button" onClick={()=>setTab('repository')}>从仓库分析启动方式</button></header>}
    {tab==='plan'&&<div className="intel-plan-layout"><section className="intel-plan-input"><h2>描述要运行的实验</h2>{planSourceTask&&<p className="workflow-context">来源：{planSourceTask.title} · 保存为新草稿</p>}<p>模型生成任务草稿，保存前可修改参数；运行仍需在实验任务中明确加入队列。</p><label>目标服务器<select value={serverId} onChange={e=>{setServerId(e.target.value);setCondaDirectory('');setPlanRouteId('');setPlan(null);setSavedTask(null)}}><option value="" disabled hidden></option>{props.servers.filter(s=>s.id!==props.demo?.server.id).map(s=><option value={s.id} key={s.id}>{s.name}{s.mode==='demo'?'（演示，不能实际运行）':''}</option>)}</select></label>{planServer&&<AccessRouteSelect server={planServer} value={planRouteId||getDefaultAccessRouteId(planServer)} onChange={setPlanRouteId} showSingleRoute/>}{planServer&&<div role="status"><span>{planConnection==='connecting'?'连接中…':planConnection==='success'?'连接成功':planConnection==='failed'?'连接失败':'尚未连接'}</span>{planConnection==='failed'&&<><p>{connectionMessage}</p><button type="button" className="secondary-button" onClick={()=>{verifiedPlanTarget.current='';setEnvReload(value=>value+1)}}>重新连接</button></>}</div>}<label>Conda 环境<select style={{color:environmentName?undefined:'var(--text-muted, #9aa0a6)'}} value={environmentName} onChange={e=>setEnvironmentName(e.target.value)} disabled={!planServer||envLoading}><option value="" disabled hidden>{!planServer?'请先选择服务器':planConnection==='failed'?'请先连接服务器':planConnection==='connecting'?'等待服务器连接…':envLoading?'正在读取环境…':!planEnvs.length?'未找到环境，请手动指定安装目录':'选择环境'}</option>{environmentName&&!planEnvs.some(env=>env.name===environmentName)&&<option value={environmentName}>{environmentName}（来源任务配置，未验证）</option>}{planEnvs.map(env=><option key={env.prefix} value={env.name}>{env.name} · {env.prefix}</option>)}</select></label>{condaAdvanced&&(<label>Conda 安装目录<input value={condaDirectory} onChange={e=>setCondaDirectory(e.target.value)} placeholder="例如：/data/DataLACP/zhaogenghua/anaconda3"/></label>)}<button type="button" className="secondary-button" disabled={!planServer||planServer.mode!=='real'||envLoading} onClick={()=>setEnvReload(value=>value+1)}>{envLoading?'读取中…':'重新读取'}</button><label>代码目录<input value={codePath} onChange={e=>setCodePath(e.target.value)} placeholder="例如：/data/DataLACP/zhaogenghua/SASRec.pytorch/python"/></label><label>参考项目说明生成计划<select value={useReadme?'yes':'no'} onChange={e=>setUseReadme(e.target.value==='yes')}><option value="no">仅根据实验需求</option><option value="yes">结合 README 文档</option></select></label>{useReadme&&<>{readmeStatus==='idle'&&<p>请先连接服务器并填写代码目录。</p>}{readmeStatus==='loading'&&<p>正在查找 README…</p>}{readmeStatus==='found'&&<p>已找到 README：{readmePath}</p>}{readmeStatus==='manual'&&<label>未找到 README，请手动填写路径<input value={readmePath} onChange={e=>{setReadmePath(e.target.value);manualReadmeRequest.current+=1;setManualReadmeChecked(false);setManualReadmeBusy(false);setManualReadmeMessage('')}} placeholder="例如：/data/DataLACP/zhaogenghua/SASRec.pytorch/README.md"/><button type="button" className="secondary-button" disabled={manualReadmeBusy||!readmePath.trim()} onClick={()=>void checkManualReadme()}>{manualReadmeBusy?'检查中…':'检查路径'}</button>{manualReadmeMessage&&<span role="status">{manualReadmeMessage}</span>}</label>}</>}<label>实验需求<textarea rows={6} placeholder="例如：在 ml-1m 数据集上训练 SASRec，先运行 1 个 epoch，验证训练流程。" value={intent} onChange={e=>setIntent(e.target.value)} /></label><button className="primary-button" disabled={!!busy||!settings.enabled||!serverId||!codePath.trim()||!intent.trim()||(useReadme&&(readmeStatus==='idle'||readmeStatus==='loading'||!readmePath.trim()||(readmeStatus==='manual'&&!manualReadmeChecked)))} onClick={()=>void action('plan',async()=>{setPlan(null);setSavedTask(null);setPlan(await window.labApi.intelligence.plan({intent,serverId,codePath,environmentName,useReadme,readmePath:useReadme?readmePath:undefined,condaManagerPath:resolvedCondaPath||undefined,accessRouteId:planRouteId||(planServer?getDefaultAccessRouteId(planServer):undefined)}))})}>{busy==='plan'?<LoaderCircle size={14} className="spin"/>:<FlaskConical size={14}/>}生成执行计划</button>{!settings.enabled&&<p>先在模型设置中配置模型，再生成计划。</p>}</section><section className="intel-plan-output">{!plan?<div className="intel-empty"><FlaskConical size={36}/><h2>计划会在这里展开</h2><p>服务器和代码目录由你指定。生成结果需要检查，保存草稿不会启动任务。</p></div>:<><div className="intel-badges"><span>模型生成 · 尚未运行</span></div><h2>审查实验配置</h2><label>任务名称<input value={plan.draft.title} onChange={e=>{setSavedTask(null);setPlan({...plan,draft:{...plan.draft,title:e.target.value}})}}/></label><label>启动命令<textarea rows={3} value={plan.draft.launchCommand} onChange={e=>{setSavedTask(null);setPlan({...plan,draft:{...plan.draft,launchCommand:e.target.value}})}}/></label><label>数据目录<input value={plan.draft.dataPath} onChange={e=>{setSavedTask(null);setPlan({...plan,draft:{...plan.draft,dataPath:e.target.value}})}}/></label><label>最低空闲显存（GiB）<input type="number" min="1" max="1024" value={plan.draft.minimumFreeVramGiB??''} onChange={e=>{setSavedTask(null);setPlan({...plan,draft:{...plan.draft,minimumFreeVramGiB:e.target.value?Number(e.target.value):undefined}})}}/></label>{plan.assumptions.length>0&&<div className="intel-assumptions"><h3>保存前需要确认</h3><ul>{plan.assumptions.map((a,i)=><li key={i}>{a}</li>)}</ul></div>}<h3>运行前检查</h3><ul>{plan.checks.map((c,i)=><li key={i}>{c}</li>)}</ul>{savedTask?<button className="primary-button" onClick={()=>props.onOpenTask(savedTask)}><CheckCircle2 size={15}/>打开已保存的实验任务</button>:<button className="primary-button" disabled={!!busy||!plan.draft.title.trim()} onClick={()=>void savePlan()}>确认配置并保存草稿</button>}</>}</section></div>}
    {tab==='research'&&<ResearchPage tasks={props.tasks} servers={props.servers} modelEnabled={settings.enabled} initialTaskId={researchTaskId} initialCampaignId={researchCampaignId} onChanged={props.onChanged} onOpenTask={props.onOpenTask} onOpenDiagnosis={openReport} confirm={props.confirm} notify={props.notify}/>}
    {tab==='demo'&&<section className="intel-demo-entry"><h2>三分钟展示任务到状态确认</h2><p>不需要服务器或 API 密钥。载入一份预设计划，在原有任务栏和诊断页之间演示完整流程。</p><ol><li>查看预设实验配置，模拟第一次 CUDA 显存不足。</li><li>从任务的指定运行进入诊断，点击日志证据查看原因。</li><li>审查 batch size 32 → 16，确认创建模拟修复运行。</li><li>模拟修复开始，选择正常退出或再次失败；失败会关联新诊断。</li></ol><p>诊断使用现有规则引擎；计划、运行和退出码为预设或模拟数据，不展示真实模型推理、GPU 调度和训练效果。演示数据仅保留在当前窗口内，可随时重置或退出。</p><button className="primary-button" disabled={!!busy} onClick={props.onStartDemo}>{props.demo?'重新载入预设演示计划':'载入预设演示计划'}</button></section>}
    {tab==='model'&&<section className="intel-model-form"><h2>连接你的模型</h2><p>支持兼容 Chat Completions 的服务。密钥保存在参赛版的独立本地数据目录，并使用系统加密。</p><label className="intel-checkbox"><input type="checkbox" checked={settings.enabled} onChange={e=>setSettings({...settings,enabled:e.target.checked})}/>启用模型分析、实验计划与仓库启动助手</label><label>API 基础地址<input value={settings.endpoint} onChange={e=>setSettings({...settings,endpoint:e.target.value})} placeholder="https://模型服务地址/v1"/></label><p>填写基础地址，应用会追加 /chat/completions。本机服务可使用 HTTP。</p><label>模型名称<input value={settings.model} onChange={e=>setSettings({...settings,model:e.target.value})} placeholder="填写服务提供的模型 ID"/></label><label>API 密钥<input type="password" autoComplete="off" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder={settings.hasApiKey?'已保存密钥；留空保留':'本机无认证服务可留空'}/></label>{settings.hasApiKey&&<label className="intel-checkbox"><input type="checkbox" checked={clearKey} onChange={e=>setClearKey(e.target.checked)}/>清除已保存的密钥</label>}<div className="intel-model-actions"><button className="primary-button" disabled={!!busy} onClick={()=>void saveModel()}>保存模型配置</button><button className="secondary-button" disabled={!!busy||!settings.enabled} onClick={()=>void saveModel(true)}>{busy==='model'?<LoaderCircle size={14} className="spin"/>:<Activity size={14}/>}保存并测试连接</button></div><div className="intel-provider-note"><ShieldCheck size={18}/><p>诊断报告会标注实际使用的引擎。模型不可用或证据校验失败时保留规则结果，并说明原因。</p></div></section>}
  </section>
}

