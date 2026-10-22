import type { ModelUsage } from './model-usage'

export interface AgentTraceEvent {
  id: string
  kind: 'step' | 'tool' | 'model' | 'user'
  name: string
  status: 'running' | 'completed' | 'warning' | 'failed' | 'cancelled'
  startedAt: string
  finishedAt?: string
  elapsedMs?: number
  summary: string
  references?: { path: string; startLine?: number; endLine?: number }[]
  usage?: ModelUsage
}
export type AgentTraceObserver = (event: AgentTraceEvent) => void
