import type { ExperimentRunLog } from '../shared/types'

const MAX_BYTES = 64 * 1024
const MAX_LINES = 300
export const quoteLogPath = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export function buildLogReadCommand(path: string): string {
  return `log_file=${quoteLogPath(path)}; if [ ! -e "$log_file" ]; then printf 'missing\\n'; elif [ ! -f "$log_file" ] || [ ! -r "$log_file" ]; then printf '运行日志不是可读取的普通文件\\n' >&2; exit 1; else printf 'ok\\n'; tail -c ${MAX_BYTES + 1} -- "$log_file"; fi`
}

export function parseLogOutput(output: string): ExperimentRunLog {
  const fetchedAt = new Date().toISOString()
  if (output === 'missing\n') return { text: '', missing: true, truncated: false, fetchedAt }
  if (!output.startsWith('ok\n')) throw new Error('服务器返回的日志内容无效')
  let text = output.slice(3)
  let truncated = Buffer.byteLength(text, 'utf8') > MAX_BYTES
  if (truncated) {
    const newline = text.indexOf('\n')
    text = newline >= 0 ? text.slice(newline + 1) : Buffer.from(text).subarray(-MAX_BYTES).toString('utf8')
  }
  const lines = text.split('\n')
  const lineCount = lines.length - (text.endsWith('\n') ? 1 : 0)
  if (lineCount > MAX_LINES) {
    text = lines.slice(lineCount - MAX_LINES).join('\n')
    truncated = true
  }
  return { text, missing: false, truncated, fetchedAt }
}
