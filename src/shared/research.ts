import type { ExperimentTask, ExperimentTaskDraft } from './types'
export interface ParameterAxis { flag: string; values: string[] }
export interface ResearchInput { taskId: string; objective: string; axes: ParameterAxis[]; maxRuns: number; useModel: boolean }
export interface ParameterVariant { key: string; parameters: Record<string,string>; command: string; changes: string[] }
export interface ParameterExpansion { variants: ParameterVariant[]; warnings: string[]; engine: 'cangjie' | 'typescript'; version: string }
export interface ResearchMember extends ParameterVariant { taskId?: string; runId?: string }
export interface RunObservation { key: string; taskId: string; runId: string; status: string; evidenceId: string; metrics: Record<string,number>; excerpt: string; exitCode?: number; diagnosisId?: string; warning?: string }
export interface ResearchAnalysis { engine: 'model' | 'rules'; summary: string; observations: string[]; limitations: string[]; nextSuggestion?: { objective: string; axes: ParameterAxis[] }; evidenceIds: string[] }
export interface ResearchEvent { at: string; node: string; message: string }
export interface ResearchCampaign {
  id: string; createdAt: string; updatedAt: string; objective: string; sourceTaskId: string; baseline: ExperimentTaskDraft;
  axes: ParameterAxis[]; maxRuns: number; useModel: boolean; stage: 'review' | 'waiting' | 'analysis';
  members: ResearchMember[]; expansionEngine: 'cangjie' | 'typescript'; warnings: string[]; observations: RunObservation[];
  analysis?: ResearchAnalysis; events: ResearchEvent[]; approvedAt?: string;
}
export interface ResearchView extends ResearchCampaign { paused: boolean; error?: string; pending: string[] }
export interface ResearchSuggestion { axes: ParameterAxis[]; assumptions: string[]; hypothesis: string }
export interface ResearchApi {
  preview(command: string, axes: ParameterAxis[], maxRuns: number): Promise<ParameterExpansion>;
  list(): Promise<ResearchView[]>;
  suggest(taskId: string, objective: string, maxRuns: number): Promise<ResearchSuggestion>;
  create(input: ResearchInput): Promise<ResearchView>;
  approve(id: string, confirmed: boolean): Promise<ResearchView>;
  refresh(id: string): Promise<ResearchView>;
  analyze(id: string): Promise<ResearchView>;
  setPaused(id: string, paused: boolean): Promise<ResearchView>;
  engine(): Promise<{ available: boolean; path: string; message: string }>;
  export(id: string): Promise<string | null>;
  onChanged(listener: () => void): () => void;
}
export function baselineDraft(task: ExperimentTask): ExperimentTaskDraft {
  const { id: _id, runs: _runs, archived: _archived, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = task
  return { ...draft, status: 'planned' }
}

