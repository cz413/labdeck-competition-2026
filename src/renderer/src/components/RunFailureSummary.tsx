import type { ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import type { ExperimentRun } from '@shared/types'
import type { DiagnosisReport } from '@shared/intelligence'
import { diagnosisPresentation } from '@shared/diagnosis-presentation'

interface Props {
  run: ExperimentRun
  report?: DiagnosisReport
  compact?: boolean
  action?: ReactNode
}

export function RunFailureSummary({run, report, compact, action}: Props): React.JSX.Element {
  const directReport = report?.runId === run.id ? report : undefined
  const primary = directReport ? diagnosisPresentation(directReport).primary : undefined
  const reason = primary && primary.category !== 'unknown' ? primary.title : '失败原因待分析'
  return <div className={`experiment-failure-summary ${compact ? 'compact' : 'experiment-run-failure'}`}>
    {!compact && <strong><CircleAlert size={14} />第 {run.number} 次运行失败</strong>}
    <div className="experiment-run-result"><p className="experiment-failure-reason">{reason}</p>{action}</div>

  </div>
}
