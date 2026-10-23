import type { RepositoryCitation, RepositoryGuide, RepositorySnapshot } from './repository-guide'
import { isRepositoryLaunchCommand } from './repository-guide'
import { commandDataPath, projectConfigurationKey, projectDraftPatch, syncCommandDataPath } from './project-task'
import type { CondaEnvironmentInfo, ExperimentTaskDraft } from './types'

/**
 * Experiment preparation plan: a small, explainable layer between a repository
 * analysis and the shared task draft. Everything here is pure so the renderer can
 * revise a plan field by field and the main process can keep owning execution.
 */

export type ExperimentMode = 'train' | 'evaluate'
export type PlanSource = 'file' | 'server' | 'suggested' | 'user' | 'recent'
export const planSourceLabels: Record<PlanSource, string> = {
  file: '项目文件', server: '服务器核对', suggested: '系统建议', user: '你的修改', recent: '最近使用'
}
export const planModeLabels: Record<ExperimentMode, string> = { train: '训练基线', evaluate: '评估已有权重' }
export type PlanField = 'title' | 'objective' | 'mode' | 'codePath' | 'launchCommand' | 'dataPath' | 'environment' | 'artifactPath'
export interface PlanFieldState { source: PlanSource; note?: string }
export type PlanFields = Partial<Record<PlanField, PlanFieldState>>

export interface ProjectEntry { path: string; kind: 'train' | 'evaluate' | 'other' | 'unknown' }
export interface MetricMention { key: string; label: string; citation: RepositoryCitation }
export interface ProjectSignals {
  entries: ProjectEntry[]
  configs: string[]
  dependencyFiles: string[]
  dataDirs: string[]
  outputDirs: string[]
  metrics: MetricMention[]
  hasReadme: boolean
}
export interface PlanEntryOption {
  id: string
  mode: ExperimentMode
  command: string
  workingDirectory: string
  reason: string
  origin: 'documented' | 'suggested'
  citation?: RepositoryCitation
}
export interface PlanDataCandidate { path: string; source: PlanSource; note: string }
export interface PlanGapOption {
  id: string
  label: string
  description?: string
  value: string
  source: PlanSource
  environment?: { name: string; prefix?: string; pythonVersion?: string }
  entry?: { mode: ExperimentMode; command: string; workingDirectory: string; origin: 'documented' | 'suggested'; citation?: RepositoryCitation }
}
export interface PlanGap {
  id: string
  kind: 'data' | 'environment' | 'entry'
  field: PlanField
  question: string
  detail?: string
  options: PlanGapOption[]
  allowBrowse: boolean
  allowLater: boolean
}
export interface PlanChange { field: PlanField | 'mode' | 'resources'; label: string; summary: string }
export interface PlanConflict {
  id: string
  label: string
  current: string
  suggested: string
  suggestedDraft: Partial<ExperimentTaskDraft>
  suggestedFields?: PlanFields
  suggestedMode?: ExperimentMode
  suggestedField: { field: PlanField; state: PlanFieldState }
}
export interface ExperimentPlan {
  goal: string
  guide: RepositoryGuide
  mode: ExperimentMode
  draft: ExperimentTaskDraft
  entryOptions: PlanEntryOption[]
  signals: ProjectSignals
  fields: PlanFields
  questions: string[]
  summary: string
  createdAt: string
}
export interface PlanContext {
  environments?: CondaEnvironmentInfo[]
  dataCandidates?: PlanDataCandidate[]
}
export interface PlanResolution { draft: ExperimentTaskDraft; mode: ExperimentMode; fields: PlanFields; change: PlanChange }
export interface RefineResult {
  draft: ExperimentTaskDraft
  mode: ExperimentMode
  fields: PlanFields
  changes: PlanChange[]
  conflicts: PlanConflict[]
  notes: string[]
  matched: boolean
}

const emptyDraft = (): ExperimentTaskDraft => ({
  title: '', project: '', objective: '', tags: [], priority: 'normal', status: 'planned',
  codePath: '', dataPath: '', launchCommand: '', launchMode: 'command', scriptPath: '', artifactPath: '', resultSummary: '', notes: ''
})
const clean = (path: string): string => path.replace(/\/+$/, '')
export const planBaseName = (path: string): string => clean(path).split('/').pop() ?? ''
export const planDirName = (path: string): string => {
  const index = clean(path).lastIndexOf('/')
  return index <= 0 ? '' : clean(path).slice(0, index)
}
const joinPath = (root: string, relative: string): string => {
  const base = clean(root) || '/'
  const part = relative.replace(/^\.\//, '').replace(/\/+$/, '')
  if (!part) return base || '/'
  return `${base === '/' ? '' : base}/${part}`
}
const normalizedRelative = (path: string): string => {
  const parts: string[] = []
  for (const part of path.replace(/^\.\//, '').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { parts.pop(); continue }
    parts.push(part)
  }
  return parts.join('/')
}
const relativeTo = (root: string, path: string): string => {
  const base = clean(root)
  if (!path.startsWith(`${base}/`)) return path
  return normalizedRelative(path.slice(base.length + 1))
}
const lineCitation = (path: string, startLine: number, line: string): RepositoryCitation => ({ path, startLine, endLine: startLine, quote: line })
const sortedUnique = (values: string[]): string[] => [...new Set(values.filter(Boolean))]
const depth = (path: string): number => path.split('/').length

/** Compare the last mention so "先训练再评估" follows the final intent. */
function lastIndex(text: string, pattern: RegExp): number {
  let index = -1
  for (const match of text.matchAll(pattern)) index = match.index ?? -1
  return index
}
export function experimentModeFromGoal(goal: string): ExperimentMode {
  const evaluate = lastIndex(goal, /评估|评测|推理|evaluate|evaluation|inference|\beval\b/gi)
  const train = lastIndex(goal, /训练|微调|基线|复现|train|finetune|baseline/gi)
  if (evaluate < 0 && train < 0) return 'train'
  return evaluate > train ? 'evaluate' : 'train'
}

export function classifyEntryFile(path: string): ProjectEntry['kind'] | undefined {
  const name = planBaseName(path).toLowerCase()
  if (!/\.(py|sh)$/.test(name)) return undefined
  const stem = name.replace(/\.(py|sh)$/, '')
  if (/^(train|finetune|finetuning|pretrain|run_train|train_[a-z0-9_]+|[a-z0-9_]+_train)$/.test(stem)) return 'train'
  if (/^(eval|evaluate|evaluation|test|infer|inference|predict|run_eval|eval_[a-z0-9_]+)$/.test(stem)) return 'evaluate'
  if (/^(main|run|launch|start)$/.test(stem)) return 'other'
  return undefined
}

const METRICS: { key: string; label: string; pattern: RegExp }[] = [
  { key: 'accuracy', label: '准确率 Accuracy', pattern: /\baccuracy\b|\bacc(?:@1)?\b|准确率/i },
  { key: 'f1', label: 'F1 分数', pattern: /\bf1(?:[-_ ]?score)?\b|F1/i },
  { key: 'auc', label: 'AUC', pattern: /\bauc\b|AUC/i },
  { key: 'precision', label: '精确率 Precision', pattern: /\bprecision\b|精确率/i },
  { key: 'recall', label: '召回率 Recall', pattern: /\brecall\b|召回率/i },
  { key: 'bleu', label: 'BLEU', pattern: /\bbleu\b|BLEU/i },
  { key: 'rouge', label: 'ROUGE', pattern: /\brouge(?:-[a-z0-9]+)?\b|ROUGE/i },
  { key: 'map', label: 'mAP', pattern: /\bmAP\b|\bmean average precision\b/i },
  { key: 'iou', label: 'IoU', pattern: /\biou\b|IoU/i },
  { key: 'dice', label: 'Dice', pattern: /\bdice(?: score)?\b|Dice/i },
  { key: 'psnr', label: 'PSNR', pattern: /\bpsnr\b|PSNR/i },
  { key: 'ssim', label: 'SSIM', pattern: /\bssim\b|SSIM/i },
  { key: 'loss', label: 'Loss', pattern: /\bloss\b|损失/i },
  { key: 'perplexity', label: '困惑度 Perplexity', pattern: /\bperplexity\b|\bppl\b/i },
  { key: 'wer', label: 'WER', pattern: /\bwer\b|WER/i },
  { key: 'cer', label: 'CER', pattern: /\bcer\b|CER/i },
  { key: 'rmse', label: 'RMSE', pattern: /\brmse\b|RMSE/i },
  { key: 'mae', label: 'MAE', pattern: /\bmae\b|MAE/i }
]

export const isReadmePath = (path: string): boolean => /(^|\/)readme(?:\.|$)/i.test(path)
const isDependencyPath = (path: string): boolean => /(^|\/)(environment\.ya?ml|requirements[^/]*\.txt|pyproject\.toml|pipfile|setup\.py|setup\.cfg)$/i.test(path)
const isConfigPath = (path: string): boolean =>
  /(^|\/)(configs?|conf|options?|args?|params?|hparams?|defaults?)(\/|\.|$)/i.test(path)
  && /\.(ya?ml|json|toml|ini|cfg|py)$/i.test(path)
  && !isDependencyPath(path) && !isReadmePath(path)

/** Read-only structure of the repository; no model, no execution. */
export function projectSignals(snapshot: RepositorySnapshot): ProjectSignals {
  const paths = snapshot.files.map(file => file.path)
  const entries: ProjectEntry[] = []
  for (const path of [...paths].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))) {
    const kind = classifyEntryFile(path)
    if (kind && !entries.some(entry => entry.path === path)) entries.push({ path, kind })
  }
  const dependencyFiles = paths.filter(isDependencyPath).sort((a, b) => depth(a) - depth(b)).slice(0, 6)
  const configs = sortedUnique(paths.filter(isConfigPath)).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)).slice(0, 8)
  const dataDirs: string[] = []
  const outputDirs: string[] = []
  for (const excerpt of snapshot.excerpts) {
    const text = excerpt.text
    for (const match of text.matchAll(/(?:^|[\s"'`(=])((?:\.\/)?(?:data|datasets?|corpus|corpora)\/[A-Za-z0-9_./-]+)/g)) {
      const value = match[1].replace(/^\.\//, '').replace(/[.,;:)）】，。；、]+$/, '')
      if (value && !dataDirs.includes(value)) dataDirs.push(value)
    }
    for (const match of text.matchAll(/(?:^|[\s"'`(=])((?:\.\/)?(?:runs|outputs?|checkpoints?|logs)\/[A-Za-z0-9_./-]+)/g)) {
      const value = match[1].replace(/^\.\//, '').replace(/[.,;:)）】，。；、]+$/, '')
      if (value && !outputDirs.includes(value)) outputDirs.push(value)
    }
  }
  const metrics: MetricMention[] = []
  const sources = snapshot.excerpts.filter(excerpt => isReadmePath(excerpt.path) || isConfigPath(excerpt.path))
  for (const metric of METRICS) {
    for (const excerpt of sources) {
      const lines = excerpt.text.split('\n')
      const index = lines.findIndex(line => metric.pattern.test(line))
      if (index < 0) continue
      metrics.push({ key: metric.key, label: metric.label, citation: lineCitation(excerpt.path, excerpt.startLine + index, lines[index].trim().slice(0, 300)) })
      break
    }
    if (metrics.length >= 8) break
  }
  return { entries, configs, dependencyFiles, dataDirs: dataDirs.slice(0, 6), outputDirs: outputDirs.slice(0, 6), metrics, hasReadme: paths.some(isReadmePath) }
}

/** Default reading scope: the files that explain how this project is run. */
export function recommendProjectFiles(files: { path: string; sizeBytes: number }[], goal: string, limit = 40): string[] {
  const mode = experimentModeFromGoal(goal)
  const priority = (path: string): number => {
    if (isReadmePath(path)) return 0
    if (isDependencyPath(path)) return 1
    if (isConfigPath(path)) return 2
    const kind = classifyEntryFile(path)
    if (kind === mode) return 3
    if (kind === 'other') return 4
    if (kind) return 5
    return /\.(md|rst)$/i.test(path) ? 6 : 7
  }
  const ordered = [...files].sort((a, b) => priority(a.path) - priority(b.path) || depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))
  const picked: string[] = []
  const add = (path: string | undefined): void => { if (path && !picked.includes(path)) picked.push(path) }
  for (const modeEntry of ordered.filter(file => classifyEntryFile(file.path) === mode)) add(modeEntry.path)
  for (const file of ordered) if (priority(file.path) <= 2) add(file.path)
  for (const file of ordered) if (classifyEntryFile(file.path) === 'other') add(file.path)
  const directories = sortedUnique(picked.map(path => planDirName(path)))
  for (const file of ordered) if (directories.includes(planDirName(file.path))) add(file.path)
  for (const file of ordered) { if (picked.length >= limit) break; add(file.path) }
  return picked.slice(0, limit)
}

function commandEntry(path: string): string | undefined {
  const tokens = path.split(/\s+/)
  return tokens.find(token => /\.(?:py|sh)$/.test(token))
}
export function planCommandEntry(command: string): string | undefined {
  const entry = commandEntry(command)
  if (entry) return entry
  const module = /^\s*(?:python(?:3(?:\.\d+)?)?|torchrun|accelerate|bash)\s+(?:-m\s+)?([A-Za-z_][\w.]*)/.exec(command)
  return module?.[1]
}
export function planCommandConfig(command: string): string | undefined {
  const match = /--(?:config|cfg|config[-_]file|config[-_]path)[=\s]+("[^"]+"|'[^']+'|[^\s]+)/i.exec(command)
  if (!match) return undefined
  return match[1].replace(/^["']|["']$/g, '')
}
function commandMode(command: string): ExperimentMode | undefined {
  const entry = commandEntry(command)
  const kind = entry ? classifyEntryFile(entry) : undefined
  if (kind === 'train') return 'train'
  if (kind === 'evaluate') return 'evaluate'
  if (/--(?:mode|stage|task)\s+(?:eval|evaluate|test)\b/i.test(command)) return 'evaluate'
  if (/--(?:mode|stage|task)\s+(?:train|fit)\b/i.test(command)) return 'train'
  return undefined
}
function readingWorkingDirectory(command: string, guide: RepositoryGuide, known: Set<string>): string {
  const entry = commandEntry(command)
  if (!entry || entry.startsWith('/')) return guide.workingDirectory
  const relative = normalizedRelative(entry)
  const candidates = [joinPath(guide.workingDirectory, relative).replace(/^\/+/, ''), relative]
  const hit = candidates.find(candidate => known.has(candidate))
  return hit ? planDirName(hit) : guide.workingDirectory
}

export function planEntryOptions(snapshot: RepositorySnapshot, guide: RepositoryGuide, goal: string): PlanEntryOption[] {
  const options: PlanEntryOption[] = []
  const known = new Set(snapshot.files.map(file => file.path))
  const add = (option: PlanEntryOption): void => {
    if (!option.command.trim()) return
    if (options.some(item => item.command === option.command && item.mode === option.mode)) return
    options.push(option)
  }
  for (const excerpt of snapshot.excerpts.filter(file => isReadmePath(file.path))) {
    let section = ''
    const lines = excerpt.text.split('\n')
    lines.forEach((raw, index) => {
      const heading = /^\s*#{1,6}\s+(.*)$/.exec(raw)
      if (heading) { section = heading[1].trim(); return }
      const line = raw.trim().replace(/^\$\s+/, '').replace(/^>\s*/, '').replace(/\s+#.*$/, '')
      if (!line || line.endsWith('\\')) return
      if (!isRepositoryLaunchCommand(line)) return
      if (/<[^>]+>|\$\{|\b(?:YOUR_[A-Z_]+|TODO|REPLACE_ME)\b/i.test(line)) return
      let mode = commandMode(line)
      if (!mode && /评估|测试|推理|evaluation|inference|testing/i.test(section)) mode = 'evaluate'
      if (!mode && /训练|微调|training|finetune/i.test(section)) mode = 'train'
      if (!mode) return
      const workingDirectory = readingWorkingDirectory(line, guide, known)
      add({
        id: `${mode}-readme-${index}`,
        mode,
        command: line,
        workingDirectory,
        reason: section ? `README「${section}」给出了该命令` : 'README 中直接给出了该命令',
        origin: 'documented',
        citation: lineCitation(excerpt.path, excerpt.startLine + index, raw.trim())
      })
    })
  }
  // A command the analysis already trusted is always an option for its own mode.
  const guideMode = commandMode(guide.launchCommand) ?? experimentModeFromGoal(goal)
  if (guide.launchCommand) add({
    id: `guide-${guideMode}`,
    mode: guideMode,
    command: guide.launchCommand,
    workingDirectory: guide.workingDirectory,
    reason: guide.launchOrigin === 'documented' ? '项目分析读取到的启动命令' : '项目分析建议的最小命令',
    origin: guide.launchOrigin === 'documented' ? 'documented' : 'suggested',
    citation: guide.launchCitations[0]
  })
  const signals = projectSignals(snapshot)
  for (const mode of ['train', 'evaluate'] as const) {
    if (options.some(option => option.mode === mode)) continue
    const entry = signals.entries.find(item => item.kind === mode)
    if (!entry) continue
    const command = /\.sh$/i.test(entry.path) ? `bash ${entry.path}` : `python ${entry.path}`
    add({
      id: `${mode}-file`,
      mode,
      command,
      workingDirectory: planDirName(entry.path),
      reason: `项目中有入口 ${entry.path}，但没有找到文档命令；这是系统建议的最小命令`,
      origin: 'suggested'
    })
  }
  return options.sort((a, b) => (a.mode === b.mode ? (a.origin === b.origin ? 0 : a.origin === 'documented' ? -1 : 1) : a.mode === 'train' ? -1 : 1))
}

function inferArtifactPath(command: string, root: string, codePath: string, signals: ProjectSignals, now: Date): { value: string; source: PlanSource; note: string } {
  const flag = command.match(/--(?:output[-_]?dir|save[-_]?dir|checkpoint[-_]?dir|log[-_]?dir)[=\s]+("[^"]+"|'[^']+'|[^\s]+)/i)
  if (flag) {
    const value = flag[1].replace(/^["']|["']$/g, '').replace(/^\.\//, '')
    if (value.startsWith('/')) return { value, source: 'file', note: '来自启动命令中的输出参数' }
    if (/^[A-Za-z0-9_./-]+$/.test(value)) return { value: joinPath(codePath, value), source: 'file', note: '来自启动命令中的输出参数（相对启动目录）' }
  }
  if (signals.outputDirs.length) {
    const relative = signals.outputDirs[0]
    return { value: joinPath(root, relative), source: 'file', note: `README/配置中提到 ${relative}` }
  }
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  return { value: joinPath(codePath, `runs/exp-${stamp}`), source: 'suggested', note: '系统建议的本次输出目录，可改为项目已有位置' }
}

function dataPathField(guide: RepositoryGuide): PlanFieldState {
  const path = guide.dataPath
  if (!path) return { source: 'suggested', note: '尚未从项目文件或命令中确定数据位置' }
  const warning = guide.warnings.find(item => item.includes(path))
  if (warning?.includes('已确认存在')) return { source: 'server', note: '数据目录已在服务器确认存在；是否本次数据仍需核对' }
  if (warning?.includes('仓库内')) return { source: 'server', note: warning }
  if (warning?.includes('启动命令参数')) return { source: 'file', note: warning }
  return { source: 'suggested', note: '数据目录来自分析建议，尚未在服务器核对' }
}

export function suggestPlanTitle(root: string, mode: ExperimentMode): string {
  const name = planBaseName(root) || '新实验'
  return `${name.slice(0, 120)} · ${planModeLabels[mode]}`.slice(0, 150)
}

export interface CreatePlanInput {
  guide: RepositoryGuide
  goal: string
  environments?: CondaEnvironmentInfo[]
  now?: Date
}
export function createExperimentPlan({ guide, goal, environments = [], now = new Date() }: CreatePlanInput): ExperimentPlan {
  const root = clean(guide.snapshot.input.path) || '/'
  const projectName = planBaseName(root) || '新实验'
  const signals = projectSignals(guide.snapshot)
  const entryOptions = planEntryOptions(guide.snapshot, guide, goal)
  const goalMode = experimentModeFromGoal(goal)
  let mode = goalMode
  // The goal may say "baseline" while the project only documents an evaluation entry.
  // Do not pair a training label with an evaluation command.
  if (!entryOptions.some(option => option.mode === mode) && guide.launchCommand) {
    const actual = commandMode(guide.launchCommand)
    if (actual && (!entryOptions.length || entryOptions.some(option => option.mode === actual))) mode = actual
  }
  const usableEntry = entryOptions.find(option => option.mode === mode && option.origin === 'documented')
    ?? entryOptions.find(option => option.mode === mode)
  const guideCommandMode = guide.launchCommand ? commandMode(guide.launchCommand) : undefined
  const useGuideCommand = Boolean(guide.launchCommand) && (!guideCommandMode || guideCommandMode === mode || !usableEntry)
  const launchCommand = (useGuideCommand ? guide.launchCommand : usableEntry?.command) || guide.launchCommand || usableEntry?.command || ''
  const workingDirectory = useGuideCommand
    ? guide.workingDirectory
    : usableEntry?.workingDirectory ?? guide.workingDirectory
  const codePath = workingDirectory ? joinPath(root, workingDirectory) : root
  const base = projectDraftPatch(guide, { ...emptyDraft(), objective: goal })
  const artifact = inferArtifactPath(launchCommand, root, codePath, signals, now)
  const environment = guide.environmentName
  const environmentVerified = !!environment && environments.some(item => item.name === environment || item.prefix === environment)
  const directoryCheck = guide.checks.find(check => check.expected === 'directory' && (check.path === (workingDirectory || '.') || check.path === workingDirectory))
  const commandEntryToken = planCommandEntry(launchCommand)
  const entryCheck = guide.checks.find(check => check.expected === 'file' && check.status === 'confirmed'
    && (check.path === commandEntryToken || (commandEntryToken && check.path.endsWith(`/${commandEntryToken}`))))
  const chosenEntry = entryOptions.find(option => option.command.trim() === launchCommand.trim())
  const commandNote = chosenEntry?.reason ?? (guide.launchOrigin === 'documented' ? '项目分析读取到的启动命令' : '项目分析建议的最小命令')
  // When the goal selects a different entry, prefer that entry's own explicit data argument.
  const entryDataPath = !useGuideCommand ? commandDataPath(launchCommand)?.path : undefined
  const planDataPath = entryDataPath ?? guide.dataPath
  const dataField = entryDataPath
    ? { source: 'file' as const, note: '来自所选入口命令的数据参数' }
    : dataPathField(guide)
  const draft: ExperimentTaskDraft = {
    ...emptyDraft(),
    ...base,
    title: suggestPlanTitle(root, mode),
    project: projectName,
    objective: goal,
    tags: mode === 'evaluate' ? ['evaluation'] : ['baseline'],
    codePath,
    launchCommand,
    launchMode: 'command',
    scriptPath: '',
    dataPath: planDataPath || '',
    artifactPath: artifact.value,
    condaEnvironment: environment ? { manager: 'conda', ...(environment.startsWith('/') ? {environmentPrefix: environment} : {environmentName: environment}) } : undefined,
    status: 'planned'
  }
  // The evidence key must describe the plan that will actually be saved, not the raw guide.
  if (draft.projectPreparation) {
    const evidenceCitations = chosenEntry?.citation ? [chosenEntry.citation] : guide.launchCitations
    draft.projectPreparation = {
      ...draft.projectPreparation,
      configurationKey: projectConfigurationKey(draft),
      citations: evidenceCitations.slice(0, 12).map(citation => ({ ...citation, quote: citation.quote.slice(0, 3000) }))
    }
  }
  const fields: PlanFields = {
    title: { source: 'suggested', note: '根据项目目录和实验方式自动建议，可直接修改' },
    objective: { source: 'suggested', note: '来自最初的项目与目标描述' },
    mode: {
      source: 'suggested',
      note: goalMode !== mode
        ? `项目中没有找到${planModeLabels[goalMode]}入口，方案基于${planModeLabels[mode]}`
        : `按“${goal.slice(0, 60)}”匹配到${planModeLabels[mode]}`
    },
    codePath: {
      source: directoryCheck?.status === 'confirmed' ? 'server' : 'file',
      note: directoryCheck?.status === 'confirmed' ? '启动目录已在服务器确认存在' : '启动目录来自项目结构与分析结果'
    },
    launchCommand: {
      source: chosenEntry ? (chosenEntry.origin === 'documented' ? 'file' : 'suggested') : guide.launchOrigin === 'documented' ? 'file' : 'suggested',
      note: entryCheck ? `${commandNote}；入口文件已在服务器确认存在` : `${commandNote}；入口文件尚未在服务器确认`
    },
    dataPath: dataField,
    environment: {
      source: environmentVerified ? 'server' : environment ? (guide.warnings.some(item => item.includes('环境名从')) ? 'file' : 'suggested') : 'suggested',
      note: environmentVerified ? '环境已在服务器的 Conda 环境列表中确认' : environment ? '环境来自项目分析，需在服务器核对' : '尚未选择环境'
    },
    artifactPath: { source: artifact.source, note: artifact.note }
  }
  const questions = sortedUnique([
    ...guide.missingInputs.filter(item => !/数据|dataset|环境|environment|入口|命令/i.test(item)),
    ...guide.questions.filter(item => !/数据|dataset|环境|environment|入口|命令/i.test(item))
  ]).slice(0, 6)
  return {
    goal, guide, mode, draft, entryOptions, signals, fields, questions,
    summary: guide.summary, createdAt: now.toISOString()
  }
}

export function planRootPath(plan: ExperimentPlan): string {
  return clean(plan.guide.snapshot.input.path) || '/'
}
/** Citations for the command currently in the draft, not for an entry that was replaced. */
export function planLaunchCitations(plan: ExperimentPlan): RepositoryCitation[] {
  const command = plan.draft.launchCommand.trim()
  if (!command) return []
  const option = plan.entryOptions.find(item => item.command.trim() === command)
  if (option?.citation) return [option.citation]
  if (plan.guide.launchCommand.trim() === command) return plan.guide.launchCitations
  const citations = plan.entryOptions
    .filter(item => item.command.trim() === command && item.citation)
    .map(item => item.citation!)
  if (citations.length) return citations
  const entry = planCommandEntry(command)
  const sameEntry = plan.entryOptions.find(item => item.mode === plan.mode && item.citation && planCommandEntry(item.command) === entry)
  if (sameEntry?.citation) return [sameEntry.citation]
  return plan.guide.launchCitations.filter(citation => citation.quote.includes(command))
}
export function planCodePath(plan: Pick<ExperimentPlan, 'guide'>, workingDirectory: string): string {
  return workingDirectory ? joinPath(clean(plan.guide.snapshot.input.path), workingDirectory) : clean(plan.guide.snapshot.input.path) || '/'
}
export function planEnvironmentName(draft: ExperimentTaskDraft): string {
  return draft.condaEnvironment?.environmentName ?? draft.condaEnvironment?.environmentPrefix ?? ''
}

export function planGaps(plan: ExperimentPlan, context: PlanContext = {}): PlanGap[] {
  const gaps: PlanGap[] = []
  const root = planRootPath(plan)
  const environments = context.environments ?? []
  if (!plan.draft.launchCommand.trim()) {
    const options: PlanGapOption[] = plan.entryOptions.map((option, index) => ({
      id: `entry-${index}`,
      label: `${planModeLabels[option.mode]} · ${option.command.split(/\s+/).slice(0, 2).join(' ')}`,
      description: option.reason,
      value: option.command,
      source: option.origin === 'documented' ? 'file' : 'suggested',
      entry: { mode: option.mode, command: option.command, workingDirectory: option.workingDirectory, origin: option.origin, citation: option.citation }
    }))
    gaps.push({
      id: 'entry', kind: 'entry', field: 'launchCommand',
      question: '这次实验从哪个入口开始？',
      detail: '项目里可能有多个脚本，选择一个入口作为本次运行方式。',
      options, allowBrowse: false, allowLater: true
    })
  }
  if (!plan.draft.dataPath.trim()) {
    const seen = new Set<string>()
    const options: PlanGapOption[] = []
    for (const candidate of context.dataCandidates ?? []) {
      const path = candidate.path.trim()
      if (!path.startsWith('/') || seen.has(path)) continue
      seen.add(path)
      options.push({ id: `data-${options.length}`, label: path, description: candidate.note, value: path, source: candidate.source })
    }
    const inferred = plan.signals.dataDirs.map(relative => joinPath(root, relative))
    for (const path of inferred) {
      if (seen.has(path)) continue
      seen.add(path)
      options.push({ id: `data-${options.length}`, label: path, description: '项目文件中提到的数据目录', value: path, source: 'file' })
    }
    gaps.push({
      id: 'data', kind: 'data', field: 'dataPath',
      question: '这次实验使用哪份数据？',
      detail: options.length ? '已经发现几处可能的数据位置，也可以浏览其他目录。' : '项目中没有明确的数据位置，可以在服务器上选择。',
      options, allowBrowse: true, allowLater: true
    })
  }
  if (!planEnvironmentName(plan.draft) && plan.fields.environment?.source !== 'user') {
    const options: PlanGapOption[] = environments.map((environment, index) => ({
      id: `env-${index}`,
      label: environment.name,
      description: environment.prefix,
      value: environment.name,
      source: 'server',
      environment: { name: environment.name, prefix: environment.prefix }
    }))
    options.push({ id: 'env-none', label: '服务器默认环境（不启用 Conda）', description: '直接使用服务器登录 shell 的 Python', value: '', source: 'suggested' })
    gaps.push({
      id: 'environment', kind: 'environment', field: 'environment',
      question: '这次实验使用哪个环境？',
      detail: options.length > 1 ? '服务器上已经找到这些 Conda 环境。' : '尚未选择 Conda 环境，可稍后补充。',
      options, allowBrowse: false, allowLater: true
    })
  }
  return gaps
}

export function resolvePlanGap(plan: ExperimentPlan, gap: PlanGap, option: PlanGapOption): PlanResolution {
  const draft: ExperimentTaskDraft = { ...plan.draft, condaEnvironment: plan.draft.condaEnvironment ? { ...plan.draft.condaEnvironment } : undefined }
  const fields: PlanFields = { ...plan.fields }
  let mode = plan.mode
  let change: PlanChange
  if (gap.kind === 'entry' && option.entry) {
    mode = option.entry.mode
    draft.launchCommand = option.entry.command
    draft.launchMode = 'command'
    draft.codePath = planCodePath(plan, option.entry.workingDirectory)
    if (draft.projectPreparation) draft.projectPreparation = refreshDraftEvidence(draft, option.entry.citation ? [option.entry.citation] : plan.guide.launchCitations).projectPreparation
    fields.mode = { source: option.source, note: option.description }
    fields.launchCommand = { source: option.source, note: option.description }
    fields.codePath = { source: 'file', note: '按所选入口的目录更新' }
    change = { field: 'launchCommand', label: '运行方式', summary: `入口改为 ${option.value}` }
  } else if (gap.kind === 'data') {
    draft.dataPath = option.value
    fields.dataPath = { source: option.source, note: option.description }
    const binding = commandDataPath(draft.launchCommand)
    if (binding && binding.path !== option.value) draft.launchCommand = syncCommandDataPath(draft.launchCommand, option.value)
    change = {
      field: 'dataPath', label: '数据目录',
      summary: binding ? `数据目录设为 ${option.value}，并同步命令中的 ${binding.path}` : `数据目录设为 ${option.value}；命令中没有明确的数据参数，请确认脚本会读取该位置`
    }
  } else if (gap.kind === 'environment') {
    if (option.value) {
      draft.condaEnvironment = { manager: plan.draft.condaEnvironment?.manager ?? 'conda', managerPath: plan.draft.condaEnvironment?.managerPath, ...(option.environment?.prefix ? {environmentPrefix: option.environment.prefix, environmentName: undefined} : {environmentName: option.value, environmentPrefix: undefined}), lastCheckStatus: 'found', lastCheckedAt: new Date().toISOString() }
      fields.environment = { source: option.source, note: option.description ?? '已选择服务器环境' }
      change = { field: 'environment', label: 'Conda 环境', summary: `环境设为 ${option.value}` }
    } else {
      draft.condaEnvironment = undefined
      fields.environment = { source: 'user', note: '使用服务器默认环境' }
      change = { field: 'environment', label: 'Conda 环境', summary: '改为使用服务器默认环境' }
    }
  } else {
    change = { field: gap.field, label: '配置', summary: '配置已更新' }
  }
  return { draft, mode, fields, change }
}

const fieldAccessors: { field: PlanField; label: string; get(draft: ExperimentTaskDraft): string }[] = [
  { field: 'title', label: '任务名称', get: draft => draft.title },
  { field: 'objective', label: '实验目标', get: draft => draft.objective },
  { field: 'codePath', label: '代码目录', get: draft => draft.codePath },
  { field: 'launchCommand', label: '启动命令', get: draft => draft.launchCommand },
  { field: 'dataPath', label: '数据目录', get: draft => draft.dataPath },
  { field: 'environment', label: 'Conda 环境', get: planEnvironmentName },
  { field: 'artifactPath', label: '输出位置', get: draft => draft.artifactPath }
]
export interface DraftFieldChange { field: PlanField; label: string; before: string; after: string }
export function experimentDraftChanges(before: ExperimentTaskDraft, after: ExperimentTaskDraft): DraftFieldChange[] {
  return fieldAccessors
    .map(accessor => ({ field: accessor.field, label: accessor.label, before: accessor.get(before), after: accessor.get(after) }))
    .filter(change => change.before !== change.after)
}
export function markUserFields(fields: PlanFields, changes: DraftFieldChange[], note = '你在完整配置中手动修改'): PlanFields {
  const next = { ...fields }
  for (const change of changes) next[change.field] = { source: 'user', note }
  return next
}

let conflictSeed = 0
const nextConflictId = (field: string): string => `${field}-${Date.now()}-${++conflictSeed}`
function pickEntry(plan: ExperimentPlan, mode: ExperimentMode): PlanEntryOption | undefined {
  return plan.entryOptions.find(option => option.mode === mode && option.origin === 'documented')
    ?? plan.entryOptions.find(option => option.mode === mode)
}
function refreshDraftEvidence(draft: ExperimentTaskDraft, citations: RepositoryCitation[]): ExperimentTaskDraft {
  if (!draft.projectPreparation) return draft
  return {
    ...draft,
    projectPreparation: {
      ...draft.projectPreparation,
      configurationKey: projectConfigurationKey(draft),
      citations: citations.slice(0, 12).map(citation => ({ ...citation, quote: citation.quote.slice(0, 3000) }))
    }
  }
}
export function switchPlanMode(plan: ExperimentPlan, mode: ExperimentMode): { draft: ExperimentTaskDraft; mode: ExperimentMode; fields: PlanFields; change?: PlanChange; conflict?: PlanConflict; note?: string } {
  if (mode === plan.mode) return { draft: plan.draft, mode: plan.mode, fields: plan.fields, note: `当前已经是${planModeLabels[mode]}` }
  const option = pickEntry(plan, mode)
  if (!option) return { draft: plan.draft, mode: plan.mode, fields: plan.fields, note: `项目中没有发现${planModeLabels[mode]}入口，暂不能切换` }
  const suggested: Partial<ExperimentTaskDraft> = {
    launchCommand: option.command,
    codePath: planCodePath(plan, option.workingDirectory),
    launchMode: 'command'
  }
  if (plan.fields.title?.source !== 'user') suggested.title = suggestPlanTitle(planRootPath(plan), mode)
  if (plan.fields.objective?.source !== 'user') suggested.objective = mode === experimentModeFromGoal(plan.goal) ? plan.goal : planModeLabels[mode]
  const defaultTags = plan.draft.tags.length === 1 && (plan.draft.tags[0] === 'baseline' || plan.draft.tags[0] === 'evaluation')
  if (defaultTags) suggested.tags = [mode === 'evaluate' ? 'evaluation' : 'baseline']
  // Keep an explicit data location consistent across entries instead of silently reverting it.
  const binding = commandDataPath(option.command)
  const dataPath = plan.draft.dataPath.trim()
  let dataField: PlanFieldState | undefined
  let dataNote = ''
  if (binding && dataPath && binding.path !== dataPath) {
    suggested.launchCommand = syncCommandDataPath(option.command, dataPath)
    dataNote = `，已保留数据目录 ${dataPath}`
  } else if (binding && !dataPath) {
    suggested.dataPath = binding.path
    dataField = { source: 'file', note: '来自所选入口命令的数据参数' }
  }
  const evidenceCitations = option.citation ? [option.citation] : plan.guide.launchCitations
  const merged = refreshDraftEvidence({ ...plan.draft, ...suggested }, evidenceCitations)
  suggested.projectPreparation = merged.projectPreparation
  const guarded = (['launchCommand', 'codePath'] as const).filter(field => plan.fields[field]?.source === 'user')
  if (guarded.length) {
    return {
      draft: plan.draft, mode: plan.mode, fields: plan.fields,
      conflict: {
        id: nextConflictId(`mode-${mode}`), label: '运行方式',
        current: plan.draft.launchCommand,
        suggested: option.command,
        suggestedDraft: suggested,
        suggestedMode: mode,
        suggestedField: { field: 'launchCommand', state: { source: option.origin === 'documented' ? 'file' : 'suggested', note: option.reason } }
      }
    }
  }
  const fields = { ...plan.fields }
  fields.mode = { source: 'suggested', note: option.reason }
  fields.launchCommand = { source: option.origin === 'documented' ? 'file' : 'suggested', note: option.reason }
  fields.codePath = { source: 'file', note: '按所选入口的目录更新' }
  if (plan.fields.objective?.source !== 'user') fields.objective = { source: 'suggested', note: `按当前实验方式更新为${planModeLabels[mode]}` }
  if (dataField) fields.dataPath = dataField
  return {
    draft: merged, mode, fields,
    change: { field: 'mode', label: '实验方式', summary: `改为${planModeLabels[mode]}（${suggested.launchCommand ?? option.command}）${dataNote}` }
  }
}
