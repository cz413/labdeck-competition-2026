import type { DiagnosisReport } from './intelligence'
import type { ExperimentTask, ExperimentRun, ServerProfile } from './types'
import { diagnosticSamples, diagnoseEvidence, logEvidence, proposeBatchRepair } from './diagnosis-engine'

// This module has no IPC, network or filesystem access. All demo data lives in one renderer session.
export interface DemoWorkflow { server: ServerProfile; task: ExperimentTask; reports: DiagnosisReport[]; logs: Record<string, string> }
const stamp = (): string => new Date().toISOString()
const id = (): string => crypto.randomUUID()
export function createDemoWorkflow(): DemoWorkflow {
  const now = stamp(), serverId = id()
  return {
    server: { id: serverId, name: '离线演示节点（模拟）', host: 'demo.invalid', port: 22, username: 'demo', authType: 'password', tags: ['模拟'], group: '演示', mode: 'demo', monitorPolicy: 'manual', hasSecret: false, createdAt: now, updatedAt: now },
    task: { id: id(), title: '【模拟】视觉训练 · 显存修复演示', project: '离线演示', objective: '使用预设配置展示任务、诊断、确认修复与结果验收。', tags: ['模拟数据'], priority: 'normal', status: 'planned', serverId, serverNameSnapshot: '离线演示节点（模拟）', codePath: '/workspace/vision', dataPath: '/datasets/flowers', launchCommand: 'python train.py --batch-size 32', launchMode: 'command', condaEnvironment: {manager: 'conda', environmentName: 'vision'}, minimumFreeVramGiB: 20, artifactPath: '/workspace/vision/runs/demo', resultSummary: '', notes: '预设演示计划；没有调用模型或连接服务器。', archived: false, createdAt: now, updatedAt: now, runs: [] },
    reports: [], logs: {}
  }
}
function addRun(state: DemoWorkflow, command: string, status: ExperimentRun['status']): ExperimentRun {
  return { id: id(), number: state.task.runs.length + 1, status, serverId: state.server.id, serverNameSnapshot: state.server.name, codePath: state.task.codePath, dataPath: state.task.dataPath, launchCommand: command, launchMode: 'command', condaEnvironment: state.task.condaEnvironment, minimumFreeVramGiB: state.task.minimumFreeVramGiB, maximumGpuUtilizationPercent: state.task.maximumGpuUtilizationPercent, artifactPath: state.task.artifactPath, queuedAt: stamp(), resultSummary: '', notes: '模拟运行：未执行任何命令。' }
}
export function failDemoInitial(state: DemoWorkflow): DemoWorkflow {
  if (state.task.runs.length) return state
  const next = structuredClone(state), run = addRun(next, next.task.launchCommand, 'failed')
  run.startedAt = stamp(); run.finishedAt = stamp(); run.message = '模拟 CUDA out of memory；退出码 1'
  next.task.runs.push(run); next.task.status = 'failed'; next.task.updatedAt = stamp()
  next.logs[run.id] = diagnosticSamples.oom
  return next
}
export function diagnoseDemoRun(state: DemoWorkflow, runId: string): { state: DemoWorkflow; report: DiagnosisReport } {
  const run = state.task.runs.find(r => r.id === runId)
  if (!run || run.status !== 'failed') throw new Error('演示诊断请选择模拟失败运行')
  const previous = state.reports.find(r => r.runId === runId)
  if (previous) return {state, report: previous}
  const {logExcerpt, evidence} = logEvidence(state.logs[runId] ?? '')
  const findings = diagnoseEvidence(evidence)
  const report: DiagnosisReport = { id: id(), createdAt: stamp(), title: `【模拟】${state.task.title.replace('【模拟】', '')} · 第 ${run.number} 次运行`, source: 'sample', engine: 'rules', useModel: false, taskId: state.task.id, runId, logExcerpt, evidence, findings, repair: proposeBatchRepair(run.launchCommand ?? '', findings.some(f => f.category === 'oom')), warnings: ['离线演示：日志和运行结果为模拟数据，没有连接服务器或调用模型。'], summary: '使用真实规则引擎分析预设错误日志；运行与验收结果由演示控制条模拟。' }
  return {state: {...state, reports: [report, ...state.reports]}, report}
}
export function retryDemoRun(state: DemoWorkflow, reportId: string): DemoWorkflow {
  const next = structuredClone(state), report = next.reports.find(r => r.id === reportId)
  if (!report?.repair || !next.task.runs.some(r => r.id === report.runId && r.status === 'failed')) throw new Error('模拟修复的来源运行不可用')
  if (report.retryRunId) return state
  if (next.task.runs.some(r => r.status === 'queued' || r.status === 'running')) throw new Error('已有模拟修复运行，请先完成本轮演示')
  const run = addRun(next, report.repair.after, 'queued')
  next.task.runs.push(run); next.task.status = 'queued'; next.task.updatedAt = stamp()
  report.retryRunId = run.id; report.closure = { enabled: true, status: 'waiting', message: '模拟排队；点击控制条“模拟修复开始”继续。', updatedAt: stamp(), attempts: 0 }
  return next
}
export function startDemoRetry(state: DemoWorkflow): DemoWorkflow {
  const next = structuredClone(state), run = next.task.runs.at(-1)
  if (!run || run.status !== 'queued') return state
  run.status = 'running'; run.startedAt = stamp(); run.message = '模拟训练进行中'
  next.task.status = 'running'; next.task.updatedAt = stamp()
  const report = next.reports.find(r => r.retryRunId === run.id)
  if (report?.closure) report.closure = {...report.closure, status: 'running', message: '模拟运行中；选择模拟成功或再次失败。', updatedAt: stamp()}
  return next
}
export function finishDemoRetry(state: DemoWorkflow, success: boolean): DemoWorkflow {
  let next = structuredClone(state)
  const run = next.task.runs.at(-1), report = next.reports.find(r => r.retryRunId === run?.id)
  if (!run || run.status !== 'running' || !report?.closure) return state
  run.status = success ? 'completed' : 'failed'; run.finishedAt = stamp()
  run.message = success ? '模拟正常退出；退出码 0' : '模拟再次显存不足；退出码 1'
  run.resultSummary = success ? '模拟进程验收通过，未验证真实指标与模型产物。' : '模拟修复失败，已生成新诊断。'
  next.task.status = run.status; next.task.updatedAt = stamp(); next.task.resultSummary = run.resultSummary
  report.closure = {enabled: false, status: success ? 'passed' : 'failed', message: run.resultSummary, updatedAt: stamp(), checkedAt: stamp(), exitCode: success ? 0 : 1, attempts: 1}
  report.evidence.push({id: `demo-exit-${run.number}`, source: 'runtime', label: '模拟退出码', text: `模拟运行 ${run.id} 的预设退出码：${success ? 0 : 1}。未读取远程服务器。`})
  if (!success) {
    next.logs[run.id] = diagnosticSamples.oom.replace('batch_size=32', `batch_size=${report.repair?.nextBatch}`)
    const diagnosed = diagnoseDemoRun(next, run.id)
    next = diagnosed.state
    next.reports.find(r => r.id === report.id)!.closure!.nextDiagnosisId = diagnosed.report.id
  }
  return next
}
