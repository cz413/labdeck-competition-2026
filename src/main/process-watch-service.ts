import { randomUUID } from 'node:crypto'
import type { ProcessWatch, ProcessWatchInput, TaskFinishedEvent } from '../shared/types'
import { processWatchInputSchema } from '../shared/schemas'
import { applyAccessRoute, getDefaultAccessRouteId } from '../shared/access-routes'
import { AppStore } from './store'
import { SshService } from './ssh-service'

export interface ProcessIdentity {
  bootId: string
  startTicks: string
  state: string
}

// /proc/PID/stat's command name can contain spaces and closing parentheses.
export function parseProcessIdentity(raw: string): ProcessIdentity | null {
  const newline = raw.indexOf('\n')
  if (newline < 1) throw new Error('进程状态响应不完整')
  const bootId = raw.slice(0, newline).trim()
  const stat = raw.slice(newline + 1).trim()
  if (!bootId) throw new Error('无法确认服务器启动标识')
  if (stat === 'missing') return null
  const end = stat.lastIndexOf(')')
  const fields = stat.slice(end + 1).trim().split(/\s+/)
  if (end < 0 || !/^[A-Z]$/.test(fields[0]) || !/^\d+$/.test(fields[19] ?? '')) {
    throw new Error('进程状态暂不可读')
  }
  return { bootId, state: fields[0], startTicks: fields[19] }
}

export class ProcessWatchService {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private stopped = true

  constructor(
    private readonly store: AppStore,
    private readonly ssh: SshService,
    private readonly onFinished: (event: TaskFinishedEvent) => void,
    private readonly onChanged: () => void
  ) {}

  start(): void {
    this.stopped = false
    this.timer = setInterval(() => void this.poll(), 20_000)
    this.timer.unref()
    void this.poll()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  list(): ProcessWatch[] {
    return this.store.getSettings().processWatches
  }

  async watch(raw: ProcessWatchInput): Promise<ProcessWatch[]> {
    const input = processWatchInputSchema.parse(raw)
    const server = this.store.getServer(input.serverId)
    if (server.mode !== 'real') throw new Error('演示节点不支持进程结束提醒')
    const target = { ...input, accessRouteId: input.accessRouteId ?? getDefaultAccessRouteId(server) }
    const identity = await this.readIdentity(target)
    if (!identity || ['Z', 'X'].includes(identity.state)) throw new Error('该进程已经结束，请刷新 GPU 列表')
    const watches = this.list()
    if (watches.some(watch => watch.serverId === target.serverId && watch.pid === target.pid &&
      watch.bootId === identity.bootId && watch.startTicks === identity.startTicks && watch.status !== 'ended')) return watches
    const now = new Date().toISOString()
    watches.push({ ...target, id: randomUUID(), serverName: server.name,
      bootId: identity.bootId, startTicks: identity.startTicks,
      status: 'watching', createdAt: now, checkedAt: now, message: '每 20 秒检查进程；结束后发送 Windows 通知' })
    await this.store.saveSettings({ processWatches: watches })
    this.onChanged()
    return this.list()
  }

  async remove(id: string): Promise<ProcessWatch[]> {
    await this.store.saveSettings({ processWatches: this.list().filter(watch => watch.id !== id) })
    this.onChanged()
    return this.list()
  }

  async poll(): Promise<void> {
    if (this.stopped || this.busy) return
    this.busy = true
    try {
      for (const watch of this.list().filter(item => item.status !== 'ended')) {
        if (this.stopped) break
        try {
          const identity = await this.readIdentity(watch)
          if (this.stopped) break
          const ended = !identity || identity.bootId !== watch.bootId || identity.startTicks !== watch.startTicks || ['Z', 'X'].includes(identity.state)
          const message = ended ? '进程已结束，无法确认退出码和运行结果' : '进程仍在运行'
          if (await this.update(watch.id, ended ? 'ended' : 'watching', message) && ended) {
            this.onFinished({ serverId: watch.serverId, gpuIndex: watch.gpuIndex, accessRouteId: watch.accessRouteId,
              title: `${watch.processName} · PID ${watch.pid}`, serverName: watch.serverName,
              outcome: 'unknown', message })
          }
        } catch (error) {
          if (!this.stopped) await this.update(watch.id, 'interrupted', `监控中断：${error instanceof Error ? error.message : '无法连接服务器'}`)
        }
      }
    } catch (error) {
      console.warn('进程结束监控失败：', error)
    } finally {
      this.busy = false
    }
  }

  private async update(id: string, status: ProcessWatch['status'], message: string): Promise<boolean> {
    const watches = this.list()
    const watch = watches.find(item => item.id === id)
    // A removed subscription or a previously committed completion must never notify again.
    if (!watch || watch.status === 'ended') return false
    watch.status = status
    watch.checkedAt = new Date().toISOString()
    watch.message = message.slice(0, 2000)
    await this.store.saveSettings({ processWatches: watches })
    this.onChanged()
    return true
  }

  private async readIdentity(target: ProcessWatchInput): Promise<ProcessIdentity | null> {
    const server = this.store.getServer(target.serverId)
    if (server.mode !== 'real') throw new Error('仅支持真实服务器')
    const profile = applyAccessRoute(server, target.accessRouteId)
    const { client } = await this.ssh.connect(profile, this.store.getSecrets(server.id))
    try {
      const pid = processWatchInputSchema.shape.pid.parse(target.pid)
      const raw = await this.ssh.exec(client,
        `cat /proc/sys/kernel/random/boot_id || exit 1; if [ -r /proc/${pid}/stat ]; then cat /proc/${pid}/stat || exit 1; elif [ -d /proc/${pid} ]; then printf 'unreadable\\n'; else printf 'missing\\n'; fi`, 10_000)
      return parseProcessIdentity(raw)
    } finally {
      client.end()
    }
  }
}
