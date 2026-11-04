import { posix } from 'node:path'
import type { ExperimentTaskDraft } from '../shared/types'
import type { ParameterVariant, ResearchOutputIsolation, ResearchMember } from '../shared/research'
import { tokenizeTrainingCommand } from '../shared/parameter-engine'

/** Apply the source analysis result; this module does not infer output locations. */
export function isolateResearchVariants(id:string,baseline:ExperimentTaskDraft,variants:ParameterVariant[],plan:ResearchOutputIsolation,batchName?:string):ResearchMember[] {
  if(plan.status!=='verified'||!plan.flag||!plan.template)return variants
  const targets=plan.targets??[{flag:plan.flag,template:plan.template,originalValue:plan.originalValue,kind:'directory' as const,source:plan.source}]
  return variants.map((variant,index)=>{
    const leaf=batchName?`${batchName}_g${String(index+1).padStart(2,'0')}`:`exp_${id.replace(/-/g,'').slice(0,12)}_${String(index+1).padStart(2,'0')}`
    const primary=targets[0]
    const primaryValue=primary.template==='{value}'&&primary.originalValue?posix.join(posix.dirname(primary.originalValue),leaf):leaf
    const outputDirectory=posix.resolve(baseline.codePath,primary.template.replace('{value}',primaryValue))
    const tokens=tokenizeTrainingCommand(variant.command)
    const usedFileNames=new Set<string>()
    const changes=[...variant.changes],directories=new Set<string>([outputDirectory])
    for(const target of targets){
      let fileName=target.kind==='file'?posix.basename(target.originalValue!):''
      if(fileName&&usedFileNames.has(fileName))fileName=target.flag.replace(/^--/,'')+'_'+fileName
      if(fileName)usedFileNames.add(fileName)
      const value=target.kind==='file'?posix.join(outputDirectory,fileName):target===primary?primaryValue:target.template==='{value}'?outputDirectory:leaf
      setOutputValue(tokens,target.flag,value)
      const actual=posix.resolve(baseline.codePath,target.template.replace('{value}',value))
      directories.add(target.kind==='file'?posix.dirname(actual):actual)
      changes.push(`${target.flag}: ${target.originalValue??'项目默认值'} → ${value}`)
    }
    return {...variant,command:tokens.join(' '),outputDirectory,outputDirectories:[...directories],changes}
  })
}

function setOutputValue(tokens:string[],flag:string,value:string):void {
  if(!/^--[A-Za-z0-9][A-Za-z0-9_-]*$/.test(flag)||!value||value.length>4096||/[\0\r\n]/.test(value))throw new Error('独立保存位置无效，请重新核对输出参数')
  const encoded=/^[a-zA-Z0-9_.,:/+=-]+$/.test(value)?value:"'"+value.replace(/'/g,"'\\''")+"'"
  const positions=tokens.flatMap((token,i)=>token===flag||token.startsWith(flag+'=')?[i]:[])
  if(positions.length>1)throw new Error(`启动命令中 ${flag} 重复，请先编辑配置`)
  const position=positions[0]
  if(position===undefined)tokens.push(flag,encoded)
  else if(tokens[position].includes('='))tokens[position]=flag+'='+encoded
  else{
    if(!tokens[position+1]||tokens[position+1].startsWith('--'))throw new Error(`${flag} 缺少参数值，请先编辑配置`)
    tokens[position+1]=encoded
  }
}
/** Keep the member's existing destinations while applying other task configuration fixes. */
export function reuseResearchOutput(command:string,previousCommand:string,plan:ResearchOutputIsolation):string {
  const tokens=tokenizeTrainingCommand(command),previous=tokenizeTrainingCommand(previousCommand)
  for(const {flag} of plan.targets??(plan.flag?[{flag:plan.flag}]:[])){
    const index=previous.findIndex(token=>token===flag||token.startsWith(flag+'='))
    const value=index<0?undefined:previous[index].includes('=')?previous[index].slice(flag.length+1):previous[index+1]
    if(!value||value.startsWith('--'))throw new Error('未能确认原运行的保存参数，请检查配置后重试')
    setOutputValue(tokens,flag,value)
  }
  return tokens.join(' ')
}

/** Resolve a model-provided mapping against an already submitted command, without rewriting it. */
export function researchOutputLocations(command:string,codePath:string,plan:ResearchOutputIsolation):{outputDirectory:string;outputDirectories:string[]}{
  const tokens=tokenizeTrainingCommand(command)
  const targets=plan.targets??(plan.flag&&plan.template?[{flag:plan.flag,template:plan.template,kind:'directory' as const}]:[])
  const directories=targets.map(target=>{
    const index=tokens.findIndex(token=>token===target.flag||token.startsWith(target.flag+'='))
    const value=index<0?undefined:tokens[index].includes('=')?tokens[index].slice(target.flag.length+1):tokens[index+1]
    if(!value||value.startsWith('--'))throw new Error(`运行命令缺少 ${target.flag} 的实际值，无法核对保存目录`)
    const actual=posix.resolve(codePath,target.template.replace('{value}',value))
    return target.kind==='file'?posix.dirname(actual):actual
  })
  if(!directories.length)throw new Error('缺少保存目录映射')
  return {outputDirectory:directories[0],outputDirectories:[...new Set(directories)]}
}
