/** Format notices only. Keep the original error and raw logs for diagnostics. */
export function userFacingError(error: unknown, fallback = '操作未完成，请稍后重试。'): string {
  let text = (error instanceof Error ? error.message : typeof error === 'string' ? error : '').trim()
  text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/^Error invoking remote method\s+['"][^'"]+['"]:\s*/i, '')
    .replace(/^(?:Error|TypeError|RangeError):\s*/i, '').trim()
  if (!text) return fallback
  // Validation payloads and stacks are implementation details, not instructions.
  if (/"(?:code|expected|received|unrecognized_keys|invalid_type)"\s*:|\bat\s+\S+\s*\([^\n]+:\d+:\d+\)|Traceback \(most recent call last\)/.test(text)) return fallback
  if (/timed out while waiting for handshake|handshake (?:timed out|timeout)|握手.*超时/i.test(text)) return 'SSH 连接握手超时，请检查网络、SSH 端口及跳板机连接后重试。'
  if (/host key (?:verification failed|mismatch)|hostkey verification failed|remote host identification has changed|fingerprint mismatch/i.test(text)) return '服务器身份校验未通过，请在连接设置中核对 SSH 主机指纹。'
  if (/no matching (?:key exchange|host key|cipher)|handshake failed|key exchange failed/i.test(text)) return 'SSH 加密协商失败，请检查客户端与服务器的 SSH 配置是否兼容。'
  if (/all configured authentication methods failed|authentication failed|permission denied[ \(]+(?:publickey|password)|invalid private key|cannot parse privatekey/i.test(text)) return 'SSH 认证失败，请检查用户名、密码或私钥配置。'
  if (/connection (?:lost|closed|ended)|not connected|EPIPE|channel open failure|channel is not open|no response from server/i.test(text)) return '连接已中断，请检查网络和服务器状态后重新连接。'
  if (/EHOSTUNREACH|ENETUNREACH|no route to host|network is unreachable/i.test(text)) return '无法访问服务器，请检查网络、服务器地址及跳板机连接。'
  if (/environmentname(?:notfound|notfounderror)|environmentlocationnotfound|could not find conda environment|not a conda environment/i.test(text)) return '所选 Conda 环境不存在，请重新选择环境或检查安装路径。'
  if (/command not found|is not recognized as an internal or external command/i.test(text)) return '所需命令未找到，请检查运行环境及程序安装路径。'
  if (/timed? ?out|timeout|AbortError|request was aborted/i.test(text)) return '请求超时或已中断，请检查连接后重试。'
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
  if (/^(?:连接失败|连接错误|服务器离线|读取失败|操作失败|启动失败|错误|失败)[：:]\s*[A-Za-z][A-Za-z ,.'():_-]{12,}$/.test(text)) return fallback
  return text.slice(0, 350)
}
