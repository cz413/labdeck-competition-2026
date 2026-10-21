import type { ExperimentTaskDraft } from '@shared/types'
import { projectConfigurationKey } from '@shared/project-task'
import './project-task.css'

/** Saved project evidence remains visible on task cards; live project analysis lives in the smart create view. */
export function ProjectTaskEvidence({ draft }: { draft: ExperimentTaskDraft }): React.JSX.Element | null {
  const context = draft.projectPreparation
  if (!context) return null
  const current = context.configurationKey === projectConfigurationKey(draft)
  return <details className="project-task-evidence"><summary>项目依据与准备说明 <span>{new Date(context.generatedAt).toLocaleString('zh-CN')}</span></summary><p>{context.summary}</p><p>项目：{context.rootPath}</p>{!current && <p className="project-inline-warning">配置已修改，以下路径核对属于生成时的配置。运行时会重新检查目录和环境。</p>}
    {context.questions.length > 0 && <div><strong>建议补充的信息</strong><ul>{context.questions.map((question, index) => <li key={index}>{question}</li>)}</ul><small>可先保存草稿；在配置字段或备注中补充实际情况。</small></div>}
    {context.warnings.map((warning, index) => <p className="project-inline-warning" key={index}>{warning}</p>)}
    {context.checks.length > 0 && <div><strong>{current ? '生成时的路径核对' : '原配置的路径核对'}</strong>{context.checks.map((check, index) => <p key={index}>{check.status === 'confirmed' ? '已找到' : check.status === 'missing' ? '未找到' : check.status === 'outside' ? '超出项目范围' : '未核对'} · {check.path} · {check.message}</p>)}</div>}
    {context.steps.length > 0 && <div><strong>准备步骤参考</strong><p>按实际环境决定是否执行，可在服务器终端中操作。</p>{context.steps.map((step, index) => <div key={index}><h4>{step.title}</h4><p>{step.explanation}</p>{step.workingDirectory && <small>目录：{step.workingDirectory}</small>}{step.commands.map((command, commandIndex) => <pre key={commandIndex}>{command}</pre>)}</div>)}</div>}
    {context.citations.map((citation, index) => <div key={index}><strong>{citation.path}:{citation.startLine}–{citation.endLine}</strong><pre>{citation.quote}</pre></div>)}
  </details>
}
