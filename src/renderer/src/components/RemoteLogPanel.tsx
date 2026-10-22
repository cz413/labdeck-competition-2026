import { useEffect, useRef, useState } from 'react'
import { ChevronDown, LoaderCircle, Pause, Play, RotateCcw, SquareTerminal } from 'lucide-react'
import type { ExperimentRunLog } from '@shared/types'

type LogSnapshot = ExperimentRunLog & { processRunning?: boolean; processIdentityChanged?: boolean }

function readableLog(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function RemoteLogPanel({ label, logPath, running, readLog, enabled = true }: {
  enabled?: boolean
  label: string
  logPath?: string
  running: boolean
  readLog(): Promise<LogSnapshot>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const [paused, setPaused] = useState(false)
  const [following, setFollowing] = useState(true)
  const [visible, setVisible] = useState(!document.hidden)
  const [refresh, setRefresh] = useState(0)
  const manualRefresh = useRef(false)
  const processEnded = useRef(false)
  const [log, setLog] = useState<LogSnapshot | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const viewport = useRef<HTMLPreElement>(null)
  const active = running && log?.processRunning !== false

  useEffect(() => {
    const onVisibility = (): void => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    const requested = manualRefresh.current
    manualRefresh.current = false
    if (!enabled || !expanded || !visible || !logPath || (paused && !requested)) {
      setBusy(false)
      return
    }
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async (): Promise<void> => {
      setBusy(true)
      let keepReading = running && !processEnded.current
      try {
        const next = await readLog()
        keepReading = running && next.processRunning !== false
        if (!disposed) {
          if (next.processRunning === false) processEnded.current = true
          setLog(previous => next.processIdentityChanged && previous ? { ...previous, processRunning: false, processIdentityChanged: true } : next)
          setError('')
        }
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : '暂时无法读取远程日志')
      } finally {
        if (!disposed) {
          setBusy(false)
          if (keepReading && !paused) timer = setTimeout(() => void read(), 2000)
        }
      }
    }
    void read()
    return () => { disposed = true; if (timer) clearTimeout(timer) }
  }, [enabled, readLog, logPath, running, paused, expanded, visible, refresh])

  useEffect(() => {
    if (following && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [log?.text, following, expanded])

  return <section className="experiment-log-panel" aria-label={label}>
    <header className="experiment-log-toolbar">
      <button type="button" className="experiment-log-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <SquareTerminal size={14} /><strong>{active ? '实时日志' : '运行日志'}</strong><ChevronDown size={13} className={expanded ? 'expanded' : ''} />
      </button>
      {expanded && <div className="experiment-log-controls">
        <span className="experiment-log-state">{busy ? <><LoaderCircle size={12} className="spin" />读取中</> : active ? paused ? '已暂停刷新' : '每 2 秒刷新' : '运行已结束'}</span>
        {active && <button type="button" onClick={() => setPaused((value) => !value)}>{paused ? <Play size={12} /> : <Pause size={12} />}{paused ? '继续刷新' : '暂停刷新'}</button>}
        <label><input type="checkbox" checked={following} onChange={(event) => setFollowing(event.target.checked)} />跟随输出</label>
        <button type="button" disabled={busy || !logPath} onClick={() => { manualRefresh.current = true; setRefresh((value) => value + 1) }}><RotateCcw size={12} />刷新</button>
      </div>}
    </header>
    {expanded && <>
      {log?.processIdentityChanged && <div className="process-log-help" role="status">服务器已重启或 PID 已被其他进程复用，已停止刷新并保留原日志。</div>}
      {error && <div className="experiment-log-error" role="status">读取失败：{error}{active && !paused ? ' · 将自动重试' : ''}</div>}
      <pre className="experiment-log-output" ref={viewport} tabIndex={0} aria-label="日志内容" onScroll={(event) => {
        const element = event.currentTarget
        setFollowing(element.scrollHeight - element.clientHeight - element.scrollTop < 24)
      }}>{log?.text ? readableLog(log.text) : !logPath ? '本次运行没有日志路径，无法显示实时日志。' : error ? '暂时无法获取日志。' : log?.missing ? '等待远程日志文件生成…' : busy && !log ? '正在读取远程日志…' : '暂无输出，等待任务写入日志…'}</pre>
      <footer className="experiment-log-footer"><span title={logPath}>{logPath || '无日志路径'}</span><span>{log?.truncated ? '仅显示最近 300 行 / 64 KiB · ' : ''}{log ? `更新于 ${new Date(log.fetchedAt).toLocaleTimeString('zh-CN')}` : ''}</span></footer>
    </>}
  </section>
}
