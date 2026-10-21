import { z } from 'zod'
import type { ParameterAxis, ParameterExpansion } from './research'
export const axisSchema = z.object({ flag: z.string().regex(/^--[a-zA-Z][a-zA-Z0-9_-]{0,47}$/), values: z.array(z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.,:/+-]+$/)).min(1).max(16) })
export const axesSchema = z.array(axisSchema).min(1).max(5).refine(axes => new Set(axes.map(a => a.flag)).size === axes.length, '参数名不能重复')
export function normalizeAxes(axes: ParameterAxis[]): ParameterAxis[] {
  return axesSchema.parse(axes).map(a => ({...a, values: [...new Set(a.values)]}))
}
export function tokenizeTrainingCommand(command: string): string[] {
  if (!/^python(?:3(?:\.\d+)?)?\s+[a-zA-Z0-9_./-]+\.py(?:\s|$)/.test(command.trim()) || /[\r\n;&|`$<>]/.test(command)) throw new Error('第一版仅支持单条 python 脚本命令，不支持 shell 组合命令')
  const tokens = command.trim().split(/\s+/)
  if (tokens.some(t => !/^[a-zA-Z0-9_.,:/+=-]+$/.test(t))) throw new Error('第一版参数展开不支持引号或空格值，请在任务中使用简单脚本参数')
  return tokens
}
export function parameterExperimentReason(command:string,launchMode?:string):string {
  if(launchMode==='script')return '参数对照目前仅支持单条 Python 脚本命令；脚本文件模式仍可作为普通任务运行。'
  try {tokenizeTrainingCommand(command);return ''} catch(error) {return error instanceof Error?error.message:'此启动方式暂不支持参数展开'}
}
export function expandParameters(command: string, rawAxes: ParameterAxis[], maxRuns: number): ParameterExpansion {
  const tokens = tokenizeTrainingCommand(command), axes = normalizeAxes(rawAxes)
  z.number().int().min(1).max(32).parse(maxRuns)
  const count = axes.reduce((n,a) => n * a.values.length,1)
  if (count > maxRuns) throw new Error(`参数组合共 ${count} 项，超过本次 ${maxRuns} 次运行预算；请缩小范围`)
  for (const axis of axes) {
    const occurrences = tokens.filter(t => t === axis.flag || t.startsWith(`${axis.flag}=`)).length
    if (occurrences > 1) throw new Error(`原命令中的 ${axis.flag} 重复，无法确定替换位置`)
    const i = tokens.indexOf(axis.flag)
    if (i >= 0 && (!tokens[i+1] || tokens[i+1].startsWith('--'))) throw new Error(`${axis.flag} 没有参数值，不能展开`)
  }
  let combinations: Record<string,string>[] = [{}]
  for (const axis of axes) combinations = combinations.flatMap(c => axis.values.map(v => ({...c,[axis.flag]:v})))
  const variants = combinations.map(parameters => {
    const next = [...tokens], changes: string[] = []
    for (const [flag,value] of Object.entries(parameters)) {
      const i = next.findIndex(t => t === flag || t.startsWith(`${flag}=`))
      if (i < 0) {next.push(flag,value);changes.push(`${flag}: 未指定 → ${value}`)}
      else if (next[i].includes('=')) {changes.push(`${flag}: ${next[i].slice(flag.length+1)} → ${value}`);next[i]=`${flag}=${value}`}
      else {changes.push(`${flag}: ${next[i+1]} → ${value}`);next[i+1]=value}
    }
    return {key: Object.entries(parameters).map(([f,v])=>`${f}=${v}`).join(';'),parameters,command:next.join(' '),changes}
  })
  const controlled = axes.filter(a => a.values.length > 1 && !/seed/i.test(a.flag))
  return {variants,engine:'typescript',version:'1',warnings:controlled.length>1?['本方案同时改变多个非随机种子参数，属于联合参数搜索；单项因果解释需要额外对照。']:[]}
}
export function parseMetricLog(log: string): Record<string,number> {
  const metrics: Record<string,number> = {}
  for (const line of log.split('\n')) {
    // Prefer explicit JSON metrics; pair matching supports common train/validation logs.
    try {
      const obj = JSON.parse(line)
      const source = obj.metrics ?? obj
      if (source && typeof source === 'object' && !Array.isArray(source)) for (const [key,value] of Object.entries(source)) if (typeof value==='number' && Number.isFinite(value) && /loss|acc|f1|precision|recall|auc|bleu|rouge|perplexity|rmse|mae|score/i.test(key) && Object.keys(metrics).length < 40) metrics[key.slice(0,80)]=value
    } catch { /* non-JSON log line */ }
    for (const m of line.matchAll(/\b((?:train[_/ .-]|val(?:idation)?[_/ .-]|test[_/ .-])?(?:loss|accuracy|acc|f1|precision|recall|auc|rmse|mae|score))\s*[:=]\s*([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?)(%?)/gi)) {
      const value=Number(m[2]);if(Number.isFinite(value))metrics[m[1].toLowerCase().replace(/[ ./-]/g,'_')+(m[3]?'_percent':'')]=value
    }
  }
  return metrics
}
