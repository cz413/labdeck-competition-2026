import type { ExperimentTask, ExperimentTaskStatus } from './types'
import type { ParameterVariant, ResearchCampaign, ResearchView } from './research'

export function researchMemberTitle(campaign:ResearchCampaign,member:ParameterVariant):string {
  const tokens=campaign.baseline.launchCommand.trim().split(/\s+/)
  const entries=Object.entries(member.parameters)
  const baseline=entries.length>0&&entries.every(([flag,value])=>{
    const token=tokens.findIndex(item=>item===flag||item.startsWith(flag+'='))
    const original=token<0?campaign.design?.variable?.flag===flag?campaign.design.variable.baselineValue:undefined:tokens[token].includes('=')?tokens[token].slice(flag.length+1):tokens[token+1]
    return original===value
  })
  if(baseline)return '基线'
  const [flag,value]=entries.find(([flag])=>!/seed/i.test(flag))??entries[0]??['','']
  const title=flag?`${flag.replace(/^--/,'')}=${value}`:'对照'
  return title.length>28?title.slice(0,27)+'…':title
}
export function researchGroupTitle(campaign:ResearchCampaign):string {
  const names:Record<string,string>={lr:'学习率',learning_rate:'学习率',batch_size:'批次大小','batch-size':'批次大小',num_epochs:'训练轮数',dropout_rate:'Dropout',seed:'随机种子'}
  const flag=campaign.axes.length===1?campaign.axes[0].flag.replace(/^--/,''):''
  const variable=flag?(names[flag]??flag.slice(0,12)):'参数'
  const source=/^(?:基线|[\w-]+=)/.test(campaign.baseline.title)?campaign.baseline.project||campaign.baseline.title:campaign.baseline.title
  const base=source.length>24?source.slice(0,23)+'…':source
  return `${base} · ${variable}对照`
}
export type ResearchPoolRow={kind:'task';task:ExperimentTask}|{kind:'campaign';campaign:ResearchView;tasks:ExperimentTask[]}
/** Group only explicit member associations, retaining the current task filtering/order. */
export function researchPoolRows(tasks:ExperimentTask[],campaigns:ResearchView[]):ResearchPoolRow[] {
  const owners=new Map<string,ResearchView>()
  for(const campaign of [...campaigns].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)))for(const member of campaign.members)if(member.taskId&&!owners.has(member.taskId))owners.set(member.taskId,campaign)
  const groups=new Map<string,Extract<ResearchPoolRow,{kind:'campaign'}>>(),rows:ResearchPoolRow[]=[]
  for(const task of tasks){
    const campaign=owners.get(task.id)
    if(!campaign){rows.push({kind:'task',task});continue}
    let group=groups.get(campaign.id)
    if(!group){group={kind:'campaign',campaign,tasks:[]};groups.set(campaign.id,group);rows.push(group)}
    group.tasks.push(task)
  }
  for(const group of groups.values())group.tasks.sort((a,b)=>group.campaign.members.findIndex(m=>m.taskId===a.id)-group.campaign.members.findIndex(m=>m.taskId===b.id))
  return rows
}
export function researchGroupStatus(tasks:ExperimentTask[]):ExperimentTaskStatus {
  for(const status of ['running','preparing','queued','failed','paused','planned'] as const)if(tasks.some(task=>task.status===status))return status
  return tasks.length>0&&tasks.every(task=>task.status==='cancelled')?'cancelled':'completed'
}
