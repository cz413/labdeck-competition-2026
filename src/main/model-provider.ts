import type { ModelUsage } from '../shared/model-usage'
import { z } from 'zod'
import type { ModelSettingsInput } from '../shared/intelligence'
import { redactSecrets } from '../shared/diagnosis-engine'

export const modelSettingsSchema = z.object({ enabled: z.boolean(), endpoint: z.string().max(2048), model: z.string().trim().max(160), apiKey: z.string().max(4096).optional(), clearApiKey: z.boolean().optional() })
export function validateEndpoint(endpoint: string): string {
  const url = new URL(endpoint.trim())
  if (url.username || url.password || url.search || url.hash) throw new Error('模型地址不能包含凭据、查询参数或片段')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('模型地址需要 HTTPS；本机服务可使用 HTTP')
  return url.toString().replace(/\/$/, '')
}
export function parseModelJson(text: string): unknown {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return JSON.parse(clean)
}
export interface ModelRequestOptions { purpose?: 'repository' }
export async function requestModel(settings: ModelSettingsInput, apiKey: string, system: string, payload: unknown, signal?: AbortSignal, onUsage?:(usage:ModelUsage)=>void, options:ModelRequestOptions={}): Promise<unknown> {
  if (!settings.enabled || !settings.model.trim()) throw new Error('请先启用并配置模型')
  const endpoint = validateEndpoint(settings.endpoint)
  const repository = options.purpose === 'repository'
  // Repository analysis sends whole files and is not capped by a local output budget.
  const maxTokens = repository ? undefined : 4096
  const timeout = repository ? 600_000 : 90_000
  const deepseek = new URL(endpoint).hostname === 'api.deepseek.com' && /^deepseek-(?:flash|chat|v4-(?:pro|flash)(?:-vision-exp)?)$/.test(settings.model.trim())
  const started = Date.now()
  let usage:Partial<ModelUsage> = {}
  const body = JSON.stringify({ model: settings.model.trim(), temperature: 0.1, ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...(deepseek ? { thinking: { type: 'disabled' }, response_format: { type: 'json_object' } } : {}),
    messages: [{ role: 'system', content: `${system}\n仅返回完整 JSON 对象，不输出 Markdown 围栏或对象外的解释。` }, { role: 'user', content: redactSecrets(JSON.stringify(payload)) }] })
  const bodyMegabytes = (Buffer.byteLength(body, 'utf8') / 1024 / 1024).toFixed(2)
  if (repository) console.log(`[model] 仓库分析请求体约 ${bodyMegabytes} MB`)
  try {
    let response: Awaited<ReturnType<typeof fetch>>
    try {
      response = await fetch(`${endpoint}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body
      })
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause
      const detail = cause?.code ?? cause?.message ?? ''
      throw new Error(`模型请求失败：${(error as Error).message}${detail ? `（${detail}）` : ''}；请求体约 ${bodyMegabytes} MB，请检查网络、代理、模型地址和服务端请求大小限制`)
    }
    if (!response.ok) throw new Error(repository && (response.status === 400 || response.status === 413 || response.status === 422)
      ? `模型服务拒绝了仓库分析请求（HTTP ${response.status}），可能超出模型上下文或输入过长；可减少阅读范围后重试`
      : `模型服务返回 HTTP ${response.status}；请检查地址、模型、额度与密钥`)
    const raw = await response.text()
    if (raw.length > 1_000_000) throw new Error('模型返回内容过大')
    const envelope = z.object({ usage:z.unknown().optional(), choices:z.array(z.object({ message:z.object({content:z.string().max(100_000).nullish()}), finish_reason:z.string().nullish() })).min(1) }).parse(JSON.parse(raw))
    const rawUsage = envelope.usage as Record<string,unknown>|undefined
    const count = (key:string):number|undefined => rawUsage && typeof rawUsage[key] === 'number' && Number.isFinite(rawUsage[key]) && (rawUsage[key] as number) >= 0 ? rawUsage[key] as number : undefined
    usage = {promptTokens:count('prompt_tokens'),completionTokens:count('completion_tokens'),totalTokens:count('total_tokens')}
    const choice = envelope.choices[0]
    if (choice.finish_reason === 'length') throw new Error(repository
      ? '模型输出被服务端截断（未设置本机输出上限，服务端仍限制了生成长度），没有生成完整方案。本次未自动重试。'
      : `模型输出被截断（本次上限 ${maxTokens} tokens），没有生成完整方案。本次未自动重试。`)
    if (choice.finish_reason === 'content_filter') throw new Error('模型服务未返回完整分析内容，未自动重试')
    if (!choice.message.content?.trim()) throw new Error('模型没有返回可用的 JSON 结果。本次未自动重试，请检查模型是否只返回了思考内容。')
    return parseModelJson(choice.message.content)
  } finally { onUsage?.({requests:1,elapsedMs:Date.now()-started,...usage}) }
}
