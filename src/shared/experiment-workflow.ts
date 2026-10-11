import type { DiagnosisReport } from './intelligence'

export interface IntelligenceRequest {
  id: string; tab: 'diagnosis' | 'plan' | 'closure' | 'research'; taskId?: string; runId?: string; reportId?: string
}

// Match exact runs, never infer association from the task's latest status.
export function reportForRun(reports: DiagnosisReport[], taskId: string, runId: string): DiagnosisReport | undefined {
  const matching = reports.filter(r => r.taskId === taskId && (r.runId === runId || r.retryRunId === runId))
  return matching.filter(r => r.runId === runId).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
    ?? matching.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
}

