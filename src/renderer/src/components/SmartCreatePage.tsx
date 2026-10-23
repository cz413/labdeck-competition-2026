import { RemoteDirectoryPicker } from './RemoteDirectoryPicker'
import { CondaEnvironmentFields } from './CondaEnvironmentFields'
import type { PreparationView, PreparationSummary, PreparationEdit } from '@shared/preparation'
import { PreparationTimeline } from './PreparationTimeline'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, Circle, Code2, Database, FileCode2,
  FolderOpen, History, LoaderCircle, Play, RotateCcw, Save, Server, SlidersHorizontal, Sparkles, Trash2, Undo2, X
} from 'lucide-react'
import type { CondaEnvironmentConfig, CondaEnvironmentInfo, ExperimentTask, ExperimentTaskDraft, RemoteCondaResult, ServerProfile } from '@shared/types'
import type { RepositorySnapshot } from '@shared/repository-guide'
import { getAccessRoutes, getDefaultAccessRouteId } from '@shared/access-routes'
import { commandDataPath, syncCommandDataPath, projectConfigurationKey } from '@shared/project-task'
import type { ConfirmationRequest } from './ConfirmDialog'
import { AccessRouteSelect } from './AccessRouteSelect'
import {
  experimentDraftChanges, experimentModeFromGoal, markUserFields,
  planCommandConfig, planCommandEntry, planGaps, planModeLabels, planRootPath,
  planSourceLabels, resolvePlanGap,
  suggestPlanTitle, switchPlanMode, planLaunchCitations,
  type ExperimentMode, type ExperimentPlan, type PlanConflict, type PlanDataCandidate,
  type PlanField, type PlanFieldState, type PlanFields, type PlanGap, type PlanSource
} from '@shared/experiment-plan'
import './smart-create.css'

interface SmartSeed { serverId?: string; accessRouteId?: string; path?: string; goal?: string }
interface Props {
  active: boolean
  tasks: ExperimentTask[]
  servers: ServerProfile[]
  modelEnabled: boolean
  seed: SmartSeed | null
  onModelSettings(): void
  onExit(): void
  onManualCreate(): void
  onChanged(task: ExperimentTask): void
  onCreated(task: ExperimentTask, start: boolean): void
  onOpenTask(task: ExperimentTask): void
  onEditFullConfig(draft: ExperimentTaskDraft, apply: (draft: ExperimentTaskDraft) => void): void
  notify(message: string, kind?: 'success' | 'error'): void
  confirm(request: ConfirmationRequest): Promise<boolean>
  onTrusted(): Promise<void>
}

type Stage = 'start' | 'analyzing' | 'review'
interface HistoryEntry { id: number; label: string; at: string; before: { draft: ExperimentTaskDraft; mode: ExperimentMode; fields: PlanFields } }
interface BrowserState { mode: 'project' | 'data'; initialPath?: string }

const clonePlanState = (plan: ExperimentPlan): HistoryEntry['before'] => ({
  draft: structuredClone(plan.draft), mode: plan.mode, fields: structuredClone(plan.fields)
})
const sourceTitle = (source?: PlanSource): string => source ? planSourceLabels[source] : '待确认'

function SourceBadge({ state, label }: { state?: PlanFieldState; label?: string }): React.JSX.Element {
  const source = state?.source ?? 'suggested'
  return <span className={`smart-source ${source}`} title={state?.note}>{label ?? planSourceLabels[source]}</span>
}

export function SmartCreatePage(props: Props): React.JSX.Element {
  const realServers = useMemo(() => props.servers.filter(server => server.mode === 'real'), [props.servers])
  const initialServerId = props.seed?.serverId && realServers.some(server => server.id === props.seed?.serverId)
    ? props.seed.serverId : realServers[0]?.id ?? ''
  const [serverId, setServerId] = useState(initialServerId)
  const [routeId, setRouteId] = useState(props.seed?.accessRouteId ?? '')
  const [root, setRoot] = useState(props.seed?.path ?? '')
  const [goal, setGoal] = useState(props.seed?.goal ?? '')
  const [stage, setStage] = useState<Stage>('start')
  const [preparation,setPreparation]=useState<PreparationView|null>(null)
  const [sessions,setSessions]=useState<PreparationSummary[]>([])
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [syncError,setSyncError]=useState('')
  const [syncing,setSyncing]=useState(false)
  const preparationId=useRef<string|null>(null),preparationRevision=useRef(0)
  const lastSynced=useRef(''),pendingEdit=useRef<{edit:PreparationEdit;signature:string}|null>(null)
  const pumpPromise=useRef<Promise<void>|null>(null),analysisPending=useRef(false),fetchRevision=useRef(0)
  const live=useRef(true)

  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [plan, setPlan] = useState<ExperimentPlan | null>(null)
  const [initialPlan, setInitialPlan] = useState<ExperimentPlan | null>(null)
  const [savedTask, setSavedTask] = useState<ExperimentTask | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState<'draft' | 'start' | null>(null)
  const [busy, setBusy] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const [recheckResult, setRecheckResult] = useState<PreparationView['checks'] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [envs, setEnvs] = useState<CondaEnvironmentInfo[]>([])
  const [envLoading, setEnvLoading] = useState(false)
  const [envChecking, setEnvChecking] = useState(false)
  const environmentRequest = useRef(0)
  const [browser, setBrowser] = useState<BrowserState | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [conflicts, setConflicts] = useState<PlanConflict[]>([])
  const [deferredGaps, setDeferredGaps] = useState<string[]>([])
  const [refineText, setRefineText] = useState('')
  const [refining,setRefining]=useState(false)
  const latestPlan=useRef(plan);latestPlan.current=plan
  const [scopeOpen, setScopeOpen] = useState(false)
  const [dataCandidates, setDataCandidates] = useState<PlanDataCandidate[]>([])
  const revision = useRef(0)
  const historyId = useRef(0)
  const server = realServers.find(item => item.id === serverId)
  const accessRouteId = server ? (routeId && getAccessRoutes(server).some(route => route.id === routeId) ? routeId : getDefaultAccessRouteId(server)) : ''
  const recentProjects = useMemo(() => {
    const seen = new Set<string>()
    return props.tasks
      .filter(task => task.serverId && task.codePath && props.servers.some(server => server.id === task.serverId))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .filter(task => {
        const key = `${task.serverId}:${task.codePath}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, 8)
      .map(task => ({ serverId: task.serverId!, path: task.codePath, name: task.codePath.split('/').filter(Boolean).pop() ?? task.codePath, serverName: props.servers.find(item => item.id === task.serverId)?.name ?? '已移除服务器' }))
  }, [props.tasks, props.servers])
  const visibleRecent = recentProjects.filter(item => !serverId || item.serverId === serverId).slice(0, 5)
  const gaps = useMemo(() => plan ? planGaps(plan, { environments: envs, dataCandidates }).filter(gap => !deferredGaps.includes(gap.id)) : [], [plan, envs, dataCandidates, deferredGaps])
  const canAnalyze = Boolean(server && accessRouteId && root.trim().startsWith('/') && !/[\0\r\n]/.test(root) && goal.trim() && props.modelEnabled && !busy)
  const canSave = Boolean(server && plan && plan.draft.title.trim() && !saving && !envChecking && !envLoading && !busy && !deletingId)
  const linkedTaskId = preparation?.taskId ?? savedTask?.id
  const linkedTask = props.tasks.find(task => task.id === linkedTaskId || task.preparationId === preparationId.current)
  const taskDeleted = Boolean(linkedTaskId && !linkedTask)

  useEffect(() => {
    setServerId(initialServerId)
    setRouteId(props.seed?.accessRouteId ?? '')
    setRoot(props.seed?.path ?? '')
    setGoal(props.seed?.goal ?? '')
    preparationId.current=null;setPreparation(null);pendingEdit.current=null;lastSynced.current='';analysisPending.current=false
    setStage('start'); setSnapshot(null); setFiles([]); setPlan(null); setInitialPlan(null); setSavedTask(null)
    setDirty(false); setError(''); setHistory([]); setConflicts([]); setDeferredGaps([]); setDataCandidates([])
    setRecheckResult(null)
    // Seed changes mean a new preparation session from the resource page.
  }, [props.seed])
  useEffect(() => {
    if (stage === 'start' && (!serverId || !realServers.some(server => server.id === serverId)) && realServers[0]) setServerId(realServers[0].id)
  }, [realServers, serverId, stage])

  useEffect(()=>{
    live.current=true
    void refreshSessions()
    const unsubscribe=window.labApi.intelligence.preparations.onChanged(id=>{
      void refreshSessions()
      if(id!==preparationId.current)return
      const revision=++fetchRevision.current
      void window.labApi.intelligence.preparations.get(id).then(view=>{
        if(!live.current||id!==preparationId.current||revision!==fetchRevision.current)return
        setPreparation(view)
        if(analysisPending.current&&!view.busy){analysisPending.current=false;hydratePreparation(view)}
      }).catch(cause=>{if(live.current)setError(cause instanceof Error?cause.message:String(cause))})
    })
    return()=>{live.current=false;unsubscribe();revision.current++}
  },[])

  function currentEdit(value:ExperimentPlan):PreparationEdit{return {draft:value.draft,mode:value.mode,fields:value.fields,deferredGaps,conflicts,history}}
  async function refreshSessions():Promise<void>{try{const items=await window.labApi.intelligence.preparations.list();if(live.current)setSessions(items)}catch(cause){if(live.current)setSyncError(cause instanceof Error?cause.message:String(cause))}}
  function hydratePreparation(view:PreparationView):void{
    preparationId.current=view.id;preparationRevision.current=view.revision
    setPreparation(view);setServerId(view.input.serverId);setRouteId(view.input.accessRouteId);setRoot(view.input.path);setGoal(view.input.goal)
    setSnapshot(view.plan?.guide.snapshot??view.snapshot??null);setFiles(view.files);setEnvs(view.environments);setDataCandidates(view.dataCandidates)
    setPlan(view.plan??null);setInitialPlan(view.initialPlan??null);setSavedTask(view.task??null)
    setDirty(!!view.plan&&view.savedRevision!==view.revision);setStage(view.plan?'review':view.busy?'analyzing':'start');setBusy(view.busy&&!view.plan)
    setHistory(view.edit?.history??[]);setConflicts(view.edit?.conflicts??[]);setDeferredGaps(view.edit?.deferredGaps??[])
    setRecheckResult(view.checks??null);setError(view.error??'');setSyncError('')
    const edit=view.plan?{draft:view.plan.draft,mode:view.plan.mode,fields:view.plan.fields,deferredGaps:view.edit?.deferredGaps??[],conflicts:view.edit?.conflicts??[],history:view.edit?.history??[]}:null
    lastSynced.current=edit?JSON.stringify(edit):'';pendingEdit.current=null
    if(view.edit?.history.length)historyId.current=Math.max(...view.edit.history.map(item=>item.id))
  }
  async function pumpEdits():Promise<void>{
    if(pumpPromise.current)return pumpPromise.current
    const operation=(async()=>{
      if(live.current)setSyncing(true)
      try{
        while(pendingEdit.current&&preparationId.current){
          const pending=pendingEdit.current,id=preparationId.current
          pendingEdit.current=null
          if(pending.signature===lastSynced.current)continue
          try{
            const view=await window.labApi.intelligence.preparations.act(id,{kind:'edit',expectedRevision:preparationRevision.current,edit:pending.edit,label:pending.edit.history.at(-1)?.label||'修改实验配置'})
            if(view.error)throw new Error(view.error)
            if(preparationId.current!==id)return
            preparationRevision.current=view.revision;lastSynced.current=pending.signature
            if(live.current){setPreparation(view);setSyncError('')}
          }catch(cause){if(!pendingEdit.current)pendingEdit.current=pending;throw cause}
        }
      }finally{if(live.current)setSyncing(false)}
    })()
    pumpPromise.current=operation
    let succeeded=false
    try{await operation;succeeded=true}finally{pumpPromise.current=null;if(succeeded&&pendingEdit.current)void pumpEdits().catch(cause=>{if(live.current)setSyncError(cause instanceof Error?cause.message:String(cause))})}
  }
  async function flushEdits(edit?:PreparationEdit):Promise<void>{
    if(edit){const signature=JSON.stringify(edit);if(signature!==lastSynced.current)pendingEdit.current={edit,signature}}
    await pumpEdits()
    if(pendingEdit.current)await pumpEdits()
  }
  useEffect(()=>{
    if(!preparationId.current||!plan||stage!=='review'||analysisPending.current)return
    const edit=currentEdit(plan),signature=JSON.stringify(edit)
    if(signature===lastSynced.current)return
    pendingEdit.current={edit,signature}
    void pumpEdits().catch(cause=>{if(live.current)setSyncError(cause instanceof Error?cause.message:String(cause))})
  },[plan,history,conflicts,deferredGaps,stage])
  async function deletePreparation(item:PreparationSummary):Promise<void>{
    if(deletingId||busy||saving)return
    const confirmed=await props.confirm({title:'删除准备记录？',description:'此操作无法撤销',message:'将删除这条准备记录及其分析进度。\n实验池中的任务和服务器文件不受影响。',details:item.title,detailsLabel:'准备记录',confirmLabel:'删除记录',tone:'danger'})
    if(!confirmed)return
    setDeletingId(item.id)
    const active=preparationId.current===item.id
    try{
      if(active&&plan)await flushEdits(currentEdit(plan))
      if(active){preparationId.current=null;fetchRevision.current++}
      await window.labApi.intelligence.preparations.remove(item.id)
      if(active){resetSession();setStage('start');setSavedTask(null)}
      await refreshSessions()
      props.notify('实验准备记录已删除')
    }catch(cause){if(active)preparationId.current=item.id;props.notify(cause instanceof Error?cause.message:'无法删除准备记录','error')}
    finally{setDeletingId(null)}
  }
  async function resumePreparation(id:string):Promise<void>{
    try{
      if(plan)await flushEdits(currentEdit(plan))
      const view=await window.labApi.intelligence.preparations.get(id)
      hydratePreparation(view)
      if(view.busy){analysisPending.current=true;setStage('analyzing');setBusy(true);return}
      if(view.pending.length&&!view.pending.includes('wait')){
        analysisPending.current=true;setBusy(true);setStage(view.plan?'review':'analyzing')
        const resumed=await window.labApi.intelligence.preparations.act(id,{kind:'resume'})
        if(live.current){analysisPending.current=false;hydratePreparation(resumed)}
      }
    }catch(cause){setError(cause instanceof Error?cause.message:String(cause));setBusy(false)}
  }

  function resetSession(nextServerId = serverId, nextRoot = root): void {
    preparationId.current=null;setPreparation(null);pendingEdit.current=null;lastSynced.current='';analysisPending.current=false
    setSnapshot(null); setFiles([]); setPlan(null); setInitialPlan(null); setSavedTask(null)
    setDirty(false); setHistory([]); setConflicts([]); setDeferredGaps([]); setDataCandidates([])
    setError(''); setNotice(''); setScopeOpen(false); setRecheckResult(null)
    if (nextServerId !== serverId) setServerId(nextServerId)
    setRoot(nextRoot)
  }
  async function trustRemote<T>(request: () => Promise<RemoteCondaResult<T>>): Promise<T | null> {
    if (!server || !accessRouteId) return null
    let result = await request()
    for (let attempt = 0; attempt < 2 && result.status === 'host-key-required'; attempt += 1) {
      const targetName = result.hostKeyTarget === 'jumpHost' ? '跳板机' : '目标服务器'
      const trusted = await props.confirm({
        title: '信任 SSH 主机指纹？',
        message: `首次连接 ${server.name} 的${targetName}。请先通过可信渠道核对：\n\n${result.fingerprint}`,
        confirmLabel: '信任并继续'
      })
      if (!trusted) return null
      await window.labApi.servers.trustHost(server.id, result.fingerprint, result.hostKeyTarget, accessRouteId)
      await props.onTrusted()
      result = await request()
    }
    return result.status === 'success' ? result.value : null
  }
  function updateEnvironment(patch: Partial<CondaEnvironmentConfig>): void {
    if (!plan) return
    if ('manager' in patch || 'managerPath' in patch) { environmentRequest.current++; setEnvs([]) }
    updateDraft({condaEnvironment: {...(plan.draft.condaEnvironment ?? {manager: 'conda'}), ...patch}}, {field: 'environment', state: {source: 'user', note: '已手动配置运行环境'}})
  }
  async function loadEnvironments(): Promise<void> {
    if (!server || !accessRouteId || !plan?.draft.condaEnvironment) return
    const config = {...plan.draft.condaEnvironment}, id = ++environmentRequest.current, session = preparationId.current
    setEnvLoading(true)
    try {
      const value = await trustRemote(() => window.labApi.experiments.listCondaEnvironments(server.id, accessRouteId, config.manager, config.managerPath))
      if (!live.current || id !== environmentRequest.current || session !== preparationId.current) return
      setEnvs(value?.environments ?? [])
      if (value) {
        setPlan(current => current?.draft.condaEnvironment ? {...current, draft: {...current.draft, condaEnvironment: {...current.draft.condaEnvironment, managerPath: value.managerPath}}} : current)
        setDirty(true)
      }
    } catch {
      if (live.current && id === environmentRequest.current) setEnvs([])
    } finally {
      if (live.current && id === environmentRequest.current) setEnvLoading(false)
    }
  }
  useEffect(() => {
    if (plan?.draft.condaEnvironment && server && accessRouteId) void loadEnvironments()
    return () => { environmentRequest.current++; setEnvLoading(false); setEnvChecking(false) }
  }, [server?.id, accessRouteId, preparationId.current, !!plan, plan?.draft.condaEnvironment?.manager])
  async function checkEnvironment(): Promise<void> {
    if (!server || !accessRouteId || !plan?.draft.condaEnvironment) return
    const config = {...plan.draft.condaEnvironment}, id = ++environmentRequest.current, session = preparationId.current
    setEnvChecking(true)
    try {
      const checked = await trustRemote(() => window.labApi.experiments.checkCondaEnvironment(server.id, accessRouteId, config))
      if (!live.current || id !== environmentRequest.current || session !== preparationId.current || !checked) return
      setPlan(current => current?.draft.condaEnvironment ? {...current, draft: {...current.draft, condaEnvironment: {...config, managerPath: checked.managerPath ?? config.managerPath, lastCheckStatus: checked.found ? 'found' : 'missing', lastCheckedAt: new Date().toISOString(), pythonInterpreterPath: checked.pythonInterpreterPath, pythonVersion: checked.pythonVersion}}, fields: {...current.fields, environment: {source: checked.found ? 'server' : 'user', note: checked.found ? '已在服务器确认所选环境存在' : '未找到所选环境，请重新读取并选择'}}} : current)
      setDirty(true)
    } catch {
      if (live.current && id === environmentRequest.current) setNotice('暂时无法检查环境，请核对安装目录后重新读取。')
    } finally {
      if (live.current && id === environmentRequest.current) setEnvChecking(false)
    }
  }
  async function analyze(scope?:{snapshot:RepositorySnapshot;files:string[]}):Promise<void>{
    if(!server||!accessRouteId||!root.trim().startsWith('/')||!goal.trim()||!props.modelEnabled){setError('请填写项目与目标，并启用模型服务');return}
    if(plan){try{await flushEdits(currentEdit(plan))}catch(cause){setSyncError(String(cause));return}}
    const id=crypto.randomUUID(),token=++revision.current
    preparationId.current=id;preparationRevision.current=0;pendingEdit.current=null;lastSynced.current='';analysisPending.current=true
    setPreparation(null);setStage('analyzing');setBusy(true);setError('');setSyncError('');setNotice('');setPlan(null);setInitialPlan(null);setSavedTask(null);setHistory([]);setConflicts([]);setDeferredGaps([]);setScopeOpen(false)
    try{
      const view=await window.labApi.intelligence.preparations.create({serverId:server.id,accessRouteId,path:root.trim(),goal:goal.trim(),filePaths:scope?.files},id)
      if(live.current&&token===revision.current&&preparationId.current===id){analysisPending.current=false;hydratePreparation(view)}
    }catch(cause){if(live.current&&token===revision.current){setError(cause instanceof Error?cause.message:String(cause));setStage('start');setBusy(false);analysisPending.current=false}}
    finally{void refreshSessions()}
  }
  function cancelAnalysis():void{
    if(!preparationId.current)return
    setNotice('正在暂停；已完成的节点会保留。')
    void window.labApi.intelligence.preparations.cancel(preparationId.current).catch(cause=>setError(String(cause)))
  }
  function openBrowser(mode: 'project' | 'data'): void {
    const start = mode === 'data'
      ? (plan?.draft.dataPath.trim().startsWith('/') ? plan.draft.dataPath.trim() : root.trim().startsWith('/') ? root.trim() : undefined)
      : (root.trim().startsWith('/') ? root.trim() : undefined)
    setBrowser({ mode, initialPath: start })
  }
  function chooseBrowserPath(value: string): void {
    if (!browser) return
    if (browser.mode === 'project') {
      setRoot(value); resetSession(serverId, value)
    } else {
      if (!plan) return
      const patch: Partial<ExperimentTaskDraft> = { dataPath: value }
      const binding = commandDataPath(plan.draft.launchCommand)
      if (binding && binding.path !== value) patch.launchCommand = syncCommandDataPath(plan.draft.launchCommand, value)
      pushHistory(`数据目录设为 ${value}`)
      updateDraft(patch, { field: 'dataPath', state: { source: 'server', note: '目录已在服务器选择确认' } })
      if (binding) {
        setPlan(current => current ? { ...current, fields: { ...current.fields, launchCommand: { source: current.fields.launchCommand?.source ?? 'suggested', note: `数据参数已同步为 ${value}` } } } : current)
      }
      setDeferredGaps(items => items.filter(id => id !== 'data'))
      setNotice(`数据目录已设为 ${value}${binding ? '，并同步了命令中的数据参数' : ''}。`)
      void verifyDataPath(value)
    }
    setBrowser(null)
  }
  function updateDraft(patch: Partial<ExperimentTaskDraft>, field?: { field: PlanField; state: PlanFieldState }): void {
    setPlan(current => {
      if (!current) return current
      const next = { ...current, draft: { ...current.draft, ...patch } }
      if (field) next.fields = { ...current.fields, [field.field]: field.state }
      return next
    })
    setDirty(true)
  }
  function markField(field: PlanField, note = '你在卡片中手动修改'): void {
    setPlan(current => current ? { ...current, fields: { ...current.fields, [field]: { source: 'user', note } } } : current)
    setDirty(true)
  }
  function pushHistory(label: string): void {
    if (!plan) return
    historyId.current += 1
    setHistory(current => [...current.slice(-19), { id: historyId.current, label, at: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), before: clonePlanState(plan) }])
  }
  function chooseMode(mode: ExperimentMode): void {
    if (!plan || busy) return
    const result = switchPlanMode(plan, mode)
    if (result.conflict) { setConflicts(current => [...current, result.conflict!]); setNotice('这个字段你手动改过，请选择保留哪个值。'); return }
    if (result.note) { setNotice(result.note); return }
    if (!result.change) return
    pushHistory(result.change.summary)
    setPlan({ ...plan, draft: result.draft, mode: result.mode, fields: result.fields })
    setDirty(true); setNotice(`已更新：${result.change.summary}`)
  }
  async function verifyDataPath(path: string): Promise<void> {
    if (!server || !accessRouteId || !path.startsWith('/')) return
    const preserve = (source?: PlanSource): PlanSource => source === 'user' || source === 'recent' || source === 'file' ? source : 'server'
    try {
      const view = await window.labApi.intelligence.browseRepositoryDirectory({ serverId: server.id, accessRouteId, path })
      setPlan(current => {
        if (!current || current.draft.dataPath.trim() !== path) return current
        const previous = current.fields.dataPath
        return {
          ...current,
          fields: {
            ...current.fields,
            dataPath: {
              source: previous ? preserve(previous.source) : 'server',
              note: `${previous?.note ? `${previous.note}；` : ''}目录已在服务器确认存在（${view.entries.length} 个子目录）`
            }
          }
        }
      })
    } catch {
      setPlan(current => current && current.draft.dataPath.trim() === path ? { ...current, fields: { ...current.fields, dataPath: { source: current.fields.dataPath?.source === 'user' ? 'user' : 'suggested', note: '未能在服务器确认这个目录，请检查路径' } } } : current)
    }
  }
  async function recheckPlan():Promise<void>{
    if(!plan||!preparationId.current||rechecking)return
    setRechecking(true)
    try{
      await flushEdits(currentEdit(plan))
      const view=await window.labApi.intelligence.preparations.act(preparationId.current,{kind:'recheck',expectedRevision:preparationRevision.current})
      if(view.error)throw new Error(view.error)
      preparationRevision.current=view.revision;setPreparation(view);setRecheckResult(view.checks??null)
      setNotice('路径核对完成。')
    }catch(cause){setError(cause instanceof Error?cause.message:String(cause))}finally{setRechecking(false)}
  }
  function answerGap(gap: PlanGap, option: PlanGap['options'][number]): void {    if (!plan) return
    const resolved = resolvePlanGap(plan, gap, option)
    pushHistory(resolved.change.summary)
    setPlan({ ...plan, draft: resolved.draft, mode: resolved.mode, fields: resolved.fields })
    setDirty(true); setNotice(resolved.change.summary)
    setDeferredGaps(items => items.filter(id => id !== gap.id))
    if (gap.kind === 'data' && option.value.startsWith('/')) void verifyDataPath(option.value)
  }
  function deferGap(id: string): void {
    setDeferredGaps(items => items.includes(id) ? items : [...items, id])
    setNotice('已暂后补充，可继续保存。')
  }
  function editField(field: PlanField, value: string, key?: 'title' | 'dataPath' | 'artifactPath'): void {
    if (!plan) return
    if (key === 'title') updateDraft({ title: value }, { field, state: { source: 'user', note: '你修改了任务名称' } })
    else if (key === 'dataPath') updateDraft({ dataPath: value }, { field, state: { source: 'user', note: '你修改了数据目录' } })
    else if (key === 'artifactPath') updateDraft({ artifactPath: value }, { field, state: { source: 'user', note: '你修改了输出位置' } })
    else markField(field)
  }
  async function submitRefine():Promise<void>{
    if(!plan||busy||refining)return
    const instruction=refineText.trim(),id=preparationId.current,current=plan
    if(!instruction){setNotice('请先写下要修改的内容。');return}
    if(!id){setNotice('请先完成项目分析，再修改方案。');return}
    setRefining(true);setBusy(true);setError('');setNotice('正在结合当前方案与项目文件分析修改要求…')
    try{
      await flushEdits(currentEdit(current))
      if(id!==preparationId.current)return
      const result=await window.labApi.intelligence.preparations.refine(id,instruction,preparationRevision.current)
      if(!live.current||id!==preparationId.current)return
      if(latestPlan.current!==current){setNotice('方案在分析期间已变化，本次建议未应用，请重试。');return}
      if(result.conflicts.length){setConflicts(existing=>[...existing,...result.conflicts].slice(-30));setNotice('本次修改涉及你手动编辑的字段，请确认是否采用整组建议。');return}
      if(!result.matched){setNotice(result.notes.join(' '));return}
      pushHistory(result.changes.map(change=>change.summary).join('；').slice(0,1900))
      setPlan({...current,draft:result.draft,mode:result.mode,fields:result.fields})
      setDirty(true);setRefineText('');setNotice(['已更新：'+result.changes.map(change=>change.summary).join('；'),...result.notes].join(' '))
    }catch(cause){if(live.current)setNotice(cause instanceof Error?cause.message:String(cause))}
    finally{if(live.current){setRefining(false);setBusy(false)}}
  }
  function applyConflict(conflict: PlanConflict): void {
    if (!plan) return
    pushHistory(`采用建议：${conflict.label}`)
    const fields: PlanFields = { ...plan.fields, ...conflict.suggestedFields, [conflict.suggestedField.field]: conflict.suggestedField.state }
    if (conflict.suggestedMode) fields.mode = { source: 'suggested', note: `改为${planModeLabels[conflict.suggestedMode]}` }
    setPlan({
      ...plan,
      mode: conflict.suggestedMode ?? plan.mode,
      draft: { ...plan.draft, ...conflict.suggestedDraft },
      fields
    })
    setConflicts(current => current.filter(item => item.id !== conflict.id))
    setDirty(true); setNotice(`已采用建议：${conflict.suggested}`)
  }
  function keepConflict(conflict: PlanConflict): void {
    setConflicts(current => current.filter(item => item.id !== conflict.id))
    setNotice(`保留你的值：${conflict.current}`)
  }
  function undo(): void {
    if (!plan || !history.length) return
    const last = history[history.length - 1]
    setPlan({ ...plan, ...structuredClone(last.before) })
    setHistory(current => current.slice(0, -1))
    setDirty(true); setNotice(`已撤销：${last.label}`)
  }
  function resetPlan(): void {
    if (!initialPlan) return
    pushHistory('恢复初始方案')
    setPlan(structuredClone(initialPlan))
    setDirty(true); setNotice('已恢复为系统首次生成的方案。')
  }
  function editFullConfig(): void {
    if (!plan) return
    props.onEditFullConfig(structuredClone({ ...plan.draft, serverId, accessRouteId }), edited => {
      if (!plan) return
      const changes = experimentDraftChanges(plan.draft, edited)
      if (!changes.length && JSON.stringify(plan.draft) === JSON.stringify(edited)) { setNotice('完整配置没有变化。'); return }
      const targetChanged = edited.serverId !== plan.draft.serverId || edited.accessRouteId !== plan.draft.accessRouteId
      const label = changes.length ? changes.map(change => change.label).join('、') : '完整配置'
      pushHistory(`完整配置：${label}`)
      setPlan(current => current ? { ...current, draft: { ...edited, id: current.draft.id }, fields: markUserFields(current.fields, changes) } : current)
      setDirty(true)
      setNotice(changes.length
        ? `已更新：${changes.map(change => `${change.label}：${change.after || '未填写'}`).join('；')}${targetChanged ? '。服务器或连接路径已更改，项目依据来自原服务器，建议重新分析。' : ''}`
        : `完整配置已更新${targetChanged ? '；服务器或连接路径已更改，项目依据来自原服务器，建议重新分析' : ''}。`)
    })
  }
  function draftForSave(): ExperimentTaskDraft | null {
    if (!plan || !server) return null
    const draft = plan.draft
    const condaEnvironment = draft.condaEnvironment ? {
      ...draft.condaEnvironment,
      managerPath: draft.condaEnvironment.managerPath?.trim() || undefined,
      environmentName: draft.condaEnvironment.environmentName?.trim() || undefined,
      environmentPrefix: draft.condaEnvironment.environmentPrefix?.trim() || undefined,
      environmentFilePath: draft.condaEnvironment.environmentFilePath?.trim() || undefined,
      pythonInterpreterPath: draft.condaEnvironment.pythonInterpreterPath?.trim() || undefined,
      pythonVersion: draft.condaEnvironment.pythonVersion?.trim() || undefined
    } : undefined
    return {
      ...draft,
      id: savedTask?.id ?? draft.id,
      title: (draft.title.trim() || suggestPlanTitle(planRootPath(plan), plan.mode)).slice(0, 160),
      project: draft.project || planRootPath(plan).split('/').filter(Boolean).pop() || '新实验',
      objective: draft.objective.trim() || plan.goal,
      serverId: server.id,
      serverNameSnapshot: server.name,
      accessRouteId,
      status: 'planned',
      launchMode: draft.launchMode ?? 'command',
      scriptPath: draft.scriptPath ?? '',
      codePath: draft.codePath.trim(),
      dataPath: draft.dataPath.trim(),
      launchCommand: draft.launchCommand.trim(),
      artifactPath: draft.artifactPath.trim(),
      condaEnvironment
    }
  }
  async function save(start: boolean, asNew = false): Promise<void> {
    if (!plan || !server) return
    if (savedTask && !dirty && !taskDeleted && !asNew) {
      if (start) props.onCreated(savedTask, true)
      else props.notify('草稿已经保存；继续修改会更新这份草稿')
      return
    }
    const draft = draftForSave()
    if (!draft) return
    if (!draft.title.trim()) { props.notify('请先填写任务名称', 'error'); return }
    if (draft.condaEnvironment?.environmentName?.trim() && draft.condaEnvironment.environmentPrefix?.trim()) {
      props.notify('Conda 环境名和前缀路径只能填写一项，请在完整配置中调整', 'error')
      return
    }
    setSaving(start ? 'start' : 'draft')
    try {
      if(!preparationId.current)throw new Error('准备流程尚未保存，请重新打开方案')
      await flushEdits({...currentEdit(plan),draft})
      const view=await window.labApi.intelligence.preparations.act(preparationId.current,{kind:asNew?'save-as-new':'save',expectedRevision:preparationRevision.current})
      if(view.error)throw new Error(view.error)
      const saved=view.task
      if(!saved)throw new Error('没有找到保存后的实验任务')
      preparationRevision.current=view.revision;setPreparation(view)
      lastSynced.current=JSON.stringify({...currentEdit(plan),draft:view.plan!.draft})
      setSavedTask(saved)
      setPlan(current => current ? { ...current, draft: view.plan!.draft } : current)
      setDirty(false);setError('');setSyncError('')
      props.onChanged(saved)
      props.notify(start ? '实验草稿已保存，正在打开资源选择' : '实验草稿已保存；继续修改会更新这份草稿')
      if (start) props.onCreated(saved, true)
    } catch (caught) {
      props.notify(caught instanceof Error ? caught.message : '无法保存实验草稿', 'error')
    } finally {
      setSaving(null)
    }
  }
  async function leave():Promise<void>{
    if(saving){props.notify('正在保存实验草稿，请稍候');return}
    try{
      if(plan)await flushEdits(currentEdit(plan))
      props.onExit()
    }catch(cause){setSyncError(cause instanceof Error?cause.message:String(cause))}
  }
  const recommendedMode = plan ? experimentModeFromGoal(plan.goal) : 'train'
  const launchCitations = plan ? planLaunchCitations(plan) : []
  const envState = plan?.fields.environment
  const activeGap = gaps[0]

  return <section className="smart-create" aria-label="智能创建实验">
    <header className="smart-create-head">
      <div className="smart-create-toolbar">
        <button type="button" className="smart-return-button" aria-label="返回实验任务" title="返回实验任务" onClick={() => void leave()}><ArrowLeft size={18} /><span>返回</span></button>
        <button type="button" className="secondary-button preparation-sessions-trigger" aria-haspopup="dialog" disabled={busy || !!saving} onClick={() => { setSessionsOpen(true); void refreshSessions() }}><History size={15} />实验准备记录</button>
      </div>
      <div className="smart-create-title"><h2>实验准备</h2><p>选择项目，描述目标，生成可编辑的实验方案。</p></div>
    </header>

    {syncError&&<div className="intel-error" role="alert">准备进度保存失败：{syncError}<button type="button" className="secondary-button" onClick={()=>void flushEdits(plan?currentEdit(plan):undefined).then(()=>setSyncError('')).catch(cause=>setSyncError(String(cause)))}>重试保存进度</button></div>}
    {preparation&&!taskDeleted&&(preparation.phase==='paused'||preparation.phase==='failed')&&<div className="preparation-resume-note"><span>{preparation.error||'上次准备尚未完成'}，可继续准备。</span><button type="button" className="secondary-button" disabled={busy} onClick={()=>void resumePreparation(preparation.id)}>继续未完成步骤</button></div>}
    {sessionsOpen && <div className="app-modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) setSessionsOpen(false) }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setSessionsOpen(false) } }}>
      <section className="app-modal preparation-sessions-dialog" role="dialog" aria-modal="true" aria-labelledby="preparation-sessions-title">
        <header className="dialog-header app-modal-header"><div className="dialog-title-wrap app-modal-title"><div className="dialog-icon"><History size={18} /></div><div><h2 id="preparation-sessions-title">实验准备记录</h2><p>查看已保存的准备进度，继续补充和审阅方案。</p></div></div><button type="button" className="icon-button" aria-label="关闭实验准备记录" autoFocus onClick={() => setSessionsOpen(false)}><X size={16} /></button></header>
        <div className="preparation-sessions preparation-sessions-list">
          {sessions.length ? sessions.map(item => <article key={item.id}><div><strong>{item.title}</strong><small title={item.input.path}>{props.servers.find(server => server.id === item.input.serverId)?.name ?? '服务器已移除'} · {item.input.path}</small><small>更新于 {new Date(item.updatedAt).toLocaleString('zh-CN')}</small></div><span>{{analyzing:'正在处理',needs_input:'等待补充',review:'可审阅',saved:'草稿已保存',paused:'已暂停',failed:'需要处理'}[item.phase]}</span><button type="button" className="secondary-button" disabled={busy || !!deletingId || !props.servers.some(server => server.id === item.input.serverId)} onClick={() => { setSessionsOpen(false); void resumePreparation(item.id) }}>继续准备</button><button type="button" className="icon-button preparation-delete-button" aria-label={`删除准备记录：${item.title}`} title={item.busy ? '正在处理，请先停止后再删除' : '删除准备记录'} disabled={busy || !!saving || !!deletingId || item.busy} onClick={() => void deletePreparation(item)}>{deletingId === item.id ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}</button></article>) : <p className="smart-note">暂无实验准备记录。</p>}
        </div>
      </section>
    </div>}
    {stage !== 'review' && <div className="smart-start">
      <fieldset className="smart-start-main" disabled={busy || stage === 'analyzing'} aria-label="项目与实验目标">
        <section className="smart-start-card">
          <header><span><Server size={15} /></span><div><h3>项目位置</h3><p>服务器上的代码目录</p></div></header>
          {realServers.length === 0 ? <p className="smart-inline-warning">还没有真实服务器。请先在「资源」中添加并确认 SSH 主机指纹。</p> : <>
            <div className="smart-server-row">
              <label>服务器<select value={serverId} onChange={event => { setServerId(event.target.value); setRouteId(''); resetSession(event.target.value, '') }}>{realServers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              {server && getAccessRoutes(server).length > 1 && <div className="smart-route"><span>连接路径</span><AccessRouteSelect server={server} value={accessRouteId} onChange={value => setRouteId(value)} /></div>}
            </div>
            <label className="smart-field">目录<div className="smart-path-row"><input aria-label="项目目录" value={root} onChange={event => { setRoot(event.target.value); resetSession(serverId, event.target.value) }} placeholder="/home/user/project" /><button type="button" className="secondary-button" disabled={!server} onClick={() => openBrowser('project')}><FolderOpen size={14} />浏览</button></div></label>
            {root.trim() && !root.trim().startsWith('/') && <p className="smart-inline-warning">项目目录必须是服务器上的绝对路径。</p>}
            {visibleRecent.length > 0 && <div className="smart-recent"><span>最近项目</span><div>{visibleRecent.map(item => <button type="button" key={`${item.serverId}:${item.path}`} onClick={() => { if (item.serverId !== serverId) setRouteId(''); resetSession(item.serverId, item.path) }}><FolderOpen size={13} /><span>{item.name}<small>{item.serverId === serverId ? item.path : `${item.serverName} · ${item.path}`}</small></span></button>)}</div></div>}
          </>}
        </section>
        <section className="smart-start-card">
          <header><span><Sparkles size={15} /></span><div><h3>想做什么</h3><p>用一句实验目的描述即可</p></div></header>
          <textarea aria-label="实验目标" rows={4} maxLength={2000} value={goal} onChange={event => setGoal(event.target.value)} placeholder="例如：先跑一次基线 / 评估已有权重 / 复现 README 的训练配置" />
          <div className="smart-goal-examples">{['先跑一次基线', '评估已有权重', '复现 README 的训练配置'].map(example => <button type="button" key={example} onClick={() => setGoal(example)}>{example}</button>)}</div>
        </section>
      </fieldset>
      {props.modelEnabled === false && <div className="smart-model-warning"><AlertTriangle size={15} /><span>模型尚未启用，系统无法完成项目理解。</span><button type="button" className="wb-text-button" onClick={props.onModelSettings}>前往模型设置</button><button type="button" className="wb-text-button" onClick={props.onManualCreate}>改为手动创建</button></div>}
      {error && !(taskDeleted && /关联任务已删除/.test(error)) && <div className="intel-error" role="alert">{error}</div>}
      {notice && <p className="smart-note" role="status">{notice}</p>}
      <footer className="smart-start-footer">
        <div><button type="button" className="primary-button smart-analyze" disabled={!canAnalyze} onClick={() => void analyze()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{stage === 'analyzing' ? '正在分析项目…' : '分析项目并准备实验'}</button></div>
        <p>分析时会将所选项目文件发送给已配置的模型，实验需确认后运行。</p>
      </footer>
    </div>}

    {stage === 'review' && <section className="smart-project-context" aria-label="本次分析的项目和目标">
      <div><Server size={14}/><strong>{server?.name ?? '服务器已移除'}</strong><code>{root}</code></div>
      <p><span>实验目标</span>{goal}</p>
    </section>}

    {stage==='start'&&preparation&&<PreparationTimeline view={preparation}/>}
    {stage !== 'start' && <div className="smart-workbench">
      <section className="smart-progress durable-preparation-progress"><PreparationTimeline view={preparation}/>{stage==='analyzing'&&<button type="button" className="secondary-button" onClick={cancelAnalysis}>暂停准备</button>}
        {snapshot && <details className="smart-scope" open={scopeOpen} onToggle={event => setScopeOpen((event.target as HTMLDetailsElement).open)}>
          <summary>分析范围 · 已选 {files.length} / {snapshot.files.length} 个相关文件 · 可展开调整</summary>
          <div className="smart-scope-actions"><button type="button" className="wb-text-button" disabled={busy} onClick={() => setFiles(snapshot.files.map(file => file.path))}>全选</button><button type="button" className="wb-text-button" disabled={busy} onClick={() => setFiles([])}>清空</button><button type="button" className="secondary-button" disabled={busy || !files.length} onClick={() => void analyze({ snapshot, files })}>按此范围重新分析</button></div>
          <p className="smart-note">仅将勾选的文件发送给模型。</p>
          <div className="smart-scope-list">{snapshot.files.map(file => <label key={file.path}><input type="checkbox" disabled={busy} checked={files.includes(file.path)} onChange={event => setFiles(current => event.target.checked ? [...current, file.path] : current.filter(path => path !== file.path))} /><span>{file.path}</span></label>)}</div>
          {snapshot.warnings.map((warning, index) => <p key={index} className="smart-note">{warning}</p>)}
        </details>}
        {error && !(taskDeleted && /关联任务已删除/.test(error)) && <div className="intel-error" role="alert">{error}</div>}
        {stage === 'analyzing' && notice && <p className="smart-note" role="status">{notice}</p>}
      </section>

      {plan && stage === 'review' && <div className="smart-plan">
        <header className="smart-plan-head">
          <div><span className="smart-plan-state"><CheckCircle2 size={14} />方案已生成</span><h2>{plan.draft.title || '本次实验'}</h2><p>{plan.summary}</p></div>
          <div className="smart-plan-meta"><span><FileCode2 size={13} />{launchCitations.length + plan.guide.snapshot.excerpts.length} 处文件依据</span><span><Server size={13} />{plan.guide.checks.filter(check => check.status === 'confirmed').length} 项服务器路径核对</span><button type="button" className="wb-text-button" onClick={() => void leave()}>返回任务池</button></div>
        </header>
        <div className="smart-plan-grid">
          <article className="smart-card">
            <header><div className="smart-card-icon"><Sparkles size={16} /></div><div><h3>本次实验</h3></div><SourceBadge state={plan.fields.mode} /></header>
            <label className="smart-field">任务名称<input aria-label="任务名称" value={plan.draft.title} maxLength={160} onChange={event => editField('title', event.target.value, 'title')} /></label>
            <div className="smart-objective"><span>实验目标</span><p>{plan.draft.objective || plan.goal}</p></div>
            <div className="smart-mode-switch" role="radiogroup" aria-label="实验方式">
              {(['train', 'evaluate'] as const).map(mode => {
                const option = plan.entryOptions.find(entry => entry.mode === mode)
                const active = plan.mode === mode
                const recommended = recommendedMode === mode && plan.mode === mode && !!option
                return <button type="button" role="radio" aria-checked={active} key={mode} className={`${active ? 'active' : ''} ${recommended ? 'recommended' : ''}`} disabled={busy || !option} onClick={() => chooseMode(mode)}>
                  <span>{active ? <CheckCircle2 size={14} /> : <Circle size={14} />}<strong>{planModeLabels[mode]}</strong>{recommended && <em>推荐</em>}</span>
                  <small>{option ? option.reason : `项目中没有发现${planModeLabels[mode]}入口`}</small>
                </button>
              })}
            </div>
            <p className="smart-card-note">{plan.fields.mode?.note}</p>
          </article>

          <article className="smart-card">
            <header><div className="smart-card-icon"><Code2 size={16} /></div><div><h3>运行方式</h3></div><SourceBadge state={plan.fields.launchCommand} /></header>
            <dl className="smart-kv">
              <div><dt>入口</dt><dd>{planCommandEntry(plan.draft.launchCommand) ?? '待确认'}</dd></div>
              <div><dt>配置文件</dt><dd>{planCommandConfig(plan.draft.launchCommand) ?? '命令中没有指定配置文件'}</dd></div>
              <div><dt>启动目录</dt><dd>{plan.draft.codePath || '未确定'}</dd></div>
              <div><dt>命令</dt><dd>{plan.draft.launchCommand ? <code>{plan.draft.launchCommand}</code> : '尚未确定'}</dd></div>
            </dl>
            <p className="smart-card-note">{plan.fields.launchCommand?.note}</p>
            <details className="smart-card-more"><summary>完整命令、字段与文件依据<ChevronDown size={13} /></summary>
              {launchCitations.map((citation, index) => <div className="smart-citation" key={index}><strong>{citation.path}:{citation.startLine}–{citation.endLine}</strong><pre>{citation.quote}</pre></div>)}
              {!launchCitations.length && <p className="smart-note">这条命令来自系统建议，没有可直接引用的原文。</p>}
              <p className="smart-note">以下为分析时的路径核对；切换入口或修改目录后，请在运行前重新确认。</p>
              <div className="smart-checks">{plan.guide.checks.map((check, index) => <p key={index}><span className={check.status}>{check.status === 'confirmed' ? '已核对' : check.status === 'missing' ? '未找到' : check.status === 'outside' ? '超出范围' : '未核对'}</span>{check.expected === 'file' ? '入口文件' : '启动目录'} {check.path} · {check.message}</p>)}</div>
            </details>
          </article>

          <article className="smart-card">
            <header><div className="smart-card-icon"><Database size={16} /></div><div><h3>环境与数据</h3></div><SourceBadge state={envState} /></header>
            <label className="experiment-conda-toggle"><input type="checkbox" checked={Boolean(plan.draft.condaEnvironment)} disabled={busy || envLoading || envChecking} onChange={event => { pushHistory(event.target.checked ? '配置 Conda 环境' : '使用服务器默认环境'); updateDraft({condaEnvironment: event.target.checked ? {manager: 'conda', lastCheckStatus: 'unknown'} : undefined}, {field: 'environment', state: {source: 'user', note: event.target.checked ? '选择服务器已有环境' : '使用服务器默认环境'}}) }} /><span><strong>配置 Conda 环境</strong></span></label>
            {plan.draft.condaEnvironment && <CondaEnvironmentFields serverId={server?.id} accessRouteId={accessRouteId} config={plan.draft.condaEnvironment} environments={envs} busy={envLoading || envChecking} disabled={busy || !server} onChange={updateEnvironment} onReload={() => void loadEnvironments()} onCheck={() => void checkEnvironment()} />}
            <div className="smart-field"><div className="smart-field-head"><span>数据目录</span><SourceBadge state={plan.fields.dataPath} /></div><div className="smart-path-row"><input aria-label="数据目录" value={plan.draft.dataPath} onChange={event => editField('dataPath', event.target.value, 'dataPath')} onBlur={event => { if (event.target.value.trim().startsWith('/')) void verifyDataPath(event.target.value.trim()) }} placeholder="/mnt/nas/datasets/experiment" /><button type="button" className="secondary-button" onClick={() => openBrowser('data')}><FolderOpen size={14} />选择数据</button></div></div>
            <p className="smart-card-note">{plan.fields.dataPath?.note ?? '尚未确定数据位置'}</p>
            {!plan.draft.dataPath.trim() && <p className="smart-card-warn"><AlertTriangle size={13} />这次实验还没有确定数据位置。</p>}
          </article>

          <article className="smart-card">
            <header><div className="smart-card-icon"><Save size={16} /></div><div><h3>输出与观察</h3><p>结果保存位置与可观察指标</p></div><SourceBadge state={plan.fields.artifactPath} /></header>
            <label className="smart-field">模型 / 结果保存位置<input aria-label="输出位置" value={plan.draft.artifactPath} onChange={event => editField('artifactPath', event.target.value, 'artifactPath')} placeholder="/home/user/project/runs/exp-01" /></label>
            <p className="smart-card-note">{plan.fields.artifactPath?.note}</p>
            <dl className="smart-kv">
              <div><dt>运行日志</dt><dd><code>~/.local/state/labdeck-competition/runs/&lt;运行 ID&gt;/stdout.log</code></dd></div>
              <div><dt>项目指标</dt><dd>{plan.signals.metrics.length ? <span className="smart-metrics">{plan.signals.metrics.map(metric => <em key={metric.key} title={`${metric.citation.path}:${metric.citation.startLine}`}>{metric.label}</em>)}</span> : '项目文件中没有明确列出评估指标'}</dd></div>
            </dl>
            {plan.signals.metrics.length > 0 && <details className="smart-card-more"><summary>指标依据<ChevronDown size={13} /></summary>{plan.signals.metrics.map(metric => <p key={metric.key} className="smart-note"><strong>{metric.label}</strong> · {metric.citation.path}:{metric.citation.startLine} · {metric.citation.quote}</p>)}</details>}
          </article>
        </div>

        {activeGap ? <section className="smart-gap" aria-label="需要补充的信息">
          <header><div><span>还需要你确认</span><small>{activeGap.kind === 'data' ? '数据' : activeGap.kind === 'environment' ? '环境' : '入口'} · 共 {gaps.length} 项待确认</small></div></header>
          <h3>{activeGap.question}</h3>
          {activeGap.detail && <p>{activeGap.detail}</p>}
          {activeGap.options.length > 0 && <div className="smart-gap-options">{activeGap.options.map(option => <button type="button" key={option.id} onClick={() => answerGap(activeGap, option)}><span>{option.source === 'server' ? <Server size={14} /> : option.source === 'file' ? <FileCode2 size={14} /> : <FolderOpen size={14} />}</span><div><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</div><em className={`smart-source ${option.source}`}>{sourceTitle(option.source)}</em></button>)}</div>}
          <div className="smart-gap-actions">{activeGap.allowBrowse && <button type="button" className="secondary-button" onClick={() => openBrowser('data')}><FolderOpen size={14} />浏览其他目录</button>}{activeGap.allowLater && <button type="button" className="wb-text-button" onClick={() => deferGap(activeGap.id)}>暂后补充</button>}</div>
        </section> : <p className="smart-gap-ok"><CheckCircle2 size={15} />方案已就绪</p>}
        {deferredGaps.length > 0 && <p className="smart-note">已暂后补充 {deferredGaps.length} 项（{deferredGaps.map(id => id === 'data' ? '数据' : id === 'environment' ? '环境' : '入口').join('、')}），不会阻塞保存。<button type="button" className="wb-text-button" onClick={() => setDeferredGaps([])}>重新查看</button></p>}

        {plan.questions.length > 0 && <details className="smart-questions"><summary>项目分析提出的其他确认事项 · {plan.questions.length}</summary><ul>{plan.questions.map((question, index) => <li key={index}>{question}</li>)}</ul><p className="smart-note">这些事项不阻塞保存，可在「编辑配置」或任务备注中补充。</p></details>}
        {[...new Set([...plan.guide.warnings, ...plan.guide.snapshot.warnings])].length > 0 && <details className="smart-questions"><summary>分析警告与读取范围说明 · {new Set([...plan.guide.warnings, ...plan.guide.snapshot.warnings]).size}</summary><ul>{[...new Set([...plan.guide.warnings, ...plan.guide.snapshot.warnings])].map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}

        <section className="smart-refine" aria-label="继续修改方案">
          <label htmlFor="smart-refine-input"><Sparkles size={14} />继续修改这份方案</label>
          <div className="smart-refine-row"><input id="smart-refine-input" value={refineText} onChange={event => setRefineText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void submitRefine() } }} placeholder="例如：把训练轮数改为 1 / 把 batch size 改为 16 / 把学习率改为 0.001" /><button type="button" className="secondary-button" disabled={busy || !refineText.trim()} onClick={()=>void submitRefine()}>{refining?'正在修改…':'修改方案'}</button></div>
          <div className="smart-goal-examples">{['把训练轮数改为 1', '把 batch size 改为 16', '把学习率改为 0.001'].map(example => <button type="button" key={example} onClick={() => setRefineText(example)}>{example}</button>)}</div>
          {(notice || history.length > 0) && <div className="smart-refine-feedback">{notice && <p className="smart-refine-note" role="status">{notice}</p>}{history.length > 0 && <button type="button" className="wb-text-button" onClick={undo}><Undo2 size={13} />撤销上次修改</button>}</div>}
          {conflicts.map(conflict => <div className="smart-conflict" role="alert" key={conflict.id}><strong>{conflict.label}已被你手动修改</strong><p>当前：<code>{conflict.current || '未填写'}</code><br />建议：<code>{conflict.suggested}</code></p><div><button type="button" className="primary-button" onClick={() => applyConflict(conflict)}>采用新值</button><button type="button" className="secondary-button" onClick={() => keepConflict(conflict)}>保留我的</button></div></div>)}
        </section>

        {history.length > 0 && <details className="smart-history"><summary>本次修改记录 · {history.length} 项</summary><ol>{history.map(entry => <li key={entry.id}><time>{entry.at}</time><span>{entry.label}</span></li>)}</ol><div><button type="button" className="wb-text-button" onClick={resetPlan}><RotateCcw size={13} />恢复初始方案</button></div></details>}
        {recheckResult && <details className="smart-questions" open><summary>服务器路径核对 · {recheckResult.configurationKey===projectConfigurationKey(plan.draft)?'当前配置':'配置已变更，以下为原核对结果'} · {new Date(recheckResult.at).toLocaleTimeString('zh-CN')}</summary><ul>{recheckResult.lines.map((line, index) => <li key={index} className={line.ok ? '' : 'smart-recheck-failed'}>{line.ok ? '✓' : '×'} {line.text}</li>)}</ul></details>}
        {taskDeleted && <p className="smart-inline-warning">原实验任务已删除，当前准备方案仍保留。点击“另存为新任务”可重新创建实验草稿。</p>}
        {!server && <p className="smart-inline-warning">原服务器已不可用，当前方案无法保存。请返回任务池重新选择服务器并分析。</p>}
        <footer className="smart-plan-footer">
          <div><button type="button" className="secondary-button" onClick={editFullConfig}><SlidersHorizontal size={14} />编辑配置</button><button type="button" className="secondary-button" disabled={rechecking || saving !== null} onClick={() => void recheckPlan()}>{rechecking ? <LoaderCircle size={14} className="spin" /> : <Server size={14} />}重新核对路径</button></div>
          <div className="smart-plan-save"><span className="smart-saved" role="status">{syncing?'正在保存准备进度…':syncError?'进度尚未保存':'准备进度已保存'}</span>
            {savedTask && !taskDeleted && <span className="smart-saved"><CheckCircle2 size={14} />草稿已保存{!dirty ? '' : ' · 有未保存修改'}<button type="button" className="wb-text-button" disabled={saving !== null} onClick={() => props.onOpenTask(savedTask)}>在任务池查看</button></span>}
            {taskDeleted ? <button type="button" className="primary-button" disabled={!canSave} onClick={() => void save(false, true)}>{saving === 'draft' ? <><LoaderCircle size={14} className="spin" />保存中…</> : <><Save size={14} />另存为新任务</>}</button> : <>
            <button type="button" className="secondary-button" disabled={!canSave} onClick={() => void save(false)}>{saving === 'draft' ? <><LoaderCircle size={14} className="spin" />保存中…</> : <><Save size={14} />保存草稿</>}</button>
            <button type="button" className="primary-button" disabled={!canSave} onClick={() => void save(true)}>{saving === 'start' ? <><LoaderCircle size={14} className="spin" />准备资源…</> : <><Play size={14} />创建并选择资源</>}</button>
            </>}
          </div>
        </footer>
      </div>}
    </div>}

    {browser && server && accessRouteId && <RemoteDirectoryPicker
      key={`${server.id}:${accessRouteId}:${browser.mode}`}
      serverId={server.id} accessRouteId={accessRouteId} initialPath={browser.initialPath}
      title={browser.mode === 'project' ? '选择项目目录' : '选择数据目录'}
      onClose={() => setBrowser(null)} onSelect={chooseBrowserPath}
    />}
  </section>
}
