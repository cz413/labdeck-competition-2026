import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, ProcessWatch, ProcessWatchInput } from '../shared/types'
vi.mock('electron', () => ({ app: { getPath: () => '.' }, safeStorage: {} }))
import { AppStore } from './store'
import { SshService } from './ssh-service'
import { parseProcessIdentity, ProcessWatchService } from './process-watch-service'

const serverId = '11111111-1111-4111-8111-111111111111'
const input: ProcessWatchInput = { serverId, accessRouteId: 'direct', pid: 42, processName: 'python train.py', gpuIndex: 0 }
const stat = (start = '12345', state = 'S') => `boot-one\n42 (python worker) ${state} ${Array(18).fill('0').join(' ')} ${start} 0 0\n`
const subscription = (): ProcessWatch => ({ ...input, id: '22222222-2222-4222-8222-222222222222', serverName: 'gpu8', bootId: 'boot-one', startTicks: '12345', status: 'watching', createdAt: new Date().toISOString(), checkedAt: new Date().toISOString(), message: '' })

function fixture(watches: ProcessWatch[] = [subscription()]) {
  const store = new AppStore()
  let settings = { processWatches: structuredClone(watches) } as AppSettings
  const getSettings = vi.fn(() => structuredClone(settings))
  const saveSettings = vi.fn(async (patch: Partial<AppSettings>) => { settings = { ...settings, ...patch }; return structuredClone(settings) })
  Object.assign(store, { getSettings, saveSettings,
    getServer: () => ({ id: serverId, name: 'gpu8', mode: 'real', host: 'gpu8', port: 22, username: 'user', authType: 'password' }),
    getSecrets: () => ({}) })
  const end = vi.fn()
  const exec = vi.fn(async () => stat())
  const ssh = new SshService()
  Object.assign(ssh, { connect: vi.fn(async () => ({ client: { end } })), exec })
  const finished = vi.fn()
  const changed = vi.fn()
  const service = new ProcessWatchService(store, ssh, finished, changed)
  Object.assign(service, { stopped: false })
  return { service, store, exec, finished, changed, end }
}

describe('process identity parsing', () => {
  it('reads start time after a process name containing spaces and closing parentheses', () => {
    expect(parseProcessIdentity(stat().replace('(python worker)', '(python ) worker)'))).toEqual({ bootId: 'boot-one', state: 'S', startTicks: '12345' })
  })
  it('only accepts an explicit missing marker as absence', () => {
    expect(parseProcessIdentity('boot-one\nmissing\n')).toBeNull()
    for (const raw of ['', 'boot-one\nunreadable', 'boot-one\n', 'boot-one\n42 (python) S']) expect(() => parseProcessIdentity(raw)).toThrow()
  })
})

describe('local process completion monitoring', () => {
  it('keeps monitoring when a process stops using GPU memory but remains alive', async () => {
    const { service, finished, end } = fixture()
    await service.poll()
    expect(service.list()[0].status).toBe('watching')
    expect(finished).not.toHaveBeenCalled()
    expect(end).toHaveBeenCalledOnce()
  })
  it('marks SSH errors as interrupted and resumes without completion alerts', async () => {
    const { service, exec, finished } = fixture()
    exec.mockRejectedValueOnce(new Error('SSH disconnected'))
    await service.poll()
    expect(service.list()[0]).toMatchObject({ status: 'interrupted', message: '监控中断：SSH disconnected' })
    await service.poll()
    expect(service.list()[0].status).toBe('watching')
    expect(finished).not.toHaveBeenCalled()
  })
  it.each(['boot-one\nmissing\n', stat('99999'), stat().replace('boot-one', 'boot-two'), stat('12345', 'Z')])('notifies once for process exit, PID reuse, reboot or zombie: %s', async raw => {
    const { service, exec, finished, store } = fixture()
    exec.mockResolvedValue(raw)
    await service.poll()
    expect(service.list()[0].status).toBe('ended')
    expect(finished).toHaveBeenCalledOnce()
    expect(finished.mock.calls[0][0]).toMatchObject({ outcome: 'unknown', serverId, gpuIndex: 0 })
    await service.poll()
    expect(finished).toHaveBeenCalledOnce()
    const restarted = new ProcessWatchService(store, new SshService(), finished, vi.fn())
    Object.assign(restarted, { stopped: false })
    await restarted.poll()
    expect(finished).toHaveBeenCalledOnce()
  })
  it('does not notify after the user removes a subscription during an SSH read', async () => {
    const { service, exec, finished } = fixture()
    let resolve: (raw: string) => void = () => undefined
    exec.mockImplementationOnce(() => new Promise<string>(done => { resolve = done }))
    const polling = service.poll()
    await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce())
    await service.remove(subscription().id)
    resolve('boot-one\nmissing\n')
    await polling
    expect(service.list()).toEqual([])
    expect(finished).not.toHaveBeenCalled()
  })
  it('rejects invalid PIDs before making a remote connection and deduplicates multi-GPU subscriptions', async () => {
    const { service, exec } = fixture([])
    await expect(service.watch({ ...input, pid: -1 })).rejects.toThrow()
    expect(exec).not.toHaveBeenCalled()
    await service.watch(input)
    await service.watch({ ...input, gpuIndex: 1 })
    expect(service.list()).toHaveLength(1)
  })
})
