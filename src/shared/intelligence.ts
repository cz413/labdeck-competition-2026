import type { ExperimentTask, ExperimentTaskDraft } from './types'

export interface ModelSettings { enabled: boolean; endpoint: string; model: string; hasApiKey: boolean }
export interface ModelSettingsInput { enabled: boolean; endpoint: string; model: string; apiKey?: string; clearApiKey?: boolean }
export interface Evidence { id: string; source: 'log' | 'resource' | 'environment' | 'runtime'; label: string; text: string; line?: number }
export interface Finding { category: string; title: string; confidence: 'high' | 'medium' | 'low'; explanation: string; evidenceIds: string[]; steps: string[] }
export interface BatchRepair { kind: 'reduce-batch'; before: string; after: string; previousBatch: number; nextBatch: number }
export type DiagnosticToolName = 'search_log' | 'inspect_path' | 'read_project_file' | 'inspect_package' | 'inspect_environment' | 'inspect_gpu'
export interface DiagnosticToolCall { tool: DiagnosticToolName; arguments: Record<string, string>; reason: string; evidenceIds: string[] }
export interface DiagnosticStep { round: number; kind: 'model' | 'tool'; label: string; status: 'completed' | 'failed' | 'unavailable'; reason?: string; tool?: DiagnosticToolName; arguments?: Record<string, string>; evidenceIds: string[]; elapsedMs: number }
export interface AgentInvestigation { status: 'completed' | 'partial' | 'cancelled' | 'failed'; rounds: number; inspections: number; trace: DiagnosticStep[] }
export interface DiagnosisProgress { requestId: string; stage: 'collect' | 'model' | 'tool' | 'complete' | 'cancelled'; message: string; round?: number }
export interface RepairClosure {
  enabled: boolean; status: 'waiting' | 'running' | 'verifying' | 'passed' | 'failed' | 'attention' | 'paused';
  message: string; updatedAt: string; attempts: number; checkedAt?: string; nextCheckAt?: string;
  exitCode?: number; nextDiagnosisId?: string;
}
export interface DiagnosisReport {
  id: string; createdAt: string; title: string; source: 'remote' | 'pasted' | 'sample'; engine: 'rules' | 'model+rules' | 'agent+rules';
  taskId?: string; runId?: string; logExcerpt: string; evidence: Evidence[]; findings: Finding[]; warnings: string[];
  summary?: string; investigation?: AgentInvestigation; repair?: BatchRepair; retryRunId?: string; useModel?: boolean; closure?: RepairClosure;
}
export interface DiagnosisInput { taskId?: string; runId?: string; logText?: string; sample?: 'oom' | 'dependency' | 'path'; useModel: boolean; requestId?: string }
export interface ExperimentPlan { draft: ExperimentTaskDraft; assumptions: string[]; checks: string[]; engine: 'model' }
export interface PlanInput { intent: string; serverId: string; codePath: string; environmentName: string }
export interface Verification { status: 'waiting' | 'running' | 'completed' | 'failed' | 'unknown'; message: string; runId?: string; diagnosis?: DiagnosisReport; exitCode?: number; checkedAt?: string }
export interface IntelligenceApi {
  settings(): Promise<ModelSettings>;
  saveSettings(input: ModelSettingsInput): Promise<ModelSettings>;
  testModel(): Promise<string>;
  diagnose(input: DiagnosisInput): Promise<DiagnosisReport>;
  history(): Promise<DiagnosisReport[]>;
  cancelDiagnosis(requestId: string): Promise<void>;
  setTracking(reportId: string, enabled: boolean): Promise<DiagnosisReport>;
  onHistoryChanged(listener: () => void): () => void;
  onDiagnosisProgress(listener: (event: DiagnosisProgress) => void): () => void;
  plan(input: PlanInput): Promise<ExperimentPlan>;
  retry(reportId: string, confirmed: boolean): Promise<ExperimentTask>;
  verify(reportId: string): Promise<Verification>;
  exportReport(reportId: string): Promise<string | null>;
}
