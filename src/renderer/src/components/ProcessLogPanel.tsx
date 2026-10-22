import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import type { ProcessLogInfo, ProcessLogTarget } from '@shared/types'
import { RemoteLogPanel } from './RemoteLogPanel'

function describeTarget(target: string): string {
  if (!target) return ''
  if (target.startsWith('pipe:[')) return '标准输出接在管道上（常见于用 tee 或启动脚本转发日志），日志文件由管道里的进程写入，不属于该进程。'
  if (target.startsWith('/dev/pts/') || target.startsWith('/dev/tty')) return '该进程的标准输出连接到终端。'
  if (target.startsWith('/dev/null')) return '该进程的标准输出被丢弃（/dev/null）。'
  return `标准输出：${target}。`
}

export function ProcessLogPanel({ serverId, accessRouteId, pid, processName, onClose, enabled = true }: ProcessLogTarget & {
  enabled?: boolean
  processName: string
  onClose(): void
}): React.JSX.Element {
  const [info, setInfo] = useState<ProcessLogInfo | null>(null)
  const [path, setPath] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    setBusy(true)
    setError('')
    void window.labApi.processLogs.inspect({ serverId, accessRouteId, pid }).then(next => {
      if (disposed) return
      setInfo(next)
      const detected = next.sources[0]?.path ?? ''
      setPath(current => current || detected)
      setDraft(current => current || detected)
    }).catch(reason => {
      if (!disposed) setError(reason instanceof Error ? reason.message : '无法识别进程日志')
    }).finally(() => { if (!disposed) setBusy(false) })
    return () => { disposed = true }
  }, [enabled, serverId, accessRouteId, pid, refresh])

  const readLog = useCallback(() => {
    if (!info) return Promise.reject(new Error('请先识别进程'))
    return window.labApi.processLogs.read({ serverId, accessRouteId, pid, bootId: info.bootId, startTicks: info.startTicks, logPath: path })
  }, [serverId, accessRouteId, pid, info?.bootId, info?.startTicks, path])

  return <section className="process-log-view" aria-label={`PID ${pid} 实时日志`}>
    <header className="process-log-heading"><div><strong>进程日志 · PID {pid}</strong><span title={processName}>{processName}</span></div><button type="button" className="icon-button small" aria-label="关闭进程日志" onClick={onClose}><X size={15} /></button></header>
    <div className="process-log-sources">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={13} className={busy ? 'spin' : ''} />{busy ? '识别中…' : '重新识别日志'}</button>
      {info?.sources.map(source => <button type="button" className={`secondary-button ${path === source.path ? 'active' : ''}`} key={source.path} title={source.path} onClick={() => { setPath(source.path); setDraft(source.path) }}>{source.label}</button>)}
    </div>
    {error && <p className="wb-notice error" role="status">{error}</p>}
    {info && !info.sources.length && <p className="process-log-help">{info.note ?? '没有识别到该进程打开的日志文件。'}{describeTarget(info.stdoutTarget)}{info.stderrTarget && info.stderrTarget !== info.stdoutTarget ? `错误输出：${info.stderrTarget}。` : ''}可填写任务自行写入的日志文件；仅输出到终端或管道且未保存的历史日志无法补读。</p>}
    {info && <form className="process-log-path" onSubmit={event => {
      event.preventDefault()
      const next = draft.trim()
      if (!next.startsWith('/') || /[\0\r\n]/.test(next)) { setError('请输入服务器上的绝对日志文件路径'); return }
      setError(''); setPath(next)
    }}><label><span>日志文件</span><input aria-label="进程日志文件路径" value={draft} onChange={event => setDraft(event.target.value)} placeholder={info.cwd ? `${info.cwd}/train.log` : '/home/user/project/train.log'} maxLength={4096} /></label><button type="submit" className="secondary-button">查看日志</button></form>}
    {info && path && <RemoteLogPanel enabled={enabled} key={`${info.bootId}:${info.startTicks}:${path}`} label={`PID ${pid} 日志内容`} logPath={path} running readLog={readLog} />}
  </section>
}
