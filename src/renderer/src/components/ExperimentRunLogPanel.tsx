import { useCallback } from 'react'
import type { ExperimentRun } from '@shared/types'
import { RemoteLogPanel } from './RemoteLogPanel'

export function ExperimentRunLogPanel({ taskId, run, enabled = true, onClose }: { taskId: string; run: ExperimentRun; enabled?: boolean; onClose?():void }): React.JSX.Element {
  const readLog = useCallback(() => window.labApi.experiments.readRunLog(taskId, run.id), [taskId, run.id])
  return <RemoteLogPanel onClose={onClose} enabled={enabled} label={`第 ${run.number} 次运行日志`} logPath={run.logPath} running={run.status === 'running'} readLog={readLog} />
}
