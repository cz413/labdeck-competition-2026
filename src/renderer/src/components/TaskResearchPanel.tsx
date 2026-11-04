import { ArrowUpRight, ChevronDown } from 'lucide-react'
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
  return <details className="task-research-relations" aria-label="关联对照实验">
    <summary className="task-research-relations-summary"><ChevronDown size={14}/><span>关联对照实验</span><small>{related.length} 个</small></summary>
    <div className="task-research-relations-list">
    {related.map(campaign=><div className="task-research-relation" key={campaign.id}>
      <strong title={campaign.objective}>{campaign.objective}</strong>
      {campaign.sourceRunNumber!==undefined&&<span>基于第 {campaign.sourceRunNumber} 次运行</span>}
      {onOpenCampaign&&<button type="button" className="wb-text-button" onClick={()=>onOpenCampaign(campaign)}>查看对比<ArrowUpRight size={13}/></button>}
    </div>)}
    </div>
  </details>
}
