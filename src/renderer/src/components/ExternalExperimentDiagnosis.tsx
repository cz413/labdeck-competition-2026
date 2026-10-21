import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { ExternalExperimentContext, ExternalDraftInput } from '@shared/external-experiment'
import { externalDraftSchema } from '@shared/external-experiment'
import type { DiagnosisReport } from '@shared/intelligence'
import type { ExperimentTask, ServerProfile } from '@shared/types'
import { getDefaultAccessRouteId } from '@shared/access-routes'
import { diagnoseEvidence, proposeBatchRepair } from '@shared/diagnosis-engine'
import { AccessRouteSelect } from './AccessRouteSelect'
import type { ConfirmationRequest } from './ConfirmDialog'

export function ExternalExperimentForm({servers,value,onChange,disabled}:{servers:ServerProfile[];value:ExternalExperimentContext;onChange(value:ExternalExperimentContext):void;disabled:boolean}):React.JSX.Element {
  const real=servers.filter(s=>s.mode==='real'),server=real.find(s=>s.id===value.serverId)
  return <fieldset className="external-experiment-form" disabled={disabled}>
    <p>接手在终端、脚本或其他工具中运行的实验。无需先创建任务，也不会执行下面填写的原命令。</p>
    <label>实验所在服务器<select value={value.serverId} onChange={e=>onChange({...value,serverId:e.target.value,accessRouteId:undefined})}><option value="">选择实际服务器</option>{real.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}</select></label>
    {server&&<AccessRouteSelect server={server} value={value.accessRouteId??getDefaultAccessRouteId(server)} onChange={accessRouteId=>onChange({...value,accessRouteId})}/>}
    <label>已有日志的绝对路径<input maxLength={4096} value={value.logPath} onChange={e=>onChange({...value,logPath:e.target.value})} placeholder="/home/user/project/nohup.out"/></label>
    <label>原代码 / 工作目录（可选）<input maxLength={4096} value={value.codePath} onChange={e=>onChange({...value,codePath:e.target.value})} placeholder="/home/user/project"/></label>
    <label>原启动命令（可选）<textarea rows={3} maxLength={20000} value={value.launchCommand} onChange={e=>onChange({...value,launchCommand:e.target.value})} placeholder="填写你当时运行的命令，仅作为诊断上下文"/></label>
    <label>运行时的 Conda 环境名（可选）<input maxLength={160} value={value.environmentName} onChange={e=>onChange({...value,environmentName:e.target.value})} placeholder="不清楚可留空"/></label>
    <p>在文件开头/末尾最多扫描 256 KiB，选取错误上下文和末尾状态，输出最多 64 KiB / 240 行。目录、命令和环境是你提供的上下文；日志片段不能证明进程已结束或属于哪一次运行。</p>
  </fieldset>
}
interface DraftProps {
  report:DiagnosisReport;tasks:ExperimentTask[];busy:boolean
  confirm(request:ConfirmationRequest):Promise<boolean>
  onSaved(task:ExperimentTask):void
  onOpenTask(task:ExperimentTask,runId?:string):void
  notify(message:string,kind?:'success'|'error'):void
}
export function ExternalExperimentDraft(props:DraftProps):React.JSX.Element|null {
  const context=props.report.externalContext
  const [draft,setDraft]=useState<ExternalDraftInput>({title:'已有实验重跑',codePath:'',launchCommand:'',environmentName:'',dataPath:''})
  const [saving,setSaving]=useState(false),[error,setError]=useState('')
  useEffect(()=>{if(context){setDraft({title:props.report.title.slice(0,130)+' · 重跑草稿',codePath:context.codePath,launchCommand:context.launchCommand,environmentName:context.environmentName,dataPath:''});setError('')}},[props.report.id])
  if(!context)return null
  const existing=props.tasks.find(t=>t.id===props.report.importedTaskId)
  const proposal=proposeBatchRepair(context.launchCommand,diagnoseEvidence(props.report.evidence).some(f=>f.category==='oom'))
  const valid=externalDraftSchema.safeParse(draft).success
  async function save():Promise<void> {
    if(!valid||saving||props.busy)return
    const accepted=await props.confirm({title:'保存已有实验的重跑草稿',message:'只创建一个待开始任务，不执行原命令、不修改原日志，也不伪造原失败运行。请核对配置，稍后在任务池确认入队。',details:`目录：${draft.codePath}\n环境：${draft.environmentName||'未指定'}\n命令：${draft.launchCommand}`,confirmLabel:'保存草稿并打开任务池'})
    if(!accepted)return
    setSaving(true);setError('')
    try {const task=await window.labApi.intelligence.saveExternalDraft(props.report.id,draft);props.onSaved(task);props.notify('重跑草稿已保存，请检查配置后确认入队');props.onOpenTask(task)}
    catch(e){setError(e instanceof Error?e.message:String(e))}finally{setSaving(false)}
  }
  return <section className="external-draft-panel">
    <h3>接入任务池继续实验</h3><p>本份诊断来自已有日志，没有对应的任务池运行。审核配置后可以创建重跑草稿，保留日志来源与诊断关联。</p>
    <dl><div><dt>原日志</dt><dd>{context.logPath}</dd></div><div><dt>采集时间</dt><dd>{props.report.externalLog?.collectedAt?new Date(props.report.externalLog.collectedAt).toLocaleString('zh-CN'):'未记录'}</dd></div><div><dt>原进程状态</dt><dd>未核验</dd></div></dl>
    {existing?<button className="secondary-button" disabled={props.busy} onClick={()=>props.onOpenTask(existing)}>打开已保存的任务：{existing.title}</button>:<>
      {props.report.importedTaskId&&<p>原草稿已删除，可以重新审查并保存。</p>}
      {error&&<div className="intel-error" role="alert">{error}</div>}
      <fieldset disabled={props.busy||saving}>
        <label>任务名称<input maxLength={160} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
        <label>服务器代码 / 工作目录<input maxLength={4096} value={draft.codePath} onChange={e=>setDraft({...draft,codePath:e.target.value})}/></label>
        <label>审核后的启动命令<textarea rows={3} maxLength={20000} value={draft.launchCommand} onChange={e=>setDraft({...draft,launchCommand:e.target.value})}/></label>
        {proposal&&<button className="secondary-button" onClick={()=>setDraft({...draft,launchCommand:proposal.after})}>带入可审查建议：batch size {proposal.previousBatch} → {proposal.nextBatch}</button>}
        <label>Conda 环境名（可选）<input maxLength={160} value={draft.environmentName} onChange={e=>setDraft({...draft,environmentName:e.target.value})}/></label>
        <label>数据目录（可选）<input maxLength={4096} value={draft.dataPath} onChange={e=>setDraft({...draft,dataPath:e.target.value})}/></label>
        {!valid&&<p>请填写服务器绝对工作目录及单条训练/评估启动命令。安装、下载、cd 和环境激活等准备步骤需先单独完成。</p>}
        <button className="primary-button" disabled={!valid} onClick={()=>void save()}>{saving&&<LoaderCircle size={14} className="spin"/>}保存重跑草稿</button>
      </fieldset>
    </>}
  </section>
}
