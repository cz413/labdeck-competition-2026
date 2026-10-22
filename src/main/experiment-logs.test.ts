import { describe, expect, it, vi } from 'vitest'
import type { ExperimentRun, ExperimentTask, ServerProfile } from '../shared/types'
import { readExperimentRunLog } from './experiment-logs'

function fixture(output = 'ok\n  loss: 0.25\n\n') {
  const run = { id: 'run', number: 1, status: 'running', serverId: 'run-server', accessRouteId: 'jump', logPath: "/home/user/a'b $(touch nope)/stdout.log" } as ExperimentRun
  const task = { id: 'task', serverId: 'edited-server', runs: [run] } as ExperimentTask
  const server = { id: 'run-server', mode: 'real', host: 'internal', port: 22, username: 'user', authType: 'password', jumpHost: { host: 'gateway', port: 22, username: 'jump', authType: 'password' } } as ServerProfile
  const store = { listExperimentTasks: () => [task], getServer: vi.fn(() => server), getSecrets: vi.fn(() => ({})) }
  const ssh = { runCommand: vi.fn(async () => output) }
  const read = () => readExperimentRunLog(store as never, ssh as never, 'task', 'run')
  return { run, server, store, ssh, read }
}

describe('experiment run logs', () => {
  it('uses the run server/route snapshot and quotes the stored log path, preserving whitespace', async () => {
    const { read, store, ssh } = fixture()
    expect(await read()).toMatchObject({ text: '  loss: 0.25\n\n', missing: false, truncated: false })
    expect(store.getServer).toHaveBeenCalledWith('run-server')
    const [profile, , command, timeout] = ssh.runCommand.mock.calls[0] as unknown as [ServerProfile, unknown, string, number]
    expect(profile.jumpHost?.host).toBe('gateway')
    expect(command).toContain("log_file='/home/user/a'\\''b $(touch nope)/stdout.log'")
    expect(command).toContain('tail -c 65537 -- "$log_file"')
    expect(timeout).toBe(10_000)
  })
  it('distinguishes a missing file from a readable empty log', async () => {
    expect(await fixture('missing\n').read()).toMatchObject({ missing: true, text: '' })
    expect(await fixture('ok\n').read()).toMatchObject({ missing: false, text: '' })
  })
  it('retains only the latest 300 lines with or without a trailing newline', async () => {
    const lines = Array.from({ length: 500 }, (_, index) => `epoch ${index}`).join('\n')
    for (const suffix of ['', '\n']) {
      const result = await fixture(`ok\n${lines}${suffix}`).read()
      expect(result.truncated).toBe(true)
      expect(result.text).toBe(lines.split('\n').slice(-300).join('\n') + suffix)
    }
  })
  it('bounds a very long single line and drops an initial partial UTF-8 line', async () => {
    const result = await fixture('ok\n' + 'x'.repeat(65537)).read()
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(65536)
    expect(await fixture('ok\n�' + 'x'.repeat(65535) + '\n训练中\n').read()).toMatchObject({ text: '训练中\n', truncated: true })
  })
  it('rejects unknown records, missing paths and removed routes before connecting', async () => {
    const { read, run, ssh } = fixture()
    run.id = 'other'
    await expect(read()).rejects.toThrow('不存在')
    run.id = 'run'; run.logPath = undefined
    await expect(read()).rejects.toThrow('日志路径')
    run.logPath = '/log'; run.accessRouteId = 'removed'
    await expect(read()).rejects.toThrow('连接路径已不存在')
    expect(ssh.runCommand).not.toHaveBeenCalled()
  })
  it('propagates read/connection errors for retry and also reads completed runs', async () => {
    const { read, run, ssh } = fixture()
    run.status = 'completed'
    expect((await read()).text).toContain('loss')
    ssh.runCommand.mockRejectedValueOnce(new Error('SSH 连接已关闭'))
    await expect(read()).rejects.toThrow('SSH 连接已关闭')
  })
})
