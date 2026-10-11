import { EventEmitter } from 'node:events'
import type { Client } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerProfile } from '../shared/types'
import { MonitorService } from './monitor-service'
import type { SshService } from './ssh-service'
import { nvidiaXml } from './test-fixtures/nvidia'

const services: MonitorService[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.closeAll()
})

function pooledMonitor() {
  const clients: Array<EventEmitter & { end: ReturnType<typeof vi.fn> }> = []
  const ssh = {
    connect: vi.fn(async () => {
      const client = Object.assign(new EventEmitter(), { end: vi.fn() })
      clients.push(client)
      return { client: client as unknown as Client, latencyMs: 1 }
    }),
    exec: vi.fn(async () => '__LAB_CPU__\ncpu 1 0 1 10\n')
  }
  const service = new MonitorService(ssh as unknown as SshService)
  services.push(service)
  const profile: ServerProfile = {
    id: 'server-1', name: 'GPU-01', host: '10.0.0.1', port: 22,
    username: 'researcher', authType: 'password', hostFingerprint: 'SHA256:trusted',
    tags: [], group: '测试', mode: 'real', monitorPolicy: 'background', hasSecret: true,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()
  }
  return { service, profile, ssh, clients }
}

describe('MonitorService connection reuse', () => {
  it('shares simultaneous snapshots and reuses the connection on later polls', async () => {
    const { service, profile, ssh } = pooledMonitor()
    const first = service.snapshot(profile, {})
    expect(service.snapshot(profile, {})).toBe(first)
    await first
    await service.snapshot(profile, {})
    expect(ssh.connect).toHaveBeenCalledOnce()
    expect(ssh.exec).toHaveBeenCalledTimes(2)
  })

  it('connects another server without waiting for a slow first server', async () => {
    const { service, profile, ssh } = pooledMonitor()
    let finish!: (raw: string) => void
    ssh.exec.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
    const first = service.snapshot(profile, {})
    const second = await service.snapshot({ ...profile, id: 'server-2', host: '10.0.0.2' }, {})
    expect(second.status).toBe('online')
    expect(ssh.connect).toHaveBeenCalledTimes(2)
    finish('__LAB_CPU__\ncpu 1 0 1 10\n')
    await first
  })

  it('reconnects once when a pooled connection closes during collection', async () => {
    const { service, profile, ssh, clients } = pooledMonitor()
    await service.snapshot(profile, {})
    ssh.exec.mockImplementationOnce(async () => {
      clients[0].emit('close')
      throw new Error('SSH 连接已关闭')
    })
    const snapshot = await service.snapshot(profile, {})
    expect(snapshot.status).toBe('online')
    expect(ssh.connect).toHaveBeenCalledTimes(2)
    expect(ssh.exec).toHaveBeenCalledTimes(3)
  })

  it('retires a timed out connection so the next poll can establish a fresh one', async () => {
    const { service, profile, ssh, clients } = pooledMonitor()
    await service.snapshot(profile, {})
    ssh.exec.mockRejectedValueOnce(new Error('远程命令执行超时'))
    expect((await service.snapshot(profile, {})).status).toBe('offline')
    expect(clients[0].end).toHaveBeenCalledOnce()
    expect(ssh.connect).toHaveBeenCalledOnce()
    expect((await service.snapshot(profile, {})).status).toBe('online')
    expect(ssh.connect).toHaveBeenCalledTimes(2)
  })
})

describe('MonitorService GPU memory sampling', () => {
  const rawSample = (used: number, processes: string[]) => `__LAB_CPU__\ncpu 1 0 1 10\n__LAB_GPUXML__\n${nvidiaXml(used, processes)}\n__LAB_GPUMETADATA__\n42 chen 7322\n43 li 99\n`

  it('queries card and processes in one NVIDIA call and does not retry a consistent sample', async () => {
    const { service, profile, ssh } = pooledMonitor()
    ssh.exec.mockResolvedValueOnce(rawSample(27034, ['1365', '25000']))
    const snapshot = await service.snapshot(profile, {})
    expect(snapshot.gpus[0].processMemoryInconsistent).toBeUndefined()
    expect(ssh.exec).toHaveBeenCalledOnce()
    const command = (ssh.exec.mock.calls[0] as unknown as [unknown, string])[1]
    expect(command.match(/nvidia-smi -q -x/g)).toHaveLength(1)
    expect(command).not.toContain('--query-compute-apps')
    expect(command).not.toContain('--query-gpu')
    expect(command).toContain('ps -eo pid=,user:32=,etimes=')
  })

  it('automatically replaces a transient conflict with one complete fresh sample', async () => {
    const { service, profile, ssh } = pooledMonitor()
    ssh.exec.mockResolvedValueOnce(rawSample(27034, ['1365', '31846'])).mockResolvedValueOnce(rawSample(33300, ['1365', '31846']))
    const snapshot = await service.snapshot(profile, {})
    expect(ssh.exec).toHaveBeenCalledTimes(2)
    expect(snapshot.gpus[0]).toMatchObject({ memoryUsedMiB: 33300, processes: [{ memoryUsedMiB: 1365 }, { memoryUsedMiB: 31846 }] })
    expect(snapshot.gpus[0].processMemoryInconsistent).toBeUndefined()
  })

  it('bounds retries and marks persistent conflicts, then recovers on a later poll', async () => {
    const { service, profile, ssh } = pooledMonitor()
    ssh.exec.mockResolvedValue(rawSample(27034, ['1365', '31846']))
    const snapshot = await service.snapshot(profile, {})
    expect(snapshot.status).toBe('online')
    expect(ssh.exec).toHaveBeenCalledTimes(2)
    expect(snapshot.gpus[0].processMemoryInconsistent).toBe(true)
    ssh.exec.mockResolvedValue(rawSample(33300, ['1365', '31846']))
    const next = await service.snapshot(profile, {})
    expect(ssh.exec).toHaveBeenCalledTimes(3)
    expect(next.gpus[0].processMemoryInconsistent).toBeUndefined()
  })

  it('preserves the first valid sample when the consistency retry fails', async () => {
    const { service, profile, ssh } = pooledMonitor()
    ssh.exec.mockResolvedValueOnce(rawSample(27034, ['1365', '31846'])).mockRejectedValueOnce(new Error('远程命令执行超时'))
    const snapshot = await service.snapshot(profile, {})
    expect(ssh.exec).toHaveBeenCalledTimes(2)
    expect(snapshot.status).toBe('online')
    expect(snapshot.gpus[0]).toMatchObject({ memoryUsedMiB: 27034, processMemoryInconsistent: true })
  })

  it('does not turn a failed NVIDIA query into a successful empty GPU sample', async () => {
    const { service, profile, ssh } = pooledMonitor()
    ssh.exec.mockRejectedValueOnce(new Error('Failed to initialize NVML'))
    const snapshot = await service.snapshot(profile, {})
    expect(snapshot).toMatchObject({ status: 'offline', error: 'Failed to initialize NVML' })
  })
})

describe('MonitorService demo GPU snapshot', () => {
  it('includes multiple GPUs, hardware details and process ownership', async () => {
    const profile: ServerProfile = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'GPU-01 · 演示节点',
      host: '10.20.0.21',
      port: 22,
      username: 'researcher',
      authType: 'password',
      tags: ['GPU'],
      group: '测试',
      mode: 'demo',
      monitorPolicy: 'background',
      hasSecret: false,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    }
    const service = new MonitorService({} as SshService)
    const snapshot = await service.snapshot(profile, {})

    expect(snapshot.gpus).toHaveLength(4)
    expect(snapshot.gpus[0].powerLimitW).toBe(450)
    expect(snapshot.gpus[0].processes[0]).toMatchObject({ username: 'chen' })
    expect(snapshot.gpus[0].processes[0].elapsedSeconds).toBeGreaterThan(0)
    expect(snapshot.gpus[3].processes).toHaveLength(0)
    expect(snapshot.gpus[3].performanceState).toBe('P8')
  })

  it('parses process elapsed time and keeps the process name aligned when elapsed time is unavailable', () => {
    const service = new MonitorService({} as SshService)
    const parse = (service as unknown as {
      parseGpuProcesses(raw: string): Map<string, Array<{ elapsedSeconds: number | null; processName: string }>>
    }).parseGpuProcesses.bind(service)
    const processes = parse([
      'GPU-1,42,chen,8192,7322,python train.py',
      'GPU-1,43,li,2048,,python inference.py'
    ].join('\n')).get('GPU-1')

    expect(processes?.[0]).toMatchObject({ elapsedSeconds: 7322, processName: 'python train.py' })
    expect(processes?.[1]).toMatchObject({ elapsedSeconds: null, processName: 'python inference.py' })
  })
})
