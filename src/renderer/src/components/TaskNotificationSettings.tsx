import { useEffect, useState } from 'react'
import { Bell, Trash2 } from 'lucide-react'
import type { AppSettings, ProcessWatch } from '@shared/types'

export function TaskNotificationSettings({ settings, onChange }: {
  settings: AppSettings
  onChange(settings: AppSettings): void
}): React.JSX.Element {
  const [watches, setWatches] = useState<ProcessWatch[]>([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    const refresh = (): void => {
      void window.labApi.notifications.listProcessWatches().then(items => { if (active) setWatches(items) })
        .catch(error => { if (active) { setError(true); setMessage(error instanceof Error ? error.message : '读取订阅失败') } })
    }
    refresh()
    const unsubscribe = window.labApi.notifications.onProcessWatchesChanged(refresh)
    return () => { active = false; unsubscribe() }
  }, [])
  const perform = async (action: () => Promise<unknown>, success: string): Promise<void> => {
    setBusy(true)
    setMessage('')
    setError(false)
    try { await action(); setMessage(success) }
    catch (error) { setError(true); setMessage(error instanceof Error ? error.message : '操作失败') }
    finally { setBusy(false) }
  }
  return <section className="panel task-notification-settings">
    <div className="panel-title"><div><h3>任务结束通知</h3><p>平台实验自动提醒；已有进程可在 GPU 详情中点击“结束时提醒”</p></div><Bell size={19} /></div>
    <label className="settings-field"><div><strong>Windows 系统通知</strong><span>成功、失败或取消时提醒；无退出码的进程显示“结果未知”。更改后点击下方“保存设置”。</span></div><button type="button" className={`toggle ${settings.notifyOnTaskEnd ? 'active' : ''}`} role="switch" aria-checked={settings.notifyOnTaskEnd} aria-label="任务结束 Windows 通知" onClick={() => onChange({ ...settings, notifyOnTaskEnd: !settings.notifyOnTaskEnd })}><i /></button></label>
    <div className="task-notification-actions"><span>每 20 秒检查订阅进程。留在托盘时继续监控，退出或休眠期间停止。</span><button type="button" className="secondary-button" disabled={busy} onClick={() => void perform(() => window.labApi.notifications.test(), '已请求测试通知；若未显示，请检查 Windows 通知设置或勿扰模式。')}><Bell size={14} />发送测试通知</button></div>
    {message && <p className={`wb-notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{message}</p>}
    {watches.length > 0 && <div className="process-watch-list">
      {watches.map(watch => <div className="process-watch-item" key={watch.id}>
        <div><strong>{watch.serverName} · PID {watch.pid} · {watch.processName}</strong><span>{watch.status === 'watching' ? '监控中' : watch.status === 'interrupted' ? '监控中断，等待重连' : '已结束，结果未知'} · {watch.message}</span><small>最近检查：{new Date(watch.checkedAt).toLocaleString('zh-CN')}</small></div>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void perform(async () => setWatches(await window.labApi.notifications.unwatchProcess(watch.id)), watch.status === 'ended' ? '已移除记录' : '已取消结束提醒')}><Trash2 size={13} />{watch.status === 'ended' ? '移除记录' : '取消提醒'}</button>
      </div>)}
    </div>}
  </section>
}
