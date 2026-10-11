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
export async function requestModel(settings: ModelSettingsInput, apiKey: string, system: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
  if (!settings.enabled || !settings.model.trim()) throw new Error('请先启用并配置模型')
  const endpoint = validateEndpoint(settings.endpoint)
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000),
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model: settings.model.trim(), temperature: 0.1, max_tokens: 2200, messages: [{ role: 'system', content: system }, { role: 'user', content: redactSecrets(JSON.stringify(payload)) }] })
  })
  if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}；请检查地址、模型、额度与密钥`)
  const raw = await response.text()
  if (raw.length > 1_000_000) throw new Error('模型返回内容过大')
  const envelope = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().max(100_000) }) })).min(1) }).parse(JSON.parse(raw))
  return parseModelJson(envelope.choices[0].message.content)
}
