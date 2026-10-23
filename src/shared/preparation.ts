import type { ModelUsage } from './model-usage'
import type { ExperimentPlan, RefineResult, PlanConflict, PlanDataCandidate, PlanFields, ExperimentMode } from './experiment-plan'
import type { AgentTraceEvent } from './agent-trace'
import type { ExperimentTask, ExperimentTaskDraft, CondaEnvironmentInfo } from './types'
import type { RepositorySnapshot } from './repository-guide'

export interface PreparationInput { serverId:string; accessRouteId:string; path:string; goal:string; filePaths?:string[] }
export interface PreparationEdit {
  draft:ExperimentTaskDraft; mode:ExperimentMode; fields:PlanFields
  deferredGaps:string[]; conflicts:PlanConflict[]
  history:{id:number;label:string;at:string;before:{draft:ExperimentTaskDraft;mode:ExperimentMode;fields:PlanFields}}[]
}
export interface PreparationFlow {
  id:string; input:PreparationInput; createdAt:string; updatedAt:string; revision:number
  snapshot?:RepositorySnapshot; files:string[]; environments:CondaEnvironmentInfo[]; dataCandidates:PlanDataCandidate[]
  plan?:ExperimentPlan; initialPlan?:ExperimentPlan; edit?:PreparationEdit
  taskId?:string; savedRevision?:number
  checks?:{at:string;configurationKey?:string;lines:{ok:boolean;text:string}[]}
}
export interface PreparationView extends PreparationFlow {
  phase:'analyzing'|'needs_input'|'review'|'saved'|'paused'|'failed'
  busy:boolean; pending:string[]; error?:string; trace:AgentTraceEvent[]; usage?:ModelUsage; task?:ExperimentTask
}
export interface PreparationSummary {
  id:string;input:PreparationInput;updatedAt:string;phase:PreparationView['phase'];title:string;taskId?:string;busy?:boolean
}
export type PreparationAction =
  | {kind:'edit';expectedRevision:number;edit:PreparationEdit;label?:string}
  | {kind:'recheck';expectedRevision:number}
  | {kind:'save';expectedRevision:number}
  | {kind:'save-as-new';expectedRevision:number}
  | {kind:'resume'}
export interface PreparationApi {
  create(input:PreparationInput,id:string):Promise<PreparationView>
  get(id:string):Promise<PreparationView>
  list():Promise<PreparationSummary[]>
  act(id:string,action:PreparationAction):Promise<PreparationView>
  refine(id:string,instruction:string,expectedRevision:number):Promise<RefineResult>
  remove(id:string):Promise<void>
  cancel(id:string):Promise<void>
  onChanged(listener:(id:string)=>void):()=>void
}
