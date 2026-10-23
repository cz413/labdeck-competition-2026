import { useEffect, useMemo, useState } from 'react'
import { Activity, ArrowLeft, Bell, Cpu, Gauge, MemoryStick, Play, RefreshCw, SquareTerminal, Thermometer, UserRound, Zap } from 'lucide-react'
import type { GpuHistoryPoint, GpuHistoryRange, GpuMetric, GpuWatchTarget, ProcessWatch, ServerProfile, ServerSnapshot } from '@shared/types'
import { gpuLoadState } from '@shared/gpu-status'
import { formatGpuProcessMemory } from '@shared/gpu-memory'
import { getAccessRoute } from '@shared/access-routes'
import { GpuHistoryChart } from './GpuHistoryChart'
import { ProcessLogPanel } from './ProcessLogPanel'

interface GpuDetailPanelProps {
  server: ServerProfile
  snapshot?: ServerSnapshot
  initialGpuIndex: number
  watches: GpuWatchTarget[]
  onToggleWatch(gpuUuid: string): void
  onClose(): void
  accessRouteId?: string
  refreshing: boolean
  onRefresh(): void
  onTerminal(): void
  onRun(gpu: GpuMetric): void
  onSelectGpu(index: number): void
}

const percentage = (used: number, total: number): number => total > 0 ? used / total * 100 : 0
const status = (gpu: GpuMetric): { label: string; className: string } => {
  const state = gpuLoadState(gpu)
  return state === 'warning'
    ? { label: '温度告警', className: 'warning' }
    : state === 'busy'
      ? { label: '使用中', className: 'busy' }
      : { label: '空闲', className: 'idle' }
}
const formatDuration = (seconds: number | null | undefined): string => {
  if (seconds === null || seconds === undefined) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}天 ${hours}小时`
  if (hours > 0) return `${hours}小时 ${minutes}分`
  return `${Math.max(1, minutes)} 分钟`
}

export function GpuDetailPanel({ server, snapshot, initialGpuIndex, watches, onToggleWatch, onClose, accessRouteId, refreshing, onRefresh, onTerminal, onRun, onSelectGpu }: GpuDetailPanelProps): React.JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState(initialGpuIndex)
  const [historyRange, setHistoryRange] = useState<GpuHistoryRange>('6h')
  const [history, setHistory] = useState<GpuHistoryPoint[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [processWatches, setProcessWatches] = useState<ProcessWatch[]>([])
  const [watchingPid, setWatchingPid] = useState<number | null>(null)
  const [watchError, setWatchError] = useState('')
  const [logProcess, setLogProcess] = useState<{ pid: number; processName: string } | null>(null)
  const gpus = snapshot?.gpus ?? []
  const selected = useMemo(
    () => gpus.find((gpu) => gpu.index === selectedIndex) ?? gpus[0],
    [gpus, selectedIndex]
  )
  const serverWatched = watches.some((watch) => watch.serverId === server.id && !watch.gpuUuid)
  const selectedWatched = selected ? watches.some((watch) => watch.serverId === server.id && watch.gpuUuid === selected.uuid) : false
  const live = !!snapshot && !snapshot.cached && (snapshot.status === 'online' || snapshot.status === 'warning')
  const route = getAccessRoute(server, accessRouteId)

  useEffect(() => {
    let active = true
    const refresh = (): void => {
      void window.labApi.notifications.listProcessWatches()
        .then(items => { if (active) setProcessWatches(items) })
        .catch(error => { if (active) setWatchError(error instanceof Error ? error.message : '无法读取结束提醒') })
    }
    refresh()
    const unsubscribe = window.labApi.notifications.onProcessWatchesChanged(refresh)
    return () => { active = false; unsubscribe() }
  }, [])

  const toggleProcessWatch = async (pid: number, processName: string): Promise<void> => {
    setWatchingPid(pid)
    setWatchError('')
    try {
      const watch = processWatches.find(item => item.serverId === server.id && item.pid === pid && item.status !== 'ended')
      const items = watch
        ? await window.labApi.notifications.unwatchProcess(watch.id)
        : await window.labApi.notifications.watchProcess({ serverId: server.id, accessRouteId: route.id, pid, processName, gpuIndex: selected.index })
      setProcessWatches(items)
    } catch (error) {
      setWatchError(error instanceof Error ? error.message : '设置结束提醒失败')
    } finally {
      setWatchingPid(null)
    }
  }

  useEffect(() => { setSelectedIndex(initialGpuIndex) }, [server.id, initialGpuIndex])
  useEffect(() => { setLogProcess(null) }, [server.id, route.id, selectedIndex])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    if (!selected) return
    let active = true
    setHistoryLoading(true)
    setHistory([])
    setHistoryError('')
    void window.labApi.monitor.gpuHistory(server.id, selected.uuid, historyRange)
      .then((points) => { if (active) setHistory(points) })
      .catch((error: unknown) => { if (active) setHistoryError(error instanceof Error ? error.message : '读取历史失败') })
      .finally(() => { if (active) setHistoryLoading(false) })
    return () => { active = false }
  }, [server.id, selected?.uuid, historyRange, snapshot?.sampledAt])

  return <div className="wb-device-page">
    <div className="wb-device-workspace">
      <div className="wb-device-breadcrumb"><button className="wb-text-button" onClick={onClose} aria-label="返回 GPU 来源页面"><ArrowLeft size={14} />返回</button><span>{server.name} / GPU {selected?.index ?? initialGpuIndex}</span><time>{snapshot ? `${live ? '采集于' : '上次采集于'} ${new Date(snapshot.sampledAt).toLocaleTimeString('zh-CN')}` : '尚未采集'}</time></div>
      <header className="wb-device-header"><div><h1>{server.name} / GPU {selected?.index ?? initialGpuIndex}</h1><p>{route.username}@{route.host}:{route.port}</p></div><div><button className="secondary-button" onClick={onTerminal}><SquareTerminal size={14} />连接终端</button><button className="secondary-button" onClick={onRefresh} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'spin' : ''} />刷新设备</button>{selected && <button className="primary-button" disabled={server.mode !== 'real' || !live} onClick={() => onRun(selected)}><Play size={14} />在此 GPU 新建任务</button>}</div></header>
      {!live && <div className="wb-notice">{snapshot?.status === 'offline' ? `服务器离线：${snapshot.error ?? '检查 SSH 连接后刷新。'}` : '当前显示上次采集数据，请刷新后确认设备状态。'}</div>}

      {!selected ? <div className="gpu-empty"><Cpu size={38} /><strong>没有检测到 NVIDIA GPU</strong><span>请确认服务器已安装驱动并可执行 nvidia-smi。</span></div> : <div className="gpu-detail-layout">
        <aside className="gpu-selector">
          <div className="gpu-selector-title"><span>设备列表</span><b>{gpus.length} 卡</b></div>
          {gpus.map((gpu) => { const state = status(gpu); return <button key={gpu.uuid} className={gpu.index === selected.index ? 'active' : ''} onClick={() => { setSelectedIndex(gpu.index); onSelectGpu(gpu.index) }}>
            <div><strong>GPU {gpu.index}</strong><span>{gpu.name.replace('NVIDIA ', '')}</span></div>
            <i className={live ? state.className : 'cached'}>{live ? state.label : '待确认'}</i>
            <small>{Math.round(gpu.utilizationPercent)}% · {(gpu.memoryUsedMiB / 1024).toFixed(1)} / {(gpu.memoryTotalMiB / 1024).toFixed(1)} GiB</small>
          </button> })}
        </aside>

        <section className="gpu-detail-main">
          <div className="gpu-detail-heading">
            <div><span>GPU {selected.index}</span><h3>{selected.name}</h3><p>{selected.uuid}</p></div>
            <div className="gpu-detail-heading-actions">
              <button type="button" className={`gpu-watch-action ${selectedWatched || serverWatched ? 'active' : ''}`} disabled={serverWatched} onClick={() => onToggleWatch(selected.uuid)} title={serverWatched ? '已关注整台服务器' : selectedWatched ? '取消这块 GPU 的空闲提醒' : '这块 GPU 空闲时通知我'}><Bell size={15} />{serverWatched ? '已关注服务器' : selectedWatched ? '已关注' : '空闲时提醒'}</button>
              <div className={`gpu-state ${!live ? 'cached' : status(selected).className}`}><i />{!live ? '待确认' : status(selected).label}</div>
            </div>
          </div>

          <section className="gpu-stat-grid">
            <GpuStat icon={<Activity size={18} />} label="核心利用率" value={`${Math.round(selected.utilizationPercent)}%`} percent={selected.utilizationPercent} />
            <GpuStat icon={<MemoryStick size={18} />} label="显存" value={`${(selected.memoryUsedMiB / 1024).toFixed(1)} / ${(selected.memoryTotalMiB / 1024).toFixed(1)} GiB`} percent={percentage(selected.memoryUsedMiB, selected.memoryTotalMiB)} />
            <GpuStat icon={<Thermometer size={18} />} label="温度" value={`${Math.round(selected.temperatureC)}°C`} percent={selected.temperatureC} warn={selected.temperatureC >= 80} />
            <GpuStat icon={<Zap size={18} />} label="功耗" value={selected.powerW === null ? '—' : `${Math.round(selected.powerW)} / ${selected.powerLimitW ? Math.round(selected.powerLimitW) : '—'} W`} percent={selected.powerW && selected.powerLimitW ? percentage(selected.powerW, selected.powerLimitW) : 0} />
          </section>

          <section className="gpu-hardware-strip">
            <div><Gauge size={16} /><span>风扇</span><strong>{selected.fanPercent === null ? 'N/A' : `${Math.round(selected.fanPercent)}%`}</strong></div>
            <div><Cpu size={16} /><span>性能状态</span><strong>{selected.performanceState ?? 'N/A'}</strong></div>
            <div><MemoryStick size={16} /><span>空闲显存</span><strong>{((selected.memoryTotalMiB - selected.memoryUsedMiB) / 1024).toFixed(1)} GiB</strong></div>
          </section>

          {historyError && <p className="wb-notice error">{historyError}</p>}<GpuHistoryChart points={history} range={historyRange} loading={historyLoading} onRangeChange={setHistoryRange} />

          <section className="gpu-process-panel">
            <div className="gpu-process-title"><div><h3>{!live ? '上次采集进程' : '当前 GPU 进程'}</h3><p>可订阅进程结束的 Windows 通知；请保持应用运行或留在托盘</p></div><span>{selected.processes.length} 个进程</span></div>
            {watchError && <p className="wb-notice error" role="alert">{watchError}</p>}
            {selected.processMemoryInconsistent && <p className="wb-notice" role="status">本次进程显存与整卡读数不一致，自动重采样后仍未确认。进程信息保留，显存暂显示“待确认”；下一次采样会重新检查。</p>}
            {selected.processes.length ? <div className="gpu-process-table">
              <div className="gpu-process-head"><span>用户</span><span>PID</span><span>运行时长</span><span>进程</span><span>显存占用</span><span>日志 / 结束通知</span></div>
              {selected.processes.map((process) => {
                const watch = processWatches.find(item => item.serverId === server.id && item.pid === process.pid && item.status !== 'ended')
                return <div className="gpu-process-row" key={`${process.pid}-${process.processName}`}>
                <span className="gpu-user"><UserRound size={15} />{process.username}</span><code>{process.pid}</code><time>{formatDuration(process.elapsedSeconds)}</time><span title={process.processName}>{process.processName}</span><strong>{formatGpuProcessMemory(process, selected.processMemoryInconsistent)}</strong>
                <div className="gpu-process-actions"><button type="button" className="secondary-button gpu-log-action" disabled={!live || server.mode !== 'real'} onClick={() => setLogProcess({ pid: process.pid, processName: process.processName })}><SquareTerminal size={13} />实时日志</button><button type="button" className={`gpu-watch-action ${watch ? 'active' : ''}`} disabled={watchingPid !== null || (!watch && (!live || server.mode !== 'real'))} title={watch ? `${watch.message}；点击取消提醒` : '进程结束后通知，不代表任务运行成功；多进程任务请关注主进程'} onClick={() => void toggleProcessWatch(process.pid, process.processName)}><Bell size={13} />{watchingPid === process.pid ? '处理中…' : watch?.status === 'interrupted' ? '监控中断' : watch ? '已订阅' : '结束时提醒'}</button></div>
              </div>})}
            </div> : <div className="gpu-idle-state"><CheckIcon /><div><strong>{!live ? '上次采集时没有进程' : '未发现计算进程'}</strong><span>{!live ? '请刷新以确认当前状态。' : '提交任务前仍会检查显存和 GPU 负载。'}</span></div></div>}
          </section>
          {logProcess && <ProcessLogPanel key={`${server.id}:${route.id}:${logProcess.pid}`} serverId={server.id} accessRouteId={route.id} {...logProcess} onClose={() => setLogProcess(null)} />}
        </section>
      </div>}
    </div>
  </div>
}

function GpuStat({ icon, label, value, percent, warn }: { icon: React.ReactNode; label: string; value: string; percent: number; warn?: boolean }): React.JSX.Element {
  const level = warn || percent >= 90 ? 'critical' : percent >= 70 ? 'warning' : percent >= 40 ? 'active' : 'normal'
  return <div className={`gpu-stat load-${level}`}><div>{icon}<span>{label}</span></div><strong>{value}</strong><div className="gpu-stat-track"><i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div></div>
}

function CheckIcon(): React.JSX.Element {
  return <div className="gpu-idle-icon">✓</div>
}
