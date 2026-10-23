import type { ExperimentRun } from '@shared/types'
import { ExperimentRunLogPanel } from './ExperimentRunLogPanel'

export function RunLogPanel({taskId,run,enabled,onClose}:{taskId:string;run:ExperimentRun;enabled:boolean;onClose():void}):React.JSX.Element {
  return <ExperimentRunLogPanel taskId={taskId} run={run} enabled={enabled} onClose={onClose}/>
}
