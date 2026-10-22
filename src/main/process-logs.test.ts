import { describe, expect, it, vi } from 'vitest'
import type { ProcessLogReadInput, ServerProfile } from '../shared/types'
vi.mock('electron', () => ({ app: { getPath: () => '.' }, safeStorage: {} }))
import { inspectProcessLog, readProcessLog } from './process-logs'

const serverId = '11111111-1111-4111-8111-111111111111'
const target = { serverId, accessRouteId: 'jump', pid: 42 }
const input: ProcessLogReadInput = { ...target, bootId: 'boot-one', startTicks: '12345', logPath: "/home/user/a'b $(touch nope)/train.log" }
const encode = (value: string) => Buffer.from(value ? value + '\n' : '').toString('base64')
function inspection(stdout = '/logs/train.log', stderr = '/logs/train.log', stdoutKind = 'file', stderrKind = 'file') {
  return ['boot-one', `42 (python ) worker) S ${Array(18).fill('0').join(' ')} 12345 0 0`, encode(stdout), stdoutKind, encode(stderr), stderrKind, encode('/home/user/project'), ''].join('\n')
}
function fixture(output = inspection()) {
  const server = { id: serverId, mode: 'real', host: 'internal', port: 22, username: 'user', authType: 'password', jumpHost: { host: 'gateway', port: 22, username: 'jump', authType: 'password' } } as ServerProfile
  const store = { getServer: vi.fn(() => server), getSecrets: vi.fn(() => ({})) }
  const ssh = { runCommand: vi.fn(async (..._args: unknown[]) => output) }
  return { server, store, ssh, inspect: (raw = target) => inspectProcessLog(store as never, ssh as never, raw), read: (raw = input) => readProcessLog(store as never, ssh as never, raw) }
}

describe('external GPU process log discovery', () => {
  it('identifies the original process and deduplicates stdout/stderr file destinations', async () => {
    const { inspect, ssh } = fixture()
    expect(await inspect()).toEqual({ bootId: 'boot-one', startTicks: '12345', cwd: '/home/user/project', sources: [{ path: '/logs/train.log', label: '标准输出 / 错误输出' }], stdoutTarget: '/logs/train.log', stderrTarget: '/logs/train.log' })
    const [profile, , command] = ssh.runCommand.mock.calls[0] as [ServerProfile, unknown, string]
    expect(profile.jumpHost?.host).toBe('gateway')
    expect(command).toContain('readlink /proc/42/fd/$fd')
    expect(command).not.toMatch(/(?:cat|tail)[^;]*\/proc\/42\/fd/)
    expect(command).toContain('[ -f /proc/42/fd/$fd ]')
  })
  it('keeps distinct stdout and stderr files, including paths with spaces', async () => {
    const { inspect } = fixture(inspection('/logs/my train.log', '/logs/error.log'))
    expect((await inspect()).sources).toEqual([{ path: '/logs/my train.log', label: '标准输出' }, { path: '/logs/error.log', label: '错误输出' }])
  })
  it.each([
    ['/dev/pts/3', 'pipe:[123]', 'other', 'other'],
    ['/dev/null', 'socket:[321]', 'other', 'other'],
    ['/logs/removed.log (deleted)', '', 'file', 'other']
  ])('never treats a terminal, pipe, device or deleted log as a file source', async (stdout, stderr, kind1, kind2) => {
    expect((await fixture(inspection(stdout, stderr, kind1, kind2)).inspect()).sources).toEqual([])
  })
  it('rejects invalid PIDs and removed routes before making an SSH request', async () => {
    const { inspect, ssh } = fixture()
    await expect(inspect({ ...target, pid: -1 })).rejects.toThrow()
    await expect(inspect({ ...target, pid: '42; touch nope' as never })).rejects.toThrow()
    await expect(inspect({ ...target, accessRouteId: 'removed' })).rejects.toThrow('连接路径已不存在')
    expect(ssh.runCommand).not.toHaveBeenCalled()
  })
  it('reports inaccessible or malformed process state', async () => {
    await expect(fixture('boot-one\nmissing\n').inspect()).rejects.toThrow('进程已结束')
    await expect(fixture('boot-one\nunreadable\n').inspect()).rejects.toThrow('暂不可读')
  })
})

describe('external GPU process log reading', () => {
  it('checks the boot ID and start ticks and safely reads a bounded regular file', async () => {
    const { read, ssh } = fixture('1\nok\n  epoch 1\n')
    expect(await read()).toMatchObject({ text: '  epoch 1\n', processRunning: true, missing: false })
    const command = ssh.runCommand.mock.calls[0][2] as string
    expect(command).toContain('fields=${proc_stat##*) }')
    expect(command).toContain("awk '{print $1, $20}'")
    expect(command).toContain('"$boot_id" != \'boot-one\'')
    expect(command).toContain('"$start" != \'12345\'')
    expect(command).toContain("log_file='/home/user/a'\\''b $(touch nope)/train.log'")
    expect(command).toContain('tail -c 65537')
    expect(command).toContain('[ ! -f "$log_file" ]')
  })
  it('returns the final file snapshot and stops following an ended or reused PID', async () => {
    expect(await fixture('0\nok\nfinished\n').read()).toMatchObject({ text: 'finished\n', processRunning: false })
  })
  it('does not read another process log after a server restart or PID reuse', async () => {
    const { read, ssh } = fixture('replaced\n')
    expect(await read()).toMatchObject({ text: '', processRunning: false, processIdentityChanged: true })
    const command = ssh.runCommand.mock.calls[0][2] as string
    expect(command.indexOf('printf \'replaced\\n\'; exit 0')).toBeLessThan(command.indexOf('tail -c'))
  })
  it('reports a missing file and bounds large logs', async () => {
    expect(await fixture('1\nmissing\n').read()).toMatchObject({ missing: true, processRunning: true })
    const result = await fixture('1\nok\n' + 'epoch\n'.repeat(600)).read()
    expect(result.truncated).toBe(true)
    expect(result.text.split('\n')).toHaveLength(301)
  })
  it.each(['relative.log', '/logs/train\nother', '/logs/bad\0'])('rejects invalid manual paths', async logPath => {
    const { read, ssh } = fixture()
    await expect(read({ ...input, logPath })).rejects.toThrow()
    expect(ssh.runCommand).not.toHaveBeenCalled()
  })
  it('propagates connection and permission failures for retry', async () => {
    const { read, ssh } = fixture()
    ssh.runCommand.mockRejectedValueOnce(new Error('Permission denied'))
    await expect(read()).rejects.toThrow('Permission denied')
  })
})

describe('process log discovery beyond stdout/stderr', () => {
  const b64 = (value: string) => Buffer.from(value).toString('base64')
  const record = (pid: number, fd: number, path: string) => `fd\t${pid}\t${fd}\t${b64(path)}`
  function redirected(extra: string[]): string {
    return ['boot-one', '42 (python ) worker) S ' + Array(18).fill('0').join(' ') + ' 12345 0 0',
      b64('/dev/pts/1\n'), 'other', b64('pipe:[9]\n'), 'other', b64('/data/DataLACP/chenzhuo/code/MLLMSeg\n'), ...extra].join('\n')
  }
  it('finds the file a tee sibling or the trainer itself holds open', async () => {
    const log = '/data/DataLACP/chenzhuo/code/MLLMSeg/work_dirs/mllmseg_2b/training_log.txt'
    const { inspect, ssh } = fixture(redirected([
      '__LAB_EXTRA__', 'rights\tok',
      record(77, 3, log), record(42, 4, '/repo/data/train.bin'), record(42, 5, log), record(88, 1, '/repo/run_out')
    ]))
    expect((await inspect()).sources).toEqual([
      { path: log, label: 'training_log.txt' },
      { path: '/repo/run_out', label: 'run_out' }
    ])
    const command = ssh.runCommand.mock.calls[0][2] as string
    expect(command).toContain('__LAB_EXTRA__')
    expect(command).toContain('awk -v root=42')
    expect(command).not.toMatch(/(?:cat|tail)[^;]*\/fd\//)
  })
  it('keeps the stdout/stderr label when the same file is also seen on another descriptor', async () => {
    const output = [inspection('/repo/train.log', '/repo/train.log'), '__LAB_EXTRA__', 'rights\tok', record(42, 1, '/repo/train.log'), record(41, 3, '/repo/train.log')].join('\n')
    expect((await fixture(output).inspect()).sources).toEqual([{ path: '/repo/train.log', label: '标准输出 / 错误输出' }])
  })
  it('explains a denied /proc fd directory instead of silently detecting nothing', async () => {
    const info = await fixture(redirected(['__LAB_EXTRA__', 'rights\tdenied'])).inspect()
    expect(info.sources).toEqual([])
    expect(info.note ?? '').toContain('hidepid')
  })
})
