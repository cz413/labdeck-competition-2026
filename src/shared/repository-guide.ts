import type { ModelUsage } from './model-usage'
export interface RepositoryInput {
  source: 'remote'
  path: string
  serverId: string
  accessRouteId?: string
}
export interface RepositoryFile { path: string; sizeBytes: number }
export interface RepositoryExcerpt { path: string; text: string; startLine: number; truncated: boolean }
export interface RepositorySnapshot {
  input: RepositoryInput
  files: RepositoryFile[]
  excerpts: RepositoryExcerpt[]
  warnings: string[]
  collectedAt: string
}
export interface RepositoryAnalysisInput extends RepositoryInput { filePaths: string[]; goal: string }
export interface RepositoryCitation { path: string; startLine: number; endLine: number; quote: string }
export interface RepositoryPathCheck { path: string; expected: 'file' | 'directory'; status: 'confirmed' | 'missing' | 'unreadable' | 'outside'; message: string }
export interface RepositoryGuideStep {
  role?:'prepare'|'launch'|'observe'; title: string; explanation: string; commands: string[]; sources: string[]
  workingDirectory: string; environment: string; origin: 'documented' | 'suggested'; citations: RepositoryCitation[]
}
export interface RepositoryGuide {
  usage?:ModelUsage
  status: 'needs_info' | 'ready_for_review'
  missingInputs: string[]
  warnings: string[]
  checks: RepositoryPathCheck[]
  launchOrigin: 'documented' | 'suggested' | 'user'
  launchCitations: RepositoryCitation[]
  summary: string
  steps: RepositoryGuideStep[]
  launchCommand: string
  launchSources: string[]
  workingDirectory: string
  environmentName: string
  dataPath: string
  questions: string[]
  snapshot: RepositorySnapshot
}

// Import only a single reviewed launch command; setup commands stay in the guide.
export function isRepositoryLaunchCommand(command:string):boolean {
  return !/[\r\n\0;&|`$<>]/.test(command)
    && /^(?:python(?:3(?:\.\d+)?)?\s+(?:[A-Za-z0-9_./-]+\.py(?:\s|$)|-m\s+[A-Za-z_][\w.]*\b)|bash\s+[A-Za-z0-9_./-]+\.sh(?:\s|$)|torchrun\s+|accelerate\s+launch\s+)/.test(command.trim())
}

export interface RepositoryReviewInput {
  launchCommand:string;workingDirectory:string;environmentName:string;dataPath:string
  resolutions:{question:string;answer:string}[]
}
export type RepositoryWorkflowAction = {kind:'review';input:RepositoryReviewInput}|{kind:'step';index:number;confirmed:boolean}|{kind:'steps';confirmed:boolean}|{kind:'save';title:string;force?:boolean}|{kind:'sync'}|{kind:'retry'}
export interface RepositoryWorkflow {
  id:string;createdAt:string;updatedAt:string;input:RepositoryAnalysisInput;guide?:RepositoryGuide
  phase:'analyzing'|'needs_info'|'preparing'|'ready'|'draft'|'queued'|'running'|'completed'|'failed'|'task_missing'|'run_missing'|'paused'|'cancelled'
  confirmedSteps:number[];resolutions:{question:string;answer:string}[];taskId?:string;runId?:string
  events:{at:string;message:string}[]
}
export interface RepositoryWorkflowView extends RepositoryWorkflow {pending:string[];busy:boolean;error?:string}
export interface RepositoryProgress { id:string; stage:'scan'|'read'|'inspect'|'write'|'verify'; message:string; round?:number }
export interface RepositoryCandidate { path:string; name:string }
export interface RepositoryDirectoryEntry { name:string; path:string }
export interface RepositoryDirectoryView { path:string; parent:string|null; home:string; entries:RepositoryDirectoryEntry[] }

/** Read the whole repository by default: relevant files first, then every other readable text file. */
export function recommendRepositoryFiles(files:RepositoryFile[],goal=''):string[] {
  const sorted=[...files].sort((a,b)=>a.path.split('/').length-b.path.split('/').length||a.path.localeCompare(b.path))
  const picked:string[]=[]
  const add=(file:RepositoryFile|undefined):void=>{if(file&&!picked.includes(file.path))picked.push(file.path)}
  add(sorted.find(f=>/(^|\/)readme(?:\.|$)/i.test(f.path)))
  add(sorted.find(f=>/(^|\/)(environment\.ya?ml|pyproject\.toml)$/i.test(f.path)))
  add(sorted.find(f=>/(^|\/)requirements[^/]*\.txt$/i.test(f.path)))
  const evaluate=/评估|测试|推理|evaluate|evaluation|inference|test/i.test(goal)
  const entry=evaluate?/(^|\/)(eval(?:uate)?|test|infer(?:ence)?)\.(py|sh)$/i:/(^|\/)(train|main|run_train|finetune|run)\.(py|sh)$/i
  add(sorted.find(f=>entry.test(f.path)))
  for(const file of sorted)add(file)
  return picked
}

/** Questions about config syntax and path probes are resolved by rechecking fields. */
export function repositoryReviewQuestions(guide:RepositoryGuide):string[] {
  const replaced=new Set([
    '尚未确定可审查的训练或评估启动命令。',
    '启动命令缺少已读文件的行号依据。',
    '启动命令超出单条 Python、bash、torchrun 或 accelerate launch 的自动导入范围。',
    '启动配置仍包含待替换的路径或参数占位符。',
    '数据目录尚不是有效的服务器绝对路径。',
    '尚未确认仓库内的实际入口文件；模块入口或复杂启动方式需进一步核对。',
    '启动配置中仍有待替换的占位符。',
    ...guide.checks.map(check=>`${check.expected==='file'?'入口文件':'启动目录'} ${check.path}：${check.message}`)
  ])
  return guide.missingInputs.filter(question=>!replaced.has(question))
}


/** Only a request for the field itself can be answered by that field. */
export function repositoryFieldAnswer(question:string,fields:{dataPath:string;environmentName:string}):string {
  if(/是否|有无|准备|预处理|格式|版本|依赖|安装|完整|匹配|兼容|校验|缺失|要求|内容|标注|划分|许可|权限|完成|解压|下载|CUDA|PyTorch|已存在/i.test(question))return ''
  const data=/(?:数据(?:集)?(?:目录|路径|位置)|实际数据集在哪里|(?:数据|数据集).*存放(?:在哪|位置)|(?:data|dataset).*(?:path|directory|location))/i.test(question)
  const environment=/(?:环境名(?:称)?|(?:使用|选择|指定|提供|填写|哪个|什么|哪一个).*(?:conda\s*)?环境|(?:conda|python)\s*环境(?:是什么|是哪个|？|\?))/i.test(question)
  if(data&&environment)return ''
  return data?fields.dataPath:environment?fields.environmentName:''
}
