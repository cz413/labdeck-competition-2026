export function resolveStdoutLogPath(value:string|undefined,runId:string):string|undefined {
  const path=value?.trim()
  if(!path)return undefined
  if(!path.startsWith('/')||path.endsWith('/')||/[\0\r\n]/.test(path)||path.length>4096)throw new Error('运行日志请填写服务器上的绝对文件路径，留空使用默认位置。')
  if(/[{}]/.test(path.replaceAll('{runId}','')))throw new Error('运行日志路径只支持 {runId} 占位符。')
  return path.replaceAll('{runId}',runId)
}
