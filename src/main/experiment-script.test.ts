import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { experimentTaskDraftSchema, experimentRunStartInputSchema, experimentTaskSchema } from '../shared/schemas'
import { resolveExperimentLaunch } from '../shared/experiment-launch'
import type { ExperimentRun, ExperimentTask, ServerProfile } from '../shared/types'
vi.mock('electron', () => ({ app: { getPath: () => '.' }, safeStorage: {} }))
import { AppStore } from './store'
import { ExperimentScheduler } from './experiment-scheduler'

const serverId = '11111111-1111-4111-8111-111111111111'
const taskId = '22222222-2222-4222-8222-222222222222'
const server = { id: serverId, name: 'test', mode: 'real', host: 'test', port: 22, username: 'user', authType: 'password' } as ServerProfile
const draft = () => experimentTaskDraftSchema.parse({ title: '脚本实验', serverId, accessRouteId: 'direct', launchMode: 'script', scriptPath: '/home/user/my project/train.sh' })
const input = () => experimentRunStartInputSchema.parse({
  serverId, accessRouteId: 'direct', gpuUuid: null, gpuIndex: null, gpuNameSnapshot: null,
  codePath: '', dataPath: '', launchMode: 'script', scriptPath: draft().scriptPath,
  condaEnvironment: null, artifactPath: '', minimumFreeVramGiB: null, maximumGpuUtilizationPercent: null, notes: ''
})
function fixture() {
  const task = experimentTaskSchema.parse({ ...draft(), id: taskId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  const store = new AppStore()
  Object.assign(store, { data: { experimentTasks: [task], servers: [server] }, persist: vi.fn(async () => undefined), getSecrets: () => ({}) })
  return { store, task }
}

describe('script launch configuration', () => {
  it('uses the script directory, overrides stale commands and safely quotes shell metacharacters', () => {
    expect(resolveExperimentLaunch({ launchMode: 'script', scriptPath: "/home/user/a'b $(touch nope); x.sh", launchCommand: 'wrong command' }))
      .toEqual({ codePath: '/home/user', launchCommand: "bash -- '/home/user/a'\\''b $(touch nope); x.sh'" })
    expect(resolveExperimentLaunch({ launchMode: 'script', scriptPath: '/train.sh' }).codePath).toBe('/')
    expect(resolveExperimentLaunch({ launchMode: 'script', scriptPath: '/scripts/train.sh', codePath: '/project' }).codePath).toBe('/project')
  })
  it.each(['train.sh', '~/train.sh', '/train.py', '/train.sh\nextra.sh', '/bad\0.sh', ''])('rejects invalid script path %j', scriptPath => {
    expect(() => resolveExperimentLaunch({ launchMode: 'script', scriptPath })).toThrow('脚本')
  })
  it('keeps legacy command behavior', () => {
    expect(resolveExperimentLaunch({ codePath: '/project', launchCommand: 'python train.py' })).toEqual({ codePath: '/project', launchCommand: 'python train.py' })
    expect(() => resolveExperimentLaunch({ codePath: '/project' })).toThrow('启动命令')
  })
})

describe('script task persistence and queue', () => {
  it('queues with no command or code directory and preserves script snapshots across queued edits', async () => {
    const { store } = fixture()
    const queued = await store.startExperimentRun(taskId, input())
    expect(queued.runs[0]).toMatchObject({ launchMode: 'script', scriptPath: draft().scriptPath, codePath: '/home/user/my project', launchCommand: '', status: 'queued' })
    const edited = await store.saveExperimentTask({ ...draft(), id: taskId, scriptPath: '/new/train.sh' })
    expect(resolveExperimentLaunch(edited.runs[0]).codePath).toBe('/new')
    await store.updateExperimentRunState(taskId, queued.runs[0].id, { status: 'completed' })
    const later = await store.saveExperimentTask({ ...draft(), id: taskId, scriptPath: '/another/train.sh' })
    expect(later.runs[0].scriptPath).toBe('/new/train.sh')
  })
  it('persists CPU selection, ignores stale GPU constraints and updates existing device arguments', async () => {
    const { store } = fixture()
    await store.saveExperimentTask({ ...draft(), id: taskId, computeDevice: 'cpu' })
    const queued = await store.startExperimentRun(taskId, { ...input(), launchMode: 'command', codePath: '/project', launchCommand: 'python main.py --device=cuda', gpuUuid: 'stale-gpu', gpuIndex: 0, minimumFreeVramGiB: 20 })
    expect(queued.computeDevice).toBe('cpu')
    expect(queued.runs[0]).toMatchObject({ computeDevice: 'cpu', launchCommand: 'python main.py --device=cpu', gpuUuid: undefined, gpuIndex: undefined, minimumFreeVramGiB: null })
    expect(resolveExperimentLaunch({ computeDevice: 'cpu', codePath: '/project', launchCommand: 'python train.py' }).launchCommand).toBe('python train.py')
  })
  it('retains script mode after saving and reopening the settings file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'labdock-script-'))
    const filePath = join(directory, 'settings.json')
    try {
      const store = new AppStore()
      Object.assign(store, { filePath })
      await store.initialize()
      const saved = await store.saveExperimentTask({ ...draft(), serverId: undefined, accessRouteId: undefined })
      const reopened = new AppStore()
      Object.assign(reopened, { filePath })
      await reopened.initialize()
      expect(reopened.listExperimentTasks().find(task => task.id === saved.id)).toMatchObject({ launchMode: 'script', scriptPath: draft().scriptPath, launchCommand: '' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('remote script scheduling', () => {
  async function schedulerFixture(computeDevice: 'gpu' | 'cpu' = 'gpu') {
    const { store } = fixture()
    const task = await store.startExperimentRun(taskId, { ...input(), computeDevice })
    const exec = vi.fn(async (_client: unknown, command: string) => command.includes('base64 -d') ? '/home/user/runs/test\n123\n' : '')
    const ssh = { connect: vi.fn(async () => ({ client: { end: vi.fn() } })), exec }
    const monitor = { snapshot: vi.fn(async () => ({ status: 'online', gpus: [{ uuid: 'gpu', index: 0, name: 'GPU', memoryTotalMiB: 24576, memoryUsedMiB: 0, utilizationPercent: 0, temperatureC: 30, processes: [] }] })) }
    const conda = { checkEnvironment: vi.fn(async () => ({ found: true })), buildEnvironmentRunCommand: vi.fn((_config: unknown, command: string) => `conda run -n test bash -c ${JSON.stringify(command)}`) }
    const scheduler = new ExperimentScheduler(store, ssh as never, monitor as never, conda as never, () => undefined)
    const prepare = Reflect.get(scheduler, 'prepareAndLaunch').bind(scheduler) as (task: ExperimentTask, run: ExperimentRun) => Promise<boolean>
    return { store, task, exec, conda, monitor, prepare }
  }
  it('starts CPU jobs without querying GPUs and hides CUDA devices', async () => {
    const { task, store, exec, monitor, prepare } = await schedulerFixture('cpu')
    monitor.snapshot.mockRejectedValue(new Error('GPU monitoring unavailable'))
    expect(await prepare(task, task.runs[0])).toBe(true)
    expect(monitor.snapshot).not.toHaveBeenCalled()
    const command = exec.mock.calls.find(call => call[1].includes('base64 -d'))![1]
    const wrapper = Buffer.from(command.match(/printf '%s' '([^']+)' \| base64 -d/)![1], 'base64').toString('utf8')
    expect(wrapper).toContain("CUDA_VISIBLE_DEVICES=''")
    expect(store.listExperimentTasks()[0].runs[0]).toMatchObject({ computeDevice: 'cpu', status: 'running', gpuIndex: undefined, message: expect.stringContaining('CPU') })
  })
  it('keeps CPU jobs queued when the remote directory is unavailable', async () => {
    const { task, store, exec, monitor, prepare } = await schedulerFixture('cpu')
    exec.mockRejectedValueOnce(new Error('代码目录不存在'))
    expect(await prepare(task, task.runs[0])).toBe(false)
    expect(monitor.snapshot).not.toHaveBeenCalled()
    expect(store.listExperimentTasks()[0].runs[0]).toMatchObject({ status: 'queued', message: expect.stringContaining('代码目录不存在') })
  })
  it('checks the readable script, launches it and keeps GPU/log/exit tracking', async () => {
    const { task, store, exec, prepare } = await schedulerFixture()
    expect(await prepare(task, task.runs[0])).toBe(true)
    expect(exec.mock.calls[0][1]).toContain("[ -f '/home/user/my project/train.sh' ] && [ -r '/home/user/my project/train.sh' ]")
    const command = exec.mock.calls[1][1]
    const encoded = command.match(/printf '%s' '([^']+)' \| base64 -d/)![1]
    const wrapper = Buffer.from(encoded, 'base64').toString('utf8')
    expect(wrapper).toContain("cd -- '/home/user/my project'")
    expect(wrapper).toContain('bash --')
    expect(wrapper).toContain('train.sh')
    expect(wrapper).toContain("CUDA_VISIBLE_DEVICES='0'")
    expect(wrapper).toContain('exit-code')
    expect(wrapper).toContain('export PYTHONUNBUFFERED=1')
    expect(store.listExperimentTasks()[0].runs[0]).toMatchObject({ status: 'running', remotePid: 123, logPath: '/home/user/runs/test/stdout.log' })
  })
  it('keeps missing/unreadable scripts queued without launching a remote process', async () => {
    const { task, store, exec, prepare } = await schedulerFixture()
    exec.mockRejectedValueOnce(new Error('脚本不存在或不可读取'))
    expect(await prepare(task, task.runs[0])).toBe(false)
    expect(exec).toHaveBeenCalledTimes(1)
    expect(store.listExperimentTasks()[0].runs[0]).toMatchObject({ status: 'queued', message: expect.stringContaining('不可读取') })
  })
  it('runs scripts through the selected Conda environment', async () => {
    const { task, store, conda, prepare } = await schedulerFixture()
    task.runs[0].condaEnvironment = { manager: 'conda', environmentName: 'test' }
    await store.updateExperimentRunState(taskId, task.runs[0].id, { condaEnvironment: task.runs[0].condaEnvironment })
    expect(await prepare(task, task.runs[0])).toBe(true)
    expect(conda.buildEnvironmentRunCommand).toHaveBeenCalledWith(task.runs[0].condaEnvironment, "bash -- '/home/user/my project/train.sh'")
  })
  it('does not automatically dispatch a task using conflicting GPU memory data', async () => {
    const { task, store, monitor, exec, prepare } = await schedulerFixture()
    const sample = await monitor.snapshot()
    monitor.snapshot.mockResolvedValue({ ...sample, gpus: sample.gpus.map(gpu => ({ ...gpu, processMemoryInconsistent: true })) })
    expect(await prepare(task, task.runs[0])).toBe(false)
    expect(exec).not.toHaveBeenCalled()
    expect(store.listExperimentTasks()[0].runs[0].status).toBe('queued')
  })
})
