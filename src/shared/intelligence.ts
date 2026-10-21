import type { ModelUsage } from './model-usage'
import type { ExternalExperimentContext, ExternalLogSnapshot, ExternalDraftInput } from './external-experiment'
import type { ExperimentTask, ExperimentTaskDraft } from './types'
import type { RepositoryInput, RepositorySnapshot, RepositoryAnalysisInput, RepositoryGuide, RepositoryCandidate, RepositoryDirectoryView, RepositoryProgress, RepositoryWorkflowAction, RepositoryWorkflowView } from './repository-guide'

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
  enabled: boolean; useModelOnFailure?: boolean; status: 'waiting' | 'running' | 'verifying' | 'passed' | 'failed' | 'attention' | 'paused';
  message: string; updatedAt: string; attempts: number; checkedAt?: string; nextCheckAt?: string;
  exitCode?: number; nextDiagnosisId?: string;
}
export interface DiagnosisReport {
  id: string; createdAt: string; title: string; source: 'remote' | 'external' | 'pasted' | 'sample'; engine: 'rules' | 'model+rules' | 'agent+rules';
  usage?: ModelUsage; cacheKey?:string; cacheHit?:boolean;
  externalContext?: ExternalExperimentContext; externalLog?: ExternalLogSnapshot; importedTaskId?: string;
  taskId?: string; runId?: string; logExcerpt: string; evidence: Evidence[]; findings: Finding[]; warnings: string[];
  summary?: string; investigation?: AgentInvestigation; repair?: BatchRepair; retryRunId?: string; useModel?: boolean; closure?: RepairClosure;
}
export interface DiagnosisInput { force?:boolean; external?: ExternalExperimentContext; taskId?: string; runId?: string; logText?: string; sample?: 'oom' | 'dependency' | 'path'; useModel: boolean; depth?: 'quick' | 'inspect'; requestId?: string }
export interface ExperimentPlan { draft: ExperimentTaskDraft; assumptions: string[]; checks: string[]; engine: 'model' }
export interface PlanInput { useReadme?: boolean; condaManagerPath?: string; accessRouteId?: string; readmePath?: string; intent: string; serverId: string; codePath: string; environmentName: string }
export interface Verification { status: 'waiting' | 'running' | 'completed' | 'failed' | 'unknown'; message: string; runId?: string; diagnosis?: DiagnosisReport; exitCode?: number; checkedAt?: string }
export interface IntelligenceApi {
  settings(): Promise<ModelSettings>;
  saveSettings(input: ModelSettingsInput): Promise<ModelSettings>;
  testModel(): Promise<string>;
  diagnose(input: DiagnosisInput): Promise<DiagnosisReport>;
  history(): Promise<DiagnosisReport[]>;
  saveExternalDraft(reportId:string,input:ExternalDraftInput):Promise<ExperimentTask>;
  cancelDiagnosis(requestId: string): Promise<void>;
  setTracking(reportId: string, enabled: boolean): Promise<DiagnosisReport>;
  onHistoryChanged(listener: () => void): () => void;
  onDiagnosisProgress(listener: (event: DiagnosisProgress) => void): () => void;
  detectReadme(input: PlanInput): Promise<{status: 'found'|'missing'|'unavailable'; name?: string}>;
  repositoryWorkflows():Promise<RepositoryWorkflowView[]>;
  createRepositoryWorkflow(input:RepositoryAnalysisInput,id?:string):Promise<RepositoryWorkflowView>;
  actRepositoryWorkflow(id:string,action:RepositoryWorkflowAction):Promise<RepositoryWorkflowView>;
  cancelRepositoryWorkflow(id:string):Promise<void>;
  onRepositoryChanged(listener:()=>void):()=>void;
  onRepositoryProgress(listener:(event:RepositoryProgress)=>void):()=>void;
  discoverRepositories(input:{serverId:string;accessRouteId?:string}):Promise<RepositoryCandidate[]>;
  browseRepositoryDirectory(input:{serverId:string;accessRouteId?:string;path?:string}):Promise<RepositoryDirectoryView>;
  inspectRepository(input: RepositoryInput): Promise<RepositorySnapshot>;
  analyzeRepository(input: RepositoryAnalysisInput): Promise<RepositoryGuide>;
  plan(input: PlanInput): Promise<ExperimentPlan>;
  retry(reportId: string, confirmed: boolean, useModelOnFailure?: boolean): Promise<ExperimentTask>;
  verify(reportId: string): Promise<Verification>;
  exportReport(reportId: string): Promise<string | null>;
}
