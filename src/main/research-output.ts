import { posix } from 'node:path'
import type { ExperimentTaskDraft } from '../shared/types'
import type { RepositoryExcerpt } from '../shared/repository-guide'
import type { ParameterVariant, ResearchOutputIsolation, ResearchMember } from '../shared/research'
import { expandParameters } from '../shared/parameter-engine'
import { commandParameter, pythonMask, researchParameters } from './research-design'

function callArguments(text:string,pattern:RegExp):string[][] {
  const masked=pythonMask(text),result:string[][]=[]
  for(const match of masked.matchAll(pattern)){
    const start=match.index!+match[0].length;let depth=1,end=start
    for(;end<masked.length&&depth;end++){if(masked[end]==='(')depth++;if(masked[end]===')')depth--}
    if(depth)continue
    const body=text.slice(start,end-1),mask=masked.slice(start,end-1),parts:string[]=[];let nested=0,last=0
    for(let i=0;i<mask.length;i++){if('([{'.includes(mask[i]))nested++;if(')]}'.includes(mask[i]))nested--;if(mask[i]===','&&!nested){parts.push(body.slice(last,i).trim());last=i+1}}
    parts.push(body.slice(last).trim());result.push(parts)
  }
  return result
}
/** Conservative symbolic recognition: no project code is imported or executed. */
export function inspectResearchOutput(baseline:ExperimentTaskDraft,files:RepositoryExcerpt[]):ResearchOutputIsolation {
  const parameters=researchParameters(baseline.launchCommand,files,true)
  const candidates=parameters.filter(p=>/^--(?:train_dir|(?:output|save|model|log|result|results)[_-]dir)$/.test(p.flag)&&p.type==='str')
  const verified:ResearchOutputIsolation[]=[]
  for(const parameter of candidates){
    const destination=parameter.destination??parameter.flag.slice(2).replace(/-/g,'_')
    for(const file of files.filter(file=>file.path.endsWith('.py'))){
      const source=file.text
      const assignments=new Map<string,string[]>()
      for(const match of source.matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*([^\n#]+)/gm))assignments.set(match[1],[...(assignments.get(match[1])??[]),match[2].trim()])
      const evaluate=(raw:string,depth=0):string|undefined=>{
        if(depth>5)return undefined
        const expr=raw.trim()
        if(/^(['"])[\w./ -]*\1$/.test(expr))return expr.slice(1,-1)
        const argument=/^args\.([A-Za-z_]\w*)$/.exec(expr)
        if(argument){
          if(argument[1]===destination)return '{value}'
          const known=parameters.find(p=>(p.destination??p.flag.slice(2).replace(/-/g,'_'))===argument[1])
          return known?.baselineValue??commandParameter(baseline.launchCommand,'--'+argument[1])
        }
        const join=/^(?:os\.path|posixpath)\.join\((.*)\)$/.exec(expr)
        if(join){const args=callArguments(expr,/(?:os\.path|posixpath)\.join\s*\(/g)[0];if(!args)return undefined;const parts=args.map(part=>evaluate(part,depth+1));return parts.every((part):part is string=>part!==undefined)?parts.reduce((root,part)=>posix.isAbsolute(part)?part:posix.join(root,part),''):undefined}
        const mask=pythonMask(expr);let nesting=0,last=0;const parts:string[]=[]
        for(let i=0;i<mask.length;i++){if(mask[i]==='(')nesting++;if(mask[i]===')')nesting--;if(mask[i]==='+'&&!nesting){parts.push(expr.slice(last,i));last=i+1}}
        if(parts.length){parts.push(expr.slice(last));const values=parts.map(part=>evaluate(part,depth+1));return values.every(v=>v!==undefined)?values.join(''):undefined}
        if(/^[A-Za-z_]\w*$/.test(expr)&&assignments.get(expr)?.length===1)return evaluate(assignments.get(expr)![0],depth+1)
        return undefined
      }
      const directories=callArguments(source,/\bos\.(?:makedirs|mkdir)\s*\(/g).map(args=>evaluate(args[0]??'')).filter((value):value is string=>!!value&&value.includes('{value}'))
      const writes=[...callArguments(source,/\bopen\s*\(/g).filter(args=>/^['"][wax][+bt]*['"]$/.test(args[1]??'')).map(args=>evaluate(args[0])),...callArguments(source,/\btorch\.save\s*\(/g).map(args=>evaluate(args[1]??''))].filter((value):value is string=>!!value)
      for(const template of new Set(directories)){
        if(!writes.some(path=>path.startsWith(template.replace(/\/$/,'')+'/')))continue
        if((template.match(/\{value\}/g)??[]).length!==1)continue
        verified.push({status:'verified',flag:parameter.flag,template,originalValue:parameter.baselineValue,source:{path:file.path,startLine:parameter.source.path===file.path?parameter.source.startLine:1,quote:source.split('\n').filter(line=>line.includes(destination)||line.includes('makedirs')||line.includes('torch.save')||line.includes('open(')).slice(0,8).join('\n').slice(0,1600)}})
      }
    }
  }
  const unique=[...new Map(verified.map(plan=>[plan.flag+':'+plan.template,plan])).values()]
  if(unique.length===1)return unique[0]
  return {status:'unverified',reason:unique.length?'项目存在多个输出位置，暂时无法保证统一隔离。':'未确认控制结果保存位置的参数及源码用法，请先让脚本支持可配置的输出目录。'}
}
export function isolateResearchVariants(id:string,baseline:ExperimentTaskDraft,variants:ParameterVariant[],plan:ResearchOutputIsolation):ResearchMember[] {
  if(plan.status!=='verified'||!plan.flag||!plan.template)return variants
  return variants.map((variant,index)=>{
    const leaf=`labdeck_${id.replace(/-/g,'')}_g${String(index+1).padStart(2,'0')}`
    const value=plan.template==='{value}'&&plan.originalValue?posix.join(posix.dirname(plan.originalValue),leaf):leaf
    const command=expandParameters(variant.command,[{flag:plan.flag!,values:[value]}],1).variants[0].command
    const directory=plan.template!.replace('{value}',value)
    const outputDirectory=posix.resolve(baseline.codePath,directory)
    return {...variant,command,outputDirectory,changes:[...variant.changes,`${plan.flag}: ${plan.originalValue??'项目默认值'} → ${value}`]}
  })
}
