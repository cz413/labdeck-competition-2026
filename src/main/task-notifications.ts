import type { ExperimentTask, TaskFinishedEvent } from '../shared/types'

/** Starts from persisted state so opening the app does not replay old completions. */
export class TaskCompletionTracker {
  private readonly statuses = new Map<string, string>()

  constructor(tasks: ExperimentTask[]) {
    this.collect(tasks)
  }

  collect(tasks: ExperimentTask[]): TaskFinishedEvent[] {
    const events: TaskFinishedEvent[] = []
    const currentKeys = new Set<string>()
    for (const task of tasks) {
      for (const run of task.runs) {
        const key = `${task.id}:${run.id}`
        currentKeys.add(key)
        const previous = this.statuses.get(key)
        this.statuses.set(key, run.status)
        if (!previous || !['running', 'preparing', 'paused'].includes(previous)) continue
        if (!['completed', 'failed', 'cancelled'].includes(run.status)) continue
        const unknown = run.message?.includes('没有读到退出码') ?? false
        events.push({
          taskId: task.id,
          runId: run.id,
          serverId: run.serverId ?? task.serverId,
          gpuIndex: run.gpuIndex ?? task.gpuIndex,
          title: `${task.title} · 第 ${run.number} 次运行`,
          serverName: run.serverNameSnapshot ?? task.serverNameSnapshot ?? '服务器',
          outcome: unknown ? 'unknown' : run.status as 'completed' | 'failed' | 'cancelled',
          message: run.message ?? run.resultSummary ?? ''
        })
      }
    }
    for (const key of this.statuses.keys()) {
      if (!currentKeys.has(key)) this.statuses.delete(key)
    }
    return events
  }
}
