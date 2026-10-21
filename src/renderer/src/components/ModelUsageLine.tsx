import type { ModelUsage } from '@shared/model-usage'
export function ModelUsageLine({usage,reused=false}:{usage?:ModelUsage;reused?:boolean}):React.JSX.Element {
  return <p className="model-usage-line">{reused?'本次复用已有报告，新增模型请求 0 次。原分析：':''}{usage?`模型请求 ${usage.requests} 次 · 输入 ${usage.promptTokens??'未知'} / 输出 ${usage.completionTokens??'未知'} / 总计 ${usage.totalTokens??'未知'} tokens · ${(usage.elapsedMs/1000).toFixed(1)} 秒`:'服务未提供或未记录用量，不按 0 token 计。'}</p>
}
