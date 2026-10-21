import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, Circle, Code2, Database, FileCode2,
  FolderOpen, LoaderCircle, Play, RotateCcw, Save, Server, SlidersHorizontal, Sparkles, Undo2, X
} from 'lucide-react'
import type { CondaEnvironmentInfo, ExperimentTask, ExperimentTaskDraft, RemoteCondaResult, ServerProfile } from '@shared/types'
import type { RepositoryCandidate, RepositoryDirectoryView, RepositoryProgress, RepositorySnapshot } from '@shared/repository-guide'
import { getAccessRoutes, getDefaultAccessRouteId } from '@shared/access-routes'
import { commandDataPath, syncCommandDataPath } from '@shared/project-task'
import type { ConfirmationRequest } from './ConfirmDialog'
import { AccessRouteSelect } from './AccessRouteSelect'
import {
  createExperimentPlan, experimentDraftChanges, experimentModeFromGoal, markUserFields,
  planCommandConfig, planCommandEntry, planEnvironmentName, planGaps, planModeLabels, planRootPath,
  planSourceLabels, projectSignals, recommendProjectFiles, refineExperimentPlan, resolvePlanGap,
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
type StageKey = 'scan' | 'entry' | 'environment' | 'match' | 'generate'
interface SmartMessage { id: number; stage: StageKey; text: string; at: string; tone?: 'warn' }
interface HistoryEntry { id: number; label: string; at: string; before: { draft: ExperimentTaskDraft; mode: ExperimentMode; fields: PlanFields } }
interface BrowserState { mode: 'project' | 'data'; view: RepositoryDirectoryView | null; busy: boolean; error: string }

const stageOrder: { key: StageKey; label: string; hint: string }[] = [
  { key: 'scan', label: '读取项目文件', hint: '读取目录结构、README 与依赖说明' },
  { key: 'entry', label: '识别入口与配置', hint: '查找训练、评估入口和默认配置' },
  { key: 'environment', label: '核对环境与依赖', hint: '读取服务器上可用的 Conda 环境' },
  { key: 'match', label: '匹配本次目标', hint: '按实验目的选择最相关的内容' },
  { key: 'generate', label: '生成实验方案', hint: '整理运行方式并核对入口与目录' }
]
const stageOfProgress = (stage: RepositoryProgress['stage']): StageKey => stage === 'scan' || stage === 'read' ? 'scan' : stage === 'verify' || stage === 'write' ? 'generate' : 'match'
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
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [plan, setPlan] = useState<ExperimentPlan | null>(null)
  const [initialPlan, setInitialPlan] = useState<ExperimentPlan | null>(null)
  const [savedTask, setSavedTask] = useState<ExperimentTask | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState<'draft' | 'start' | null>(null)
  const [busy, setBusy] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const [recheckResult, setRecheckResult] = useState<{ at: string; lines: { ok: boolean; text: string }[] } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [messages, setMessages] = useState<SmartMessage[]>([])
  const [envs, setEnvs] = useState<CondaEnvironmentInfo[]>([])
  const [envLoading, setEnvLoading] = useState(false)
  const [envChecking, setEnvChecking] = useState(false)
  const [browser, setBrowser] = useState<BrowserState | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [conflicts, setConflicts] = useState<PlanConflict[]>([])
  const [deferredGaps, setDeferredGaps] = useState<string[]>([])
  const [refineText, setRefineText] = useState('')
  const [scopeOpen, setScopeOpen] = useState(false)
  const [dataCandidates, setDataCandidates] = useState<PlanDataCandidate[]>([])
  const [repositories, setRepositories] = useState<RepositoryCandidate[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [discoverNote, setDiscoverNote] = useState('')
  const revision = useRef(0)
  const requestId = useRef<string | null>(null)
  const messageId = useRef(0)
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
  const canSave = Boolean(server && plan && plan.draft.title.trim() && !saving && !envChecking)

  useEffect(() => {
    setServerId(initialServerId)
    setRouteId(props.seed?.accessRouteId ?? '')
    const recent = [...props.tasks]
      .filter(task => task.serverId === initialServerId && task.codePath)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
    setRoot(props.seed?.path ?? recent?.codePath ?? '')
    setGoal(props.seed?.goal ?? '')
    setStage('start'); setSnapshot(null); setFiles([]); setPlan(null); setInitialPlan(null); setSavedTask(null)
    setDirty(false); setError(''); setMessages([]); setHistory([]); setConflicts([]); setDeferredGaps([]); setDataCandidates([])
    setRecheckResult(null)
    // Seed changes mean a new preparation session from the resource page.
  }, [props.seed])
  useEffect(() => {
    if (stage === 'start' && (!serverId || !realServers.some(server => server.id === serverId)) && realServers[0]) setServerId(realServers[0].id)
  }, [realServers, serverId, stage])

  useEffect(() => {
    const unsubscribe = window.labApi.intelligence.onRepositoryProgress(event => {
      if (event.id !== requestId.current) return
      pushMessage(stageOfProgress(event.stage), event.message)
    })
    return unsubscribe
  }, [])

  useEffect(() => () => {
    revision.current += 1
    const id = requestId.current
    requestId.current = null
    if (id) void window.labApi.intelligence.cancelProjectPreparation(id).catch(() => {})
  }, [])

  function pushMessage(stageKey: StageKey, text: string, tone?: 'warn'): void {
    messageId.current += 1
    setMessages(current => [...current.slice(-30), { id: messageId.current, stage: stageKey, text, at: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), tone }])
  }
  function resetSession(nextServerId = serverId, nextRoot = root): void {
    setSnapshot(null); setFiles([]); setPlan(null); setInitialPlan(null); setSavedTask(null)
    setDirty(false); setMessages([]); setHistory([]); setConflicts([]); setDeferredGaps([]); setDataCandidates([])
    setError(''); setNotice(''); setScopeOpen(false); setRepositories([]); setDiscoverNote(''); setRecheckResult(null)
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
  async function loadEnvironments(): Promise<CondaEnvironmentInfo[]> {
    if (!server || !accessRouteId) return []
    setEnvLoading(true)
    try {
      const value = await trustRemote(() => window.labApi.experiments.listCondaEnvironments(server.id, accessRouteId, 'conda'))
      const environments = value?.environments ?? []
      setEnvs(environments)
      return environments
    } catch {
      setEnvs([])
      return []
    } finally {
      setEnvLoading(false)
    }
  }
  function describeSignals(value: RepositorySnapshot): void {
    const signals = projectSignals(value)
    pushMessage('scan', `已读取 ${value.files.length} 个可分析文件的清单${signals.hasReadme ? '，包含 README' : '，没有找到 README'}。`)
    const train = signals.entries.find(entry => entry.kind === 'train')
    const evaluate = signals.entries.find(entry => entry.kind === 'evaluate')
    if (train && evaluate) pushMessage('entry', `项目提供训练入口 ${train.path} 与评估入口 ${evaluate.path}，正在按“${goal.trim()}”匹配本次目标。`)
    else if (train || evaluate) pushMessage('entry', `已找到${train ? '训练' : '评估'}入口 ${(train ?? evaluate)!.path}${signals.configs[0] ? `和默认配置 ${signals.configs[0]}` : ''}。`)
    else pushMessage('entry', '没有识别出明确的训练或评估入口，将依据已读说明和配置继续分析。', 'warn')
    if (signals.dependencyFiles.length) pushMessage('environment', `项目依赖说明：${signals.dependencyFiles.slice(0, 3).join('、')}。`)
  }
  async function analyze(scope?: { snapshot: RepositorySnapshot; files: string[] }): Promise<void> {
    if (!server || !accessRouteId) { setError('请选择一台真实服务器和连接路径'); return }
    if (!root.trim().startsWith('/')) { setError('项目目录必须是服务器上的绝对路径'); return }
    if (!goal.trim()) { setError('请先说明这次想做什么'); return }
    if (!props.modelEnabled) { setError('模型尚未启用，请先完成模型设置，或使用手动创建'); return }
    const hadSavedDraft = Boolean(savedTask)
    const token = ++revision.current
    setStage('analyzing'); setBusy(true); setError(''); setNotice(''); setPlan(null); setInitialPlan(null); setSavedTask(null)
    setDirty(false); setHistory([]); setConflicts([]); setDeferredGaps([]); setDataCandidates([]); setFiles([]); setSnapshot(null); setMessages([])
    setScopeOpen(false)
    let currentSnapshot = scope?.snapshot
    let selectedFiles = scope?.files ?? []
    try {
      if (scope) {
        setSnapshot(scope.snapshot); setFiles(scope.files)
        pushMessage('scan', `按更新后的文件范围重新分析：已选 ${scope.files.length} 个文件。`)
        pushMessage('entry', '沿用上次识别的入口与配置，按新的文件范围重新生成方案。')
      } else {
        pushMessage('scan', '正在连接服务器并读取项目目录…')
        currentSnapshot = await window.labApi.intelligence.inspectRepository({ source: 'remote', serverId: server.id, accessRouteId, path: root.trim() })
        if (token !== revision.current) return
        setSnapshot(currentSnapshot)
        const recommended = recommendProjectFiles(currentSnapshot.files, goal)
        if (!recommended.length) throw new Error('此目录中没有可分析的文本文件，请确认项目路径或换一个目录')
        selectedFiles = recommended
        setFiles(recommended)
        describeSignals(currentSnapshot)
        pushMessage('match', `已选出 ${recommended.length} 个与本次目标最相关的文件，准备生成最小运行方案。`)
      }
      if (!selectedFiles.length) throw new Error('请至少选择一个要分析的文件')
      const envPromise = envs.length ? Promise.resolve(envs) : loadEnvironments()
      void envPromise.then(environments => {
        if (token !== revision.current) return
        if (environments.length) pushMessage('environment', `已找到 ${environments.length} 个可用环境：${environments.slice(0, 4).map(environment => environment.name).join('、')}${environments.length > 4 ? ' 等' : ''}，正在核对项目依赖说明。`)
        else pushMessage('environment', '没有读取到可用的 Conda 环境；方案会先给出环境建议，稍后可在卡片中补充。', 'warn')
      })
      pushMessage('generate', '正在读取项目内容并生成实验方案…')
      const id = crypto.randomUUID()
      requestId.current = id
      const guide = await window.labApi.intelligence.prepareProject({ ...currentSnapshot!.input, filePaths: selectedFiles, goal: goal.trim() }, id)
      if (token !== revision.current) return
      requestId.current = null
      const environments = await envPromise
      if (token !== revision.current) return
      const value = createExperimentPlan({ guide, goal: goal.trim(), environments, now: new Date() })
      setPlan(value); setInitialPlan(structuredClone(value)); setStage('review'); setDirty(true)
      if (hadSavedDraft) setNotice('已生成新方案；之前保存的草稿仍保留，保存这份方案会创建新任务。')
      pushMessage('generate', `方案已生成：${guide.summary.slice(0, 120)}`)
      void discoverDataCandidates(value, token)
    } catch (caught) {
      if (token !== revision.current) return
      const message = caught instanceof Error ? caught.message : String(caught)
      if (/取消/.test(message)) {
        setStage('start'); setNotice('已取消分析；项目和目标已保留。')
      } else {
        setError(message); setStage('start')
      }
    } finally {
      if (token === revision.current) { requestId.current = null; setBusy(false) }
    }
  }
  async function discoverDataCandidates(value: ExperimentPlan, token: number): Promise<void> {
    if (!server || !accessRouteId) return
    const rootPath = planRootPath(value)
    let entries: string[] = []
    try {
      const view = await window.labApi.intelligence.browseRepositoryDirectory({ serverId: server.id, accessRouteId, path: rootPath })
      if (token !== revision.current) return
      entries = view.entries.map(entry => entry.name)
    } catch { /* data discovery is best effort */ }
    const candidates: PlanDataCandidate[] = []
    const add = (path: string, source: PlanSource, note: string): void => {
      if (!path.startsWith('/') || candidates.some(item => item.path === path)) return
      candidates.push({ path, source, note })
    }
    if (value.draft.dataPath) add(value.draft.dataPath, value.fields.dataPath?.source ?? 'suggested', value.fields.dataPath?.note ?? '当前方案中的位置')
    for (const warning of value.guide.warnings) {
      const verified = /数据目录已确认存在：([^\s，。；]+)/.exec(warning)
      if (verified) add(verified[1], 'server', '已在服务器确认存在')
      const inferred = /数据目录从仓库内 ([^\s，。；]+) 推断/.exec(warning)
      if (inferred) add(inferred[1], 'server', '仓库内目录已确认存在，是否本次数据需核对')
      const fromCommand = /数据目录从启动命令参数读取：([^\s，。；]+)/.exec(warning)
      if (fromCommand) add(fromCommand[1], 'file', '来自启动命令参数')
    }
    for (const name of entries) {
      if (/^(data|datasets?|corpus|corpora|raw|processed|images|audio|text|videos?)$/i.test(name)) add(`${rootPath.replace(/\/$/, '')}/${name}`, 'server', '项目目录中存在该子目录（已核对存在）')
    }
    for (const task of props.tasks) {
      if (task.serverId === server.id && task.dataPath) add(task.dataPath, 'recent', `任务“${task.title}”使用过`)
    }
    if (candidates.length && token === revision.current) setDataCandidates(candidates)
  }
  function cancelAnalysis(): void {
    const id = requestId.current
    revision.current += 1
    requestId.current = null
    if (id) void window.labApi.intelligence.cancelProjectPreparation(id).catch(() => {})
    setBusy(false); setStage(plan ? 'review' : 'start'); setNotice('已取消分析；输入的项目与目标已保留。')
  }
  async function browse(path?: string): Promise<void> {
    if (!server || !accessRouteId) return
    setBrowser(current => current ? { ...current, busy: true, error: '' } : current)
    try {
      const view = await window.labApi.intelligence.browseRepositoryDirectory({ serverId: server.id, accessRouteId, path })
      setBrowser(current => current ? { ...current, view, busy: false } : current)
    } catch (caught) {
      setBrowser(current => current ? { ...current, busy: false, error: caught instanceof Error ? caught.message : String(caught) } : current)
    }
  }
  function openBrowser(mode: 'project' | 'data'): void {
    const start = mode === 'data'
      ? (plan?.draft.dataPath.trim().startsWith('/') ? plan.draft.dataPath.trim() : root.trim().startsWith('/') ? root.trim() : undefined)
      : (root.trim().startsWith('/') ? root.trim() : undefined)
    setBrowser({ mode, view: null, busy: true, error: '' })
    void browse(start)
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
  async function chooseEnvironment(name: string): Promise<void> {
    if (!plan) return
    if (!name) {
      pushHistory('改为使用服务器默认环境')
      updateDraft({ condaEnvironment: undefined }, { field: 'environment', state: { source: 'user', note: '使用服务器默认环境' } })
      setNotice('已改为使用服务器默认环境；运行时不激活 Conda。')
      return
    }
    const environment = envs.find(item => item.name === name)
    pushHistory(`环境设为 ${name}`)
    updateDraft({ condaEnvironment: { manager: 'conda', environmentName: name, environmentPrefix: undefined, lastCheckStatus: environment ? 'found' : 'unknown' } }, { field: 'environment', state: environment ? { source: 'server', note: '已在服务器的 Conda 环境列表中确认' } : { source: 'suggested', note: '这个环境名未在服务器列表中找到，请在运行前核对' } })
    setNotice(environment ? `已选择服务器环境 ${name}。` : `已填写 ${name}，但服务器环境列表中没有找到它，请核对。`)
    if (environment && server && accessRouteId) {
      setEnvChecking(true)
      try {
        const checked = await trustRemote(() => window.labApi.experiments.checkCondaEnvironment(server.id, accessRouteId, { manager: 'conda', environmentName: name }))
        const applyChecked = (condaEnvironment: NonNullable<ExperimentTaskDraft['condaEnvironment']>, state: PlanFieldState): void => {
          setPlan(current => current && current.draft.condaEnvironment?.environmentName === name
            ? { ...current, draft: { ...current.draft, condaEnvironment }, fields: { ...current.fields, environment: state } }
            : current)
          setDirty(true)
        }
        if (checked?.found) {
          applyChecked({ manager: 'conda', environmentName: name, environmentPrefix: undefined, lastCheckStatus: 'found', lastCheckedAt: new Date().toISOString(), pythonInterpreterPath: checked.pythonInterpreterPath, pythonVersion: checked.pythonVersion }, { source: 'server', note: `环境已在服务器确认${checked.pythonVersion ? ` · Python ${checked.pythonVersion}` : ''}` })
          setNotice(`环境 ${name} 已确认存在${checked.pythonVersion ? `，Python ${checked.pythonVersion}` : ''}。`)
        } else {
          setNotice(`服务器上没有找到环境 ${name}，已保留你的填写，请核对。`)
        }
      } catch (caught) {
        setNotice(caught instanceof Error ? caught.message : '环境检查失败')
      } finally {
        setEnvChecking(false)
      }
    }
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
  async function recheckPlan(): Promise<void> {
    if (!plan || !server || !accessRouteId || rechecking) return
    setRechecking(true)
    const lines: { ok: boolean; text: string }[] = []
    const codePath = plan.draft.codePath.trim()
    const entry = planCommandEntry(plan.draft.launchCommand)
    if (!codePath.startsWith('/')) lines.push({ ok: false, text: '代码目录还不是服务器绝对路径，无法核对' })
    else {
      try {
        await window.labApi.intelligence.browseRepositoryDirectory({ serverId: server.id, accessRouteId, path: codePath })
        lines.push({ ok: true, text: `启动目录存在：${codePath}` })
      } catch (caught) {
        lines.push({ ok: false, text: `启动目录未确认：${codePath} · ${caught instanceof Error ? caught.message : String(caught)}` })
      }
    }
    if (entry && !entry.startsWith('/') && !/\.(?:py|sh)$/.test(entry)) lines.push({ ok: true, text: `入口是模块或命令形式（${entry}），没有可核对的单独文件` })
    else if (entry && codePath.startsWith('/')) {
      try {
        const snapshot = await window.labApi.intelligence.inspectRepository({ source: 'remote', serverId: server.id, accessRouteId, path: codePath })
        const found = snapshot.files.some(file => file.path === entry || file.path.endsWith(`/${entry}`) || entry.endsWith(`/${file.path}`))
        lines.push({ ok: found, text: found ? `入口文件存在：${entry}` : `入口文件未在目录清单中找到：${entry}` })
      } catch (caught) {
        lines.push({ ok: false, text: `入口文件未能核对：${entry} · ${caught instanceof Error ? caught.message : String(caught)}` })
      }
    }
    const dataPath = plan.draft.dataPath.trim()
    if (dataPath.startsWith('/')) {
      try {
        await window.labApi.intelligence.browseRepositoryDirectory({ serverId: server.id, accessRouteId, path: dataPath })
        lines.push({ ok: true, text: `数据目录存在：${dataPath}` })
      } catch (caught) {
        lines.push({ ok: false, text: `数据目录未确认：${dataPath} · ${caught instanceof Error ? caught.message : String(caught)}` })
      }
    }
    setRecheckResult({ at: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), lines })
    setRechecking(false)
    const failed = lines.filter(line => !line.ok).length
    setNotice(failed ? `重新核对完成：${failed} 项需要确认。` : '重新核对完成：入口、启动目录和数据目录都可在服务器确认。')
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
    setNotice('已暂后补充，这项不会阻塞保存；可在卡片中随时补上。')
  }
  function editField(field: PlanField, value: string, key?: 'title' | 'dataPath' | 'artifactPath'): void {
    if (!plan) return
    if (key === 'title') updateDraft({ title: value }, { field, state: { source: 'user', note: '你修改了任务名称' } })
    else if (key === 'dataPath') updateDraft({ dataPath: value }, { field, state: { source: 'user', note: '你修改了数据目录' } })
    else if (key === 'artifactPath') updateDraft({ artifactPath: value }, { field, state: { source: 'user', note: '你修改了输出位置' } })
    else markField(field)
  }
  function submitRefine(): void {
    if (!plan || busy) return
    const instruction = refineText.trim()
    if (!instruction) { setNotice('请先写下要修改的内容。'); return }
    const result = refineExperimentPlan(plan, instruction, { environments: envs })
    if (result.conflicts.length) {
      setConflicts(current => [...current, ...result.conflicts.filter(conflict => !current.some(item => item.id === conflict.id))])
      setNotice(result.notes.join(' ') || '这些字段你手动改过，请选择保留哪个值。')
      return
    }
    if (!result.matched) { setNotice(result.notes.join(' ')); return }
    pushHistory(result.changes.map(change => change.summary).join('；'))
    setPlan({ ...plan, draft: result.draft, mode: result.mode, fields: result.fields })
    setDirty(true); setRefineText('')
    setNotice(`已更新：${result.changes.map(change => change.summary).join('；')}`)
  }
  function applyConflict(conflict: PlanConflict): void {
    if (!plan) return
    pushHistory(`采用建议：${conflict.label}`)
    const fields: PlanFields = { ...plan.fields, [conflict.suggestedField.field]: conflict.suggestedField.state }
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
  async function save(start: boolean): Promise<void> {
    if (!plan || !server) return
    if (savedTask && !dirty) {
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
      const saved = await window.labApi.experiments.save(draft)
      setSavedTask(saved)
      setPlan(current => current ? { ...current, draft: { ...current.draft, id: saved.id } } : current)
      setDirty(false)
      props.onChanged(saved)
      props.notify(start ? '实验草稿已保存，正在打开资源选择' : '实验草稿已保存；继续修改会更新这份草稿')
      if (start) props.onCreated(saved, true)
    } catch (caught) {
      props.notify(caught instanceof Error ? caught.message : '无法保存实验草稿', 'error')
    } finally {
      setSaving(null)
    }
  }
  async function leave(): Promise<void> {
    if (saving) { props.notify('正在保存实验草稿，请稍候'); return }
    if (busy) {
      const accepted = await props.confirm({ title: '取消分析并离开？', message: '项目分析尚未完成，离开后会取消本次分析。', confirmLabel: '取消分析并离开', tone: 'danger' })
      if (!accepted) return
      cancelAnalysis()
    }
    if (plan && dirty) {
      const accepted = await props.confirm({
        title: '离开实验准备？',
        message: savedTask ? '当前方案有未保存的修改，离开后这些修改不会写入草稿。' : '当前方案还没有保存为任务。离开后需要重新分析项目。',
        confirmLabel: '离开', tone: 'danger'
      })
      if (!accepted) return
    }
    props.onExit()
  }
  async function discover(): Promise<void> {
    if (!server || !accessRouteId || discovering) return
    setDiscovering(true); setDiscoverNote(''); setRepositories([])
    try {
      const found = await window.labApi.intelligence.discoverRepositories({ serverId: server.id, accessRouteId })
      setRepositories(found)
      setDiscoverNote(found.length ? `找到 ${found.length} 个带 .git 或 README 的目录，点击填入。` : '没有找到带 .git 或 README 的目录，请手动填写路径或浏览。')
    } catch (caught) {
      setDiscoverNote(caught instanceof Error ? caught.message : '扫描项目失败')
    } finally {
      setDiscovering(false)
    }
  }
  const recommendedMode = plan ? experimentModeFromGoal(plan.goal) : 'train'
  const launchCitations = plan ? planLaunchCitations(plan) : []
  const envName = plan ? planEnvironmentName(plan.draft) : ''
  const envState = plan?.fields.environment
  const activeGap = gaps[0]
  const lastMessageStage = messages.length ? messages[messages.length - 1].stage : undefined
  const coveredStages = new Set(messages.map(message => message.stage))

  return <section className="smart-create" aria-label="智能创建实验">
    <header className="smart-create-head">
      <button type="button" className="wb-text-button smart-back" onClick={() => void leave()}><ArrowLeft size={14} />返回实验任务</button>
      <div className="smart-create-title">
        <span className="smart-create-kicker"><Sparkles size={14} />智能创建</span>
        <h2>实验准备</h2>
        <p>说明项目与目标，系统完成项目理解、入口匹配和环境核对，再给出可审查的实验方案。</p>
      </div>
      <span className="smart-create-shared">与手动创建共用任务数据与 GPU 调度</span>
    </header>

    {stage === 'start' && <div className="smart-start">
      <div className="smart-start-main">
        <section className="smart-start-card">
          <header><span><Server size={15} /></span><div><h3>项目位置</h3><p>服务器上的代码目录</p></div></header>
          {realServers.length === 0 ? <p className="smart-inline-warning">还没有真实服务器。请先在「资源」中添加并确认 SSH 主机指纹。</p> : <>
            <div className="smart-server-row">
              <label>服务器<select value={serverId} onChange={event => { setServerId(event.target.value); setRouteId(''); resetSession(event.target.value, props.tasks.find(task => task.serverId === event.target.value && task.codePath)?.codePath ?? '') }}>{realServers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              {server && getAccessRoutes(server).length > 1 && <div className="smart-route"><span>连接路径</span><AccessRouteSelect server={server} value={accessRouteId} onChange={value => setRouteId(value)} /></div>}
            </div>
            <label className="smart-field">目录<div className="smart-path-row"><input aria-label="项目目录" value={root} onChange={event => { setRoot(event.target.value); resetSession(serverId, event.target.value) }} placeholder="/home/user/project" /><button type="button" className="secondary-button" disabled={!server} onClick={() => openBrowser('project')}><FolderOpen size={14} />浏览</button><button type="button" className="secondary-button" disabled={!server || discovering || !accessRouteId} onClick={() => void discover()}>{discovering ? <LoaderCircle size={14} className="spin" /> : <SlidersHorizontal size={14} />}扫描项目</button></div></label>
            {discoverNote && <p className="smart-note">{discoverNote}</p>}
            {root.trim() && !root.trim().startsWith('/') && <p className="smart-inline-warning">项目目录必须是服务器上的绝对路径。</p>}
            {repositories.length > 0 && <div className="smart-candidates">{repositories.map(repository => <button type="button" key={repository.path} onClick={() => { setRoot(repository.path); resetSession(serverId, repository.path) }}><FolderOpen size={13} /><span>{repository.name}<small>{repository.path}</small></span></button>)}</div>}
            {visibleRecent.length > 0 && <div className="smart-recent"><span>最近项目</span><div>{visibleRecent.map(item => <button type="button" key={`${item.serverId}:${item.path}`} onClick={() => { setServerId(item.serverId); setRouteId(''); setRoot(item.path); resetSession(item.serverId, item.path) }}><FolderOpen size={13} /><span>{item.name}<small>{item.serverId === serverId ? item.path : `${item.serverName} · ${item.path}`}</small></span></button>)}</div></div>}
          </>}
        </section>
        <section className="smart-start-card">
          <header><span><Sparkles size={15} /></span><div><h3>想做什么</h3><p>用一句实验目的描述即可</p></div></header>
          <textarea aria-label="实验目标" rows={4} maxLength={2000} value={goal} onChange={event => setGoal(event.target.value)} placeholder="例如：先跑一次基线 / 评估已有权重 / 复现 README 的训练配置" />
          <div className="smart-goal-examples">{['先跑一次基线', '评估已有权重', '复现 README 的训练配置'].map(example => <button type="button" key={example} onClick={() => setGoal(example)}>{example}</button>)}</div>
          <p className="smart-note">环境、命令、数据位置和任务名称由系统在分析后给出；这里不需要先填写整套表单。</p>
        </section>
      </div>
      {props.modelEnabled === false && <div className="smart-model-warning"><AlertTriangle size={15} /><span>模型尚未启用，系统无法完成项目理解。</span><button type="button" className="wb-text-button" onClick={props.onModelSettings}>前往模型设置</button><button type="button" className="wb-text-button" onClick={props.onManualCreate}>改为手动创建</button></div>}
      {error && <div className="intel-error" role="alert">{error}</div>}
      {notice && <p className="smart-note" role="status">{notice}</p>}
      <footer className="smart-start-footer">
        <div><button type="button" className="primary-button smart-analyze" disabled={!canAnalyze} onClick={() => void analyze()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}分析项目并准备实验</button><button type="button" className="secondary-button" onClick={props.onManualCreate}>手动创建</button></div>
        <p>只读取项目文件与环境清单，不安装、不运行；勾选文件内容会发送给已配置模型，保存草稿时才创建任务。</p>
      </footer>
    </div>}

    {stage !== 'start' && <div className="smart-workbench">
      <section className={`smart-progress ${stage === 'analyzing' ? 'running' : 'done'}`} aria-label="项目理解进度">
        <header><div><h2>{stage === 'analyzing' ? '正在准备实验' : '项目理解过程'}</h2><p>{root.trim()} · {goal.trim()}</p></div>{stage === 'analyzing' && <button type="button" className="secondary-button" onClick={cancelAnalysis}>取消分析</button>}</header>
        <ol>{stageOrder.map((item, index) => {
          const itemMessages = messages.filter(message => message.stage === item.key)
          const active = stage === 'analyzing' && item.key === lastMessageStage
          const complete = coveredStages.has(item.key) && !active
          return <li key={item.key} className={`${complete ? 'complete' : ''} ${active ? 'active' : ''}`}>
            <span className="smart-progress-mark">{complete && !active ? <CheckCircle2 size={15} /> : active ? <LoaderCircle size={15} className="spin" /> : <Circle size={13} />}</span>
            <div><strong>{item.label}</strong>{itemMessages.length === 0 ? <small>{item.hint}</small> : itemMessages.map(message => <p key={message.id} className={message.tone === 'warn' ? 'warn' : ''}>{message.text}</p>)}</div>
          </li>
        })}</ol>
        {snapshot && <details className="smart-scope" open={scopeOpen} onToggle={event => setScopeOpen((event.target as HTMLDetailsElement).open)}>
          <summary>分析范围 · 已选 {files.length} / {snapshot.files.length} 个相关文件 · 可展开调整</summary>
          <div className="smart-scope-actions"><button type="button" className="wb-text-button" disabled={busy} onClick={() => setFiles(snapshot.files.map(file => file.path))}>全选</button><button type="button" className="wb-text-button" disabled={busy} onClick={() => setFiles([])}>清空</button><button type="button" className="secondary-button" disabled={busy || !files.length} onClick={() => void analyze({ snapshot, files })}>按此范围重新分析</button></div>
          <p className="smart-note">仅勾选文件的内容会发送给模型用于项目理解；取消勾选的文件不会读取或发送。</p>
          <div className="smart-scope-list">{snapshot.files.map(file => <label key={file.path}><input type="checkbox" disabled={busy} checked={files.includes(file.path)} onChange={event => setFiles(current => event.target.checked ? [...current, file.path] : current.filter(path => path !== file.path))} /><span>{file.path}</span></label>)}</div>
          {snapshot.warnings.map((warning, index) => <p key={index} className="smart-note">{warning}</p>)}
        </details>}
        {error && <div className="intel-error" role="alert">{error}</div>}
        {stage === 'analyzing' && notice && <p className="smart-note" role="status">{notice}</p>}
      </section>

      {plan && stage === 'review' && <div className="smart-plan">
        <header className="smart-plan-head">
          <div><span className="smart-plan-state"><CheckCircle2 size={14} />方案已生成</span><h2>{plan.draft.title || '本次实验'}</h2><p>{plan.summary}</p></div>
          <div className="smart-plan-meta"><span><FileCode2 size={13} />{launchCitations.length + plan.guide.snapshot.excerpts.length} 处文件依据</span><span><Server size={13} />{plan.guide.checks.filter(check => check.status === 'confirmed').length} 项服务器路径核对</span><button type="button" className="wb-text-button" onClick={() => void leave()}>放弃方案</button></div>
        </header>
        <div className="smart-plan-grid">
          <article className="smart-card">
            <header><div className="smart-card-icon"><Sparkles size={16} /></div><div><h3>本次实验</h3><p>目标、任务名称与运行方式</p></div><SourceBadge state={plan.fields.mode} /></header>
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
            <header><div className="smart-card-icon"><Code2 size={16} /></div><div><h3>运行方式</h3><p>入口、配置文件与实际命令</p></div><SourceBadge state={plan.fields.launchCommand} /></header>
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
            <header><div className="smart-card-icon"><Database size={16} /></div><div><h3>环境与数据</h3><p>运行环境和本次使用的数据</p></div><SourceBadge state={envState} /></header>
            <label className="smart-field">推荐环境<select aria-label="推荐环境" value={envName} disabled={busy || envChecking} onChange={event => void chooseEnvironment(event.target.value)}>
              <option value="">不使用 Conda（服务器默认环境）</option>
              {envs.map(environment => <option key={environment.prefix} value={environment.name}>{environment.name} · {environment.prefix}</option>)}
              {envName && !envs.some(environment => environment.name === envName) && <option value={envName}>{envName}（未在服务器找到）</option>}
            </select></label>
            <p className="smart-verify">{envLoading ? '正在读取服务器环境…' : envChecking ? '正在检查所选环境…' : envName ? (envs.some(environment => environment.name === envName) ? '已在服务器确认这个环境存在' : '服务器环境列表中没有这个名字，请在运行前核对') : '将直接使用登录 shell 的 Python'}</p>
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
        </section> : <p className="smart-gap-ok"><CheckCircle2 size={15} />启动所需的信息已经齐备，可以保存草稿或直接选择资源。</p>}

        {deferredGaps.length > 0 && <p className="smart-note">已暂后补充 {deferredGaps.length} 项（{deferredGaps.map(id => id === 'data' ? '数据' : id === 'environment' ? '环境' : '入口').join('、')}），不会阻塞保存。<button type="button" className="wb-text-button" onClick={() => setDeferredGaps([])}>重新查看</button></p>}

        {plan.questions.length > 0 && <details className="smart-questions"><summary>项目分析提出的其他确认事项 · {plan.questions.length}</summary><ul>{plan.questions.map((question, index) => <li key={index}>{question}</li>)}</ul><p className="smart-note">这些事项不阻塞保存，可在「编辑完整配置」或任务备注中补充。</p></details>}
        {[...new Set([...plan.guide.warnings, ...plan.guide.snapshot.warnings])].length > 0 && <details className="smart-questions"><summary>分析警告与读取范围说明 · {new Set([...plan.guide.warnings, ...plan.guide.snapshot.warnings]).size}</summary><ul>{[...new Set([...plan.guide.warnings, ...plan.guide.snapshot.warnings])].map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}

        <section className="smart-refine" aria-label="继续修改方案">
          <label htmlFor="smart-refine-input"><Sparkles size={14} />继续修改这份方案</label>
          <div className="smart-refine-row"><input id="smart-refine-input" value={refineText} onChange={event => setRefineText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); submitRefine() } }} placeholder="例如：改成只评估已有权重 / 使用 vision 环境 / 先跑少量数据验证流程" /><button type="button" className="secondary-button" disabled={busy || !refineText.trim()} onClick={submitRefine}>修改方案</button></div>
          <div className="smart-goal-examples">{['改成只评估已有权重', '使用 vision 环境', '先跑少量数据验证流程'].map(example => <button type="button" key={example} onClick={() => setRefineText(example)}>{example}</button>)}</div>
          {(notice || history.length > 0) && <div className="smart-refine-feedback">{notice && <p className="smart-refine-note" role="status">{notice}</p>}{history.length > 0 && <button type="button" className="wb-text-button" onClick={undo}><Undo2 size={13} />撤销上次修改</button>}</div>}
          {conflicts.map(conflict => <div className="smart-conflict" role="alert" key={conflict.id}><strong>{conflict.label}已被你手动修改</strong><p>当前：<code>{conflict.current || '未填写'}</code><br />建议：<code>{conflict.suggested}</code></p><div><button type="button" className="primary-button" onClick={() => applyConflict(conflict)}>采用新值</button><button type="button" className="secondary-button" onClick={() => keepConflict(conflict)}>保留我的</button></div></div>)}
        </section>

        {history.length > 0 && <details className="smart-history"><summary>本次修改记录 · {history.length} 项</summary><ol>{history.map(entry => <li key={entry.id}><time>{entry.at}</time><span>{entry.label}</span></li>)}</ol><div><button type="button" className="wb-text-button" onClick={resetPlan}><RotateCcw size={13} />恢复初始方案</button></div></details>}

        {recheckResult && <details className="smart-questions" open><summary>服务器路径核对 · {recheckResult.at}</summary><ul>{recheckResult.lines.map((line, index) => <li key={index} className={line.ok ? '' : 'smart-recheck-failed'}>{line.ok ? '✓' : '×'} {line.text}</li>)}</ul><p className="smart-note">这是只读检查，不会运行任何命令；运行时还会再次检查。</p></details>}

        {!server && <p className="smart-inline-warning">原服务器已不可用，当前方案无法保存。请返回任务池重新选择服务器并分析。</p>}
        <footer className="smart-plan-footer">
          <div><button type="button" className="secondary-button" onClick={editFullConfig}><SlidersHorizontal size={14} />编辑完整配置</button><button type="button" className="secondary-button" disabled={rechecking || saving !== null} onClick={() => void recheckPlan()}>{rechecking ? <LoaderCircle size={14} className="spin" /> : <Server size={14} />}重新核对路径</button><span className="smart-footer-hint">返回方案后仍可继续让系统检查与修改。</span></div>
          <div className="smart-plan-save">
            {savedTask && <span className="smart-saved"><CheckCircle2 size={14} />草稿已保存{!dirty ? '' : ' · 有未保存修改'}<button type="button" className="wb-text-button" disabled={saving !== null} onClick={() => props.onOpenTask(savedTask)}>在任务池查看</button></span>}
            <button type="button" className="secondary-button" disabled={!canSave} onClick={() => void save(false)}>{saving === 'draft' ? <><LoaderCircle size={14} className="spin" />保存中…</> : <><Save size={14} />保存草稿</>}</button>
            <button type="button" className="primary-button" disabled={!canSave} onClick={() => void save(true)}>{saving === 'start' ? <><LoaderCircle size={14} className="spin" />准备资源…</> : <><Play size={14} />创建并选择资源</>}</button>
          </div>
        </footer>
      </div>}
    </div>}

    {browser && <div className="app-modal-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !browser.busy) setBrowser(null) }}>
      <section className="app-modal smart-browser" role="dialog" aria-modal="true" aria-label={browser.mode === 'project' ? '选择项目目录' : '选择数据目录'}>
        <header className="dialog-header app-modal-header"><div className="dialog-title-wrap app-modal-title"><div className="dialog-icon"><FolderOpen size={18} /></div><div><h2>{browser.mode === 'project' ? '选择项目目录' : '选择数据目录'}</h2><p>{browser.view?.path ?? '正在读取服务器目录'}</p></div></div><button type="button" className="icon-button" onClick={() => setBrowser(null)} aria-label="关闭" disabled={browser.busy}><X size={16} /></button></header>
        <div className="smart-browser-body">
          {browser.busy ? <p className="smart-note"><LoaderCircle size={14} className="spin" /> 正在读取目录…</p> : browser.error ? <div><p className="intel-error" role="alert">{browser.error}</p><button type="button" className="secondary-button" onClick={() => void browse(browser.view?.path)}>重试</button></div> : browser.view ? <>
            <div className="smart-browser-path"><code>{browser.view.path}</code><div><button type="button" className="wb-text-button" onClick={() => void browse(browser.view!.home)}>主目录</button>{browser.view.parent && <button type="button" className="wb-text-button" onClick={() => void browse(browser.view!.parent ?? undefined)}>上一级</button>}</div></div>
            <div className="smart-browser-list">{browser.view.entries.map(entry => <button type="button" key={entry.path} onClick={() => void browse(entry.path)}><FolderOpen size={14} /><span>{entry.name}</span></button>)}{browser.view.entries.length === 0 && <p className="smart-note">没有子目录</p>}</div>
          </> : null}
        </div>
        <footer className="dialog-footer app-modal-footer"><button type="button" className="secondary-button" onClick={() => setBrowser(null)} disabled={browser.busy}>取消</button><button type="button" className="primary-button" disabled={!browser.view || browser.busy} onClick={() => browser.view && chooseBrowserPath(browser.view.path)}>选择此目录</button></footer>
      </section>
    </div>}
  </section>
}
