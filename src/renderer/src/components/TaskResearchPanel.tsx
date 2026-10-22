import type { ResearchView } from '@shared/research'
import type { ExperimentTask } from '@shared/types'
import { ResearchResults } from './ResearchResults'
import './research.css'

interface Props {
  task: ExperimentTask
  tasks: ExperimentTask[]
  campaigns: ResearchView[]
  onOpenCampaign?(campaign: ResearchView): void
  onOpenTask?(task: ExperimentTask, runId?: string): void
}
const stages = {review: '待确认', waiting: '跟踪中', analysis: '已记录分析'}
const statuses: Record<string, string> = {
  planned: '草稿', queued: '排队中', preparing: '准备运行', running: '运行中',
  paused: '已暂停', completed: '正常结束', failed: '运行故障', cancelled: '已取消'
}

export function TaskResearchPanel(props: Props): React.JSX.Element | null {
  const related = props.campaigns.filter(c => c.sourceTaskId === props.task.id || c.members.some(m => m.taskId === props.task.id))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  if (!related.length) return null
  return <section className="task-research-panel" aria-label="关联的对照实验">
    <h3>对照实验与结果 <span>{related.length} 个对照批次</span></h3>
    {related.map(campaign => {
      const source = campaign.sourceTaskId === props.task.id
      const parent = props.tasks.find(t => t.id === campaign.sourceTaskId)
      const members = source ? campaign.members : campaign.members.filter(m => m.taskId === props.task.id)
      // A later independent rerun must never inherit a batch's earlier observations.
      const observations = campaign.observations.filter(o => members.some(m => m.taskId === o.taskId && m.runId === o.runId && m.key === o.key))
      return <details key={campaign.id} className="task-research-batch">
        <summary>{source ? '来源任务' : '参数变体'} · {campaign.objective}<span>{campaign.error ? '跟踪待处理' : campaign.paused ? '跟踪已暂停' : stages[campaign.stage]}</span></summary>
        <p className="research-note">批次 {campaign.id} · 更新于 {new Date(campaign.updatedAt).toLocaleString('zh-CN')}</p>
        <div className="task-research-links">
          {props.onOpenCampaign && <button type="button" className="secondary-button" onClick={() => props.onOpenCampaign?.(campaign)}>打开对应批次与分析</button>}
          {!source && props.onOpenTask && <button type="button" className="secondary-button" disabled={!parent} onClick={() => parent && props.onOpenTask?.(parent)}>{parent ? `来源任务：${parent.title}` : '来源任务已删除'}</button>}
        </div>
        {campaign.error && <p className="intel-error">{campaign.error}</p>}
        <ul className="task-research-members">{members.map(member => {
          const task = props.tasks.find(t => t.id === member.taskId)
          const run = task?.runs.find(r => r.id === member.runId)
          return <li key={member.key}>
            <strong>{member.key}</strong>
            <span>{Object.entries(member.parameters).map(([flag, value]) => `${flag}=${value}`).join(' · ') || '基线配置'}</span>
            <span>{run ? `第 ${run.number} 次运行 · ${statuses[run.status] ?? run.status}` : member.runId ? '关联运行已删除' : '尚未入队'}</span>
            {props.onOpenTask && <button type="button" className="wb-text-button" disabled={!task || (!!member.runId && !run)} onClick={() => task && props.onOpenTask?.(task, member.runId)}>{task ? '查看任务与运行' : member.taskId ? '关联任务已删除' : '确认批次后创建任务'}</button>}
          </li>
        })}</ul>
        {campaign.analysis && <p className="experiment-result"><strong>本批分析：</strong>{campaign.analysis.summary}</p>}
        {observations.length > 0 ? <details><summary>查看已采集的指标与产物（{observations.length} 条运行记录）</summary><ResearchResults observations={observations} /></details> : <p className="research-note">尚无本批运行的结果快照，可打开批次查看跟踪进度。</p>}
        <p className="research-note">重新运行后，请重新采集结果以更新对比。</p>
      </details>
    })}
  </section>
}
