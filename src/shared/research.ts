import type { ResultCollectionConfig, ResultMetric, ResultFileEvidence, ProcessEvidenceState, ResultEvidenceState } from './research-results'
import type { ExperimentTask, ExperimentTaskDraft } from './types'
export interface ParameterAxis { flag: string; values: string[] }
export interface ResearchInput { taskId: string; sourceRunId?: string; objective: string; axes: ParameterAxis[]; maxRuns: number; useModel?: boolean; resultConfig?: ResultCollectionConfig; expectedBaselineCommand?: string; design?: ResearchSuggestion }
export interface ParameterVariant { key: string; parameters: Record<string,string>; command: string; changes: string[] }
export interface ParameterExpansion { variants: ParameterVariant[]; warnings: string[]; engine: 'cangjie' | 'typescript'; version: string }
export interface ResearchMember extends ParameterVariant { taskId?: string; runId?: string; outputDirectory?:string }
export interface ResearchOutputIsolation {status:'verified'|'unverified';flag?:string;template?:string;originalValue?:string;reason?:string;source?:{path:string;startLine:number;quote:string}}
export interface RunObservation { key: string; taskId: string; runId: string; status: string; evidenceId: string; metrics: Record<string,number>; excerpt: string; exitCode?: number; diagnosisId?: string; warning?: string; metricDetails?: ResultMetric[]; files?: ResultFileEvidence[]; collectedAt?: string; processState?: ProcessEvidenceState; evidenceState?: ResultEvidenceState }
export interface ResearchAnalysis { contentVersion?:number; engine: 'model' | 'rules'; summary: string; observations: string[]; limitations: string[]; nextSuggestion?: { objective: string; axes: ParameterAxis[] }; evidenceIds: string[] }
export interface ResearchEvent { at: string; node: string; message: string }
export interface ResearchCampaign {
  id: string; createdAt: string; updatedAt: string; objective: string; sourceTaskId: string; sourceRunId?: string; sourceRunNumber?: number; baseline: ExperimentTaskDraft;
  axes: ParameterAxis[]; maxRuns: number; useModel: boolean; stage: 'review' | 'waiting' | 'analysis';
  members: ResearchMember[]; expansionEngine: 'cangjie' | 'typescript'; warnings: string[]; observations: RunObservation[];
  outputIsolation?:ResearchOutputIsolation; design?: ResearchSuggestion; resultConfig?: ResultCollectionConfig; analysis?: ResearchAnalysis; events: ResearchEvent[]; approvedAt?: string;
}
export interface ResearchView extends ResearchCampaign { busy?:boolean; paused: boolean; error?: string; pending: string[] }
export interface ResearchSuggestion {
  axes: ParameterAxis[]; assumptions: string[]; hypothesis: string
  status?: 'ready' | 'needs_info'; baselineCommand?: string; rationale?: string
  variable?: {flag:string;baselineValue:string;source:{path:string;startLine:number;quote:string}}
  readFiles?: string[]
}
export interface ResearchApi {
  preview(command: string, axes: ParameterAxis[], maxRuns: number): Promise<ParameterExpansion>;
  list(): Promise<ResearchView[]>;
  remove(id:string):Promise<void>;
  removeBatch(id:string):Promise<void>;
  suggest(taskId: string, objective: string, maxRuns: number, sourceRunId?: string): Promise<ResearchSuggestion>;
  create(input: ResearchInput): Promise<ResearchView>;
  approve(id: string, confirmed: boolean): Promise<ResearchView>;
  refresh(id: string): Promise<ResearchView>;
  analyze(id: string): Promise<ResearchView>;
  recollect(id: string, config?: ResultCollectionConfig): Promise<ResearchView>;
  setPaused(id: string, paused: boolean): Promise<ResearchView>;
  engine(): Promise<{ available: boolean; path: string; message: string }>;
  export(id: string): Promise<string | null>;
  onChanged(listener: () => void): () => void;
}
export function baselineDraft(task: ExperimentTask, sourceRunId?:string): ExperimentTaskDraft {
  const { id: _id, runs: _runs, archived: _archived, createdAt: _createdAt, updatedAt: _updatedAt, ...draft } = task
  if(!sourceRunId)return { ...draft, status: 'planned' }
  const run=task.runs.find(item=>item.id===sourceRunId)
  if(!run)throw new Error('所选运行记录不存在，请重新选择')
  if(!run.serverId||!run.codePath||run.launchCommand===undefined)throw new Error('该运行缺少完整配置快照，无法作为基准')
  return {...draft,status:'planned',serverId:run.serverId,serverNameSnapshot:run.serverNameSnapshot,
    accessRouteId:run.accessRouteId,computeDevice:run.computeDevice??'gpu',gpuUuid:undefined,gpuIndex:undefined,gpuNameSnapshot:undefined,
    codePath:run.codePath,dataPath:run.dataPath??'',launchCommand:run.launchCommand,launchMode:run.launchMode??'command',scriptPath:run.scriptPath??'',
    condaEnvironment:run.condaEnvironment,artifactPath:run.artifactPath??'',
    minimumFreeVramGiB:run.minimumFreeVramGiB??undefined,maximumGpuUtilizationPercent:run.maximumGpuUtilizationPercent??undefined,
    resultSummary:'',projectPreparation:undefined,preparationId:undefined}

}

