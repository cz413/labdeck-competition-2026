/** Format notices only. Keep the original error and raw logs for diagnostics. */
export function userFacingError(error: unknown, fallback = '操作未完成，请稍后重试。'): string {
  let text = (error instanceof Error ? error.message : typeof error === 'string' ? error : '').trim()
  text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/^Error invoking remote method\s+['"][^'"]+['"]:\s*/i, '')
    .replace(/^(?:Error|TypeError|RangeError):\s*/i, '').trim()
  if (!text) return fallback
  // Validation payloads and stacks are implementation details, not instructions.
  if (/"(?:code|expected|received|unrecognized_keys|invalid_type)"\s*:|\bat\s+\S+\s*\([^\n]+:\d+:\d+\)|Traceback \(most recent call last\)/.test(text)) return fallback
  if (/ENOENT|no such file or directory|FileNotFoundError/i.test(text)) return '文件或目录不存在，请检查所选路径。'
  if (/EACCES|EPERM|permission denied/i.test(text)) return '没有权限访问所选文件或目录，请检查访问权限。'
  if (/ENOSPC|no space left on device/i.test(text)) return '存储空间不足，请清理空间后重试。'
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|network error|socket hang up/i.test(text)) return '连接未成功，请检查网络和连接设置后重试。'
  if (/all configured authentication methods failed|authentication failed|(?:^|HTTP\s*|status\s*[:=]?\s*|API\s*[:：]?\s*)(?:401|403)\b/i.test(text)) return '认证或访问权限未通过，请检查连接凭据及相关设置。'
  if (/(?:^|HTTP\s*|status\s*[:=]?\s*|API\s*[:：]?\s*)429\b|rate limit|too many requests/i.test(text)) return '请求过于频繁，请稍后重试。'
  if (/(?:^|HTTP\s*|status\s*[:=]?\s*|API\s*[:：]?\s*)50[234]\b|service unavailable/i.test(text)) return '服务暂时不可用，请稍后重试。'
  if (/退出(?:状态)?码|exit[_-]?Code|exit(?:ed)?\s+(?:with\s+)?(?:code|status)|return\s*code/i.test(text)) {
    text = text.split(/(?<=[，,；;。\n])/).filter(part => !/退出(?:状态)?码|exit[_-]?Code|exit(?:ed)?\s+(?:with\s+)?(?:code|status)|return\s*code/i.test(part)).join('').replace(/^[，,；;。\s]+/, '').trim()
  }
  if (!/[\u4e00-\u9fff]/.test(text) || /ZodError|TypeError|SyntaxError|Unhandled|\bundefined\b|\bnull\b|\[object Object\]/.test(text)) return fallback
  return text.slice(0, 350)
}
