import { z } from 'zod'
import type { ExperimentTaskDraft } from './types'
import type { RepositoryGuide } from './repository-guide'

export const taskProjectContextSchema = z.object({
  rootPath: z.string().max(4096), serverId: z.string().uuid(), accessRouteId: z.string().max(80).optional(),
  generatedAt: z.string().datetime(), summary: z.string().max(4000), configurationKey: z.string().max(50_000),
  warnings: z.array(z.string().max(2000)).max(24), questions: z.array(z.string().max(2000)).max(24),
  citations: z.array(z.object({path:z.string().max(512),startLine:z.number().int().positive(),endLine:z.number().int().positive(),quote:z.string().max(3000)})).max(12),
  checks: z.array(z.object({path:z.string().max(4096),expected:z.enum(['file','directory']),status:z.enum(['confirmed','missing','unreadable','outside']),message:z.string().max(2000)})).max(16),
  steps: z.array(z.object({title:z.string().max(500),explanation:z.string().max(2000),commands:z.array(z.string().max(4000)).max(8),workingDirectory:z.string().max(4096)})).max(16)
})
export type TaskProjectContext = z.infer<typeof taskProjectContextSchema>

export function projectConfigurationKey(draft: Pick<ExperimentTaskDraft,'serverId'|'accessRouteId'|'codePath'|'dataPath'|'condaEnvironment'|'launchCommand'|'launchMode'|'scriptPath'>): string {
  return JSON.stringify([draft.serverId ?? '',draft.accessRouteId ?? '',draft.codePath.trim(),draft.dataPath.trim(),draft.condaEnvironment?.manager??'',draft.condaEnvironment?.managerPath??'',draft.condaEnvironment?.environmentName??'',draft.condaEnvironment?.environmentPrefix??'',draft.launchMode ?? 'command',draft.launchCommand.trim(),draft.scriptPath?.trim() ?? ''])
}

export function projectDraftPatch(guide: RepositoryGuide, draft: ExperimentTaskDraft): Partial<ExperimentTaskDraft> {
  const root = guide.snapshot.input.path.replace(/\/$/,'')
  const directory = guide.workingDirectory.trim()
  const absolute = directory.startsWith('/') ? directory : directory && directory !== '.' ? `${root}/${directory.replace(/^\.\//,'')}` : root || '/'
  const segments:string[]=[]
  for(const segment of absolute.split('/')){if(segment==='..')segments.pop();else if(segment&&segment!=='.')segments.push(segment)}
  const codePath='/'+segments.join('/')
  const patch: Partial<ExperimentTaskDraft> = {
    codePath, launchCommand:guide.launchCommand,launchMode:'command',scriptPath:'',dataPath:guide.dataPath || draft.dataPath,
    title:draft.title || guide.snapshot.input.path.split('/').filter(Boolean).pop()?.slice(0,150) || '新实验',
    condaEnvironment:guide.environmentName ? {manager:'conda',environmentName:guide.environmentName} : draft.condaEnvironment
  }
  patch.projectPreparation = taskProjectContextSchema.parse({
    rootPath:guide.snapshot.input.path,serverId:guide.snapshot.input.serverId,accessRouteId:guide.snapshot.input.accessRouteId,
    generatedAt:new Date().toISOString(),configurationKey:projectConfigurationKey({...draft,...patch}),summary:guide.summary.slice(0,4000),
    warnings:guide.warnings.slice(0,24).map(s=>s.slice(0,2000)),questions:[...new Set([...guide.missingInputs,...guide.questions])].slice(0,24).map(s=>s.slice(0,2000)),
    citations:guide.launchCitations.slice(0,12).map(c=>({...c,quote:c.quote.slice(0,3000)})),checks:guide.checks.slice(0,16).map(c=>({...c,message:c.message.slice(0,2000)})),
    steps:guide.steps.slice(0,16).map(s=>({title:s.title.slice(0,500),explanation:s.explanation.slice(0,2000),commands:s.commands.slice(0,8).map(c=>c.slice(0,4000)),workingDirectory:s.workingDirectory.slice(0,4096)}))
  })
  return patch
}

/** Read literal shell words with offsets; expansion and compound commands are deliberately left to the user. */
function literalWords(command:string):{value:string;start:number;end:number}[]|undefined {
  const words:{value:string;start:number;end:number}[]=[]
  let i=0
  while(i<command.length){
    if(/\s/.test(command[i])){i++;continue}
    const start=i;let value='',quote=''
    while(i<command.length){
      const c=command[i]
      if(!quote&&/\s/.test(c))break
      if(quote!=="'"&&(c==='$'||c==='`'))return undefined
      if(!quote&&/[;&|<>\r\n]/.test(c))return undefined
      if(c==='\\'&&quote!=="'"){
        if(i+1>=command.length)return undefined
        const next=command[++i]
        value+=quote==='"'&&!/[$`"\\]/.test(next)?'\\'+next:next
      }else if(c==='"'||c==="'"){
        if(!quote)quote=c
        else if(quote===c)quote=''
        else value+=c
      }else value+=c
      i++
    }
    if(quote)return undefined
    words.push({value,start,end:i})
  }
  return words
}
/** These flags name filesystem locations; --dataset often names a dataset rather than a path. */
export function commandDataPath(command: string): {path:string; start:number; end:number} | undefined {
  const words=literalWords(command)
  if(!words)return undefined
  const candidates:{path:string;start:number;end:number}[]=[]
  const flag=/^--(?:data(?:[-_](?:path|dir|root))?|dataset[-_](?:path|dir|root))$/
  for(let i=0;i<words.length;i++){
    const word=words[i],equal=word.value.indexOf('='),name=equal<0?word.value:word.value.slice(0,equal)
    if(!flag.test(name))continue
    if(equal<0){const next=words[i+1];if(next?.value.startsWith('/'))candidates.push({path:next.value,start:next.start,end:next.end})}
    else if(command.slice(word.start,word.start+name.length+1)===name+'='&&word.value.slice(equal+1).startsWith('/'))candidates.push({path:word.value.slice(equal+1),start:word.start+name.length+1,end:word.end})
  }
  return candidates.length===1?candidates[0]:undefined
}
export function syncCommandDataPath(command:string,path:string):string {
  const binding=commandDataPath(command)
  if (!binding || !path.startsWith('/') || /[\0\r\n]/.test(path)) return command
  const quoted=/^[A-Za-z0-9_./:+-]+$/.test(path)?path:"'"+path.replace(/'/g,"'\\''")+"'"
  return command.slice(0,binding.start)+quoted+command.slice(binding.end)
}

export function projectLaunchIssue(config:{codePath?:string|null;dataPath?:string|null;launchCommand?:string|null;scriptPath?:string|null}):string|undefined {
  const values=[config.codePath,config.dataPath,config.launchCommand,config.scriptPath].filter(Boolean).join(' ')
  if (/<(?:[A-Z_][A-Z0-9_ -]*|[^<>\s]*(?:path|dir|数据|路径)[^<>]*)>|\bYOUR_(?:DATA|PATH|PROJECT|ENV)\w*\b|\/path\/to\//i.test(values))return '启动配置仍有路径或参数占位符，请填写实际值后再运行。'
  return undefined
}
