import { z } from 'zod'
import type { DiagnosticStep, Evidence } from './intelligence'
export const diagnosisChangeSchema=z.object({kind:z.enum(['file','command']),file:z.string().min(1).max(512),startLine:z.number().int().positive().max(1000000).optional(),before:z.string().min(1).max(6000),after:z.string().min(1).max(6000),evidenceId:z.string().min(1).max(160)})
export type DiagnosisChange=z.infer<typeof diagnosisChangeSchema>
const lines=(value:string):string[]=>value.replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n')
export function verifiedDiagnosisChanges(changes:DiagnosisChange[],evidence:Evidence[],trace:DiagnosticStep[],command?:string):DiagnosisChange[] {
  return changes.filter(change=>{
    if(change.before===change.after)return false
    const item=evidence.find(item=>item.id===change.evidenceId)
    if(!item)return false
    if(change.kind==='command')return !!command&&change.before===command&&change.file==='启动命令'&&!change.startLine&&!/[\r\n]/.test(change.after)
    if(!change.startLine||change.file.startsWith('/')||change.file.split('/').some(part=>!part||part==='.'||part==='..')||/[\0\r\n]/.test(change.file))return false
    if(!trace.some(step=>step.kind==='tool'&&step.status==='completed'&&step.tool==='read_project_file'&&step.arguments?.name===change.file&&step.evidenceIds.includes(item.id)))return false
    try{
      const wrapper=JSON.parse(item.text),result=JSON.parse(wrapper.result)
      if(wrapper.status!=='success'||result.name!==change.file||typeof result.content!=='string')return false
      const old=lines(change.before)
      return lines(result.content).slice(change.startLine-1,change.startLine-1+old.length).join('\n')===old.join('\n')
    }catch{return false}
  })
}
export function diagnosisDiffText(change:DiagnosisChange):string {
  const before=lines(change.before),after=lines(change.after),start=change.kind==='command'?1:change.startLine??1
  return [`--- a/${change.file}`,`+++ b/${change.file}`,`@@ -${start},${before.length} +${start},${after.length} @@`,...before.map(line=>'-'+line),...after.map(line=>'+'+line)].join('\n')
}
