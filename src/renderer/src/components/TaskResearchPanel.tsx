import { ArrowUpRight } from 'lucide-react'
import type { ResearchView } from '@shared/research'
import type { ExperimentTask } from '@shared/types'
import './research.css'

interface Props {
  task: ExperimentTask
  campaigns: ResearchView[]
  onOpenCampaign?(campaign: ResearchView): void
}

export function TaskResearchPanel({task,campaigns,onOpenCampaign}:Props):React.JSX.Element|null {
  const related=campaigns.filter(campaign=>campaign.sourceTaskId===task.id)
    .sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt))
  if(!related.length)return null
  return <section className="task-research-relations" aria-label="关联对照实验">
    {related.map(campaign=><div className="task-research-relation" key={campaign.id}>
      <span>后续对照实验</span>
      <strong title={campaign.objective}>{campaign.objective}</strong>
      {campaign.sourceRunNumber!==undefined&&<span>基于第 {campaign.sourceRunNumber} 次运行</span>}
      {onOpenCampaign&&<button type="button" className="wb-text-button" onClick={()=>onOpenCampaign(campaign)}>查看对比<ArrowUpRight size={13}/></button>}
    </div>)}
  </section>
}
