import { describe, expect, it } from 'vitest'
import { TaskCompletionTracker } from './task-notifications'
import type { ExperimentRunStatus, ExperimentTask } from '../shared/types'

const tasks = (status: ExperimentRunStatus, message = ''): ExperimentTask[] => [{
  id: 'task', title: '模型训练', serverId: 'server', serverNameSnapshot: 'gpu8',
  runs: [{ id: 'run', number: 1, status, message, resultSummary: '', notes: '' }]
} as ExperimentTask]

describe('experiment completion notifications', () => {
  it('does not replay finished runs when the app starts', () => {
    const tracker = new TaskCompletionTracker(tasks('completed'))
    expect(tracker.collect(tasks('completed'))).toEqual([])
  })
  it.each(['completed', 'failed', 'cancelled'] as const)('emits one notification when a running experiment becomes %s', status => {
    const tracker = new TaskCompletionTracker(tasks('running'))
    expect(tracker.collect(tasks(status))[0]).toMatchObject({ taskId: 'task', runId: 'run', outcome: status, serverName: 'gpu8' })
    expect(tracker.collect(tasks(status))).toEqual([])
  })
  it('does not interpret an unreadable remote status as completion', () => {
    const tracker = new TaskCompletionTracker(tasks('running'))
    expect(tracker.collect(tasks('running', '运行中 · 状态暂不可读：断线'))).toEqual([])
    expect(tracker.collect(tasks('failed', '远程进程已结束，但没有读到退出码；请查看运行日志'))[0].outcome).toBe('unknown')
  })
  it('keeps tracking new runs and does not alert when removing a queued run', () => {
    const tracker = new TaskCompletionTracker([])
    expect(tracker.collect(tasks('queued'))).toEqual([])
    expect(tracker.collect(tasks('cancelled'))).toEqual([])
    tracker.collect(tasks('running'))
    expect(tracker.collect(tasks('completed'))).toHaveLength(1)
  })
})
