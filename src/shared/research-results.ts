import { z } from 'zod'
import type { ExperimentRun } from './types'
import type { ParameterVariant, RunObservation } from './research'

export interface ResultCollectionConfig { metricsFile: string; artifacts: string[]; resultFiles?: string[] }
export type MetricDirection = 'minimize' | 'maximize' | 'observe'
export interface ResultMetric {
  name: string; value: number; dataset?: string; split?: string; unit?: string;
  epoch?: number; step?: number; direction?: MetricDirection;
  source: 'metrics_json' | 'log'; sourcePath: string;
}
export interface ResultFileEvidence {
  path: string; role: 'metrics' | 'artifact' | 'result'; text?:string; truncated?:boolean;
  status: 'available' | 'missing' | 'unreadable' | 'unsupported' | 'too_large' | 'changed' | 'invalid';
  kind?: 'file' | 'directory'; sizeBytes?: number; modifiedAt?: string; resolvedPath?: string;
  association?: 'run_id' | 'run_directory' | 'output_directory' | 'unverified'; message?: string;
}
export type ProcessEvidenceState = 'completed' | 'failed' | 'cancelled' | 'unknown'
export type ResultEvidenceState = 'complete' | 'partial' | 'missing'
export const MAX_RESULT_BYTES = 128 * 1024
export const resultPathSchema = z.string().trim().max(2048).refine(value => !/[\x00-\x1f\x7f]/.test(value), '结果路径不能包含控制字符')
  .refine(value => !value.split('/').includes('..'), '结果路径不能包含父目录跳转')
  .refine(value => !/[{}]/.test(value.replace(/\{runId\}|\{runDir\}/g, '')), '结果路径只支持 {runId} 和 {runDir} 占位符')
export const resultConfigSchema = z.object({
  metricsFile: resultPathSchema.default(''),
  resultFiles:z.array(resultPathSchema.refine(value=>!!value,'结果文件路径不能为空')).max(8).optional(),
  artifacts: z.array(resultPathSchema.refine(value => !!value, '产物路径不能为空')).max(8).default([])
}).strict().refine(config=>new Set(config.resultFiles??[]).size===(config.resultFiles??[]).length,'结果文件路径不能重复').refine(config=>!(config.metricsFile&&config.resultFiles?.length),'请选择一种结果文件配置').refine(config=>(config.resultFiles?.length??0)+config.artifacts.length+(config.metricsFile?1:0)<=9,'结果文件数量超限').refine(config => new Set(config.artifacts).size === config.artifacts.length, '产物路径不能重复')
export function normalizeResultConfig(config?: ResultCollectionConfig): ResultCollectionConfig {
  return resultConfigSchema.parse(config ?? { metricsFile: '', artifacts: [] })
}
export function resolveResultPath(template: string, context: Pick<ExperimentRun, 'id' | 'remoteRunDir' | 'codePath'>): string {
  resultPathSchema.parse(template)
  if (!template) throw new Error('结果路径为空')
  if (template.includes('{runDir}') && !context.remoteRunDir?.startsWith('/')) throw new Error('运行目录尚未记录，无法解析 {runDir}')
  const expanded = template.replace(/\{runId\}/g, context.id).replace(/\{runDir\}/g, context.remoteRunDir ?? '')
  const path = expanded.startsWith('/') ? expanded : `${context.codePath ?? ''}/${expanded}`
  if (!path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path) || path.split('/').includes('..') || (!expanded.startsWith('/') && !context.codePath?.startsWith('/'))) throw new Error('结果路径必须是远程绝对路径或相对代码目录的路径')
  return path.replace(/\/{2,}/g, '/')
}
const metadataSchema = z.object({
  dataset: z.string().trim().min(1).max(160).optional(), split: z.string().trim().min(1).max(80).optional(),
  unit: z.string().trim().min(1).max(40).optional(), epoch: z.number().int().nonnegative().optional(),
  step: z.number().int().nonnegative().optional(), direction: z.enum(['minimize', 'maximize', 'observe']).optional()
})
const metricSchema = metadataSchema.extend({ name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_./%-]{0,79}$/), value: z.number().finite() }).strict()
const recordValueSchema = z.union([z.number().finite(), metadataSchema.extend({ value: z.number().finite() }).strict()])
const envelopeSchema = metadataSchema.extend({
  schemaVersion: z.literal(1).optional(), runId: z.string().min(1).max(160).optional(),
  metrics: z.union([z.array(metricSchema).min(1).max(40), z.record(z.string(), recordValueSchema)])
}).strict()
export function metricIdentity(metric: ResultMetric): string {
  return JSON.stringify([metric.source, metric.name, metric.dataset ?? null, metric.split ?? null, metric.unit ?? null,
    metric.epoch ?? null, metric.step ?? null, metric.direction ?? null])
}
export function metricContext(metric: ResultMetric): string {
  return [metric.dataset ?? '数据集未声明', metric.split ?? '阶段未声明', metric.unit ?? '单位未声明',
    metric.epoch === undefined ? '' : `epoch ${metric.epoch}`, metric.step === undefined ? '' : `step ${metric.step}`,
    metric.direction === 'minimize' ? '越小越好' : metric.direction === 'maximize' ? '越大越好' : metric.direction === 'observe' ? '仅观察' : '方向未声明'].filter(Boolean).join(' · ')
}
export function parseStructuredMetrics(raw: string, path: string, runId: string): { metrics: ResultMetric[]; runId?: string } {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('指标文件不是有效 JSON，请核对 UTF-8 编码和文件是否完整') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('指标文件需要 JSON 对象')
  let envelope: unknown = parsed
  if (!('metrics' in parsed)) {
    const entries = Object.entries(parsed).filter(([key]) => !['schemaVersion','runId','dataset','split','unit','epoch','step','direction'].includes(key))
    envelope = { ...Object.fromEntries(Object.entries(parsed).filter(([key]) => ['schemaVersion','runId','dataset','split','unit','epoch','step','direction'].includes(key))), metrics: Object.fromEntries(entries) }
  }
  const data = envelopeSchema.parse(envelope)
  if (data.runId && data.runId !== runId) throw new Error('指标文件的 runId 与当前运行不一致，未采用该文件的指标')
  const { metrics, schemaVersion: _version, runId: declaredRunId, ...context } = data
  const values = Array.isArray(metrics) ? metrics : Object.entries(metrics).map(([name, value]) => metricSchema.parse({ name, ...(typeof value === 'number' ? { value } : value) }))
  if (!values.length || values.length > 40) throw new Error('指标文件需要 1～40 项有效指标')
  const result = values.map(value => ({ ...context, ...value, source: 'metrics_json' as const, sourcePath: path }))
  if (new Set(result.map(metricIdentity)).size !== result.length) throw new Error('同一指标口径出现重复值，请保留明确的一项结果')
  return { metrics: result, runId: declaredRunId }
}
export function observationMetrics(observation: RunObservation): ResultMetric[] {
  return observation.metricDetails ?? Object.entries(observation.metrics).map(([name,value]) => ({ name, value, source: 'log', sourcePath: '历史日志（未保存文件来源）' }))
}
export function processEvidenceState(observation: Pick<RunObservation, 'status' | 'exitCode'>): ProcessEvidenceState {
  if (observation.status === 'cancelled') return 'cancelled'
  if (observation.exitCode !== undefined && observation.exitCode !== 0) return 'failed'
  if (observation.status === 'failed' && observation.exitCode === 0) return 'unknown'
  if (observation.status === 'failed') return 'failed'
  if (observation.status === 'completed' && observation.exitCode === 0) return 'completed'
  return 'unknown'
}
export function evidenceState(observation: RunObservation): ResultEvidenceState {
  const points = observationMetrics(observation), files = observation.files ?? []
  const hasText=files.some(file=>file.role==='result'&&file.status==='available'&&!!file.text)
  if (!points.length && !files.some(file => file.status === 'available')) return 'missing'
  if ((!points.length&&!hasText) || processEvidenceState(observation) !== 'completed' || files.some(file => file.status !== 'available' || !file.association || file.association === 'unverified')) return 'partial'
  return 'complete'
}
export function metricColumns(observations: RunObservation[]): ResultMetric[] {
  const columns = new Map<string, ResultMetric>()
  for (const observation of observations) for (const metric of observationMetrics(observation)) columns.set(metricIdentity(metric), metric)
  return [...columns.values()]
}
export function legacyMetricValues(points: ResultMetric[]): Record<string, number> {
  const values: Record<string, number> = {}
  // Only preserve unambiguous names for readers of the old export format.
  for (const point of points) if (points.filter(other => other.name === point.name).length === 1) values[point.name] = point.value
  return values
}
export function resultConfigurationWarnings(config: ResultCollectionConfig, members: (ParameterVariant & {outputDirectory?:string})[]): string[] {
  if (members.length < 2) return []
  const isolated=members.every(member=>!!member.outputDirectory)&&new Set(members.map(member=>member.outputDirectory)).size===members.length
  return [config.metricsFile, ...(config.resultFiles??[]), ...config.artifacts].filter(path => path && !path.includes('{runId}') && !path.includes('{runDir}')&&(!isolated||path.startsWith('/')))
    .map(path => `结果路径 ${path} 在本批配置间相同，可能被覆盖；请采用独立运行路径或在指标文件声明 runId。`)
}