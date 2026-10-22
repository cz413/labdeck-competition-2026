import { applyAccessRoute, getAccessRoutes, getDefaultAccessRouteId } from '../shared/access-routes'
import type { ExperimentRunLog } from '../shared/types'
import type { AppStore } from './store'
import type { SshService } from './ssh-service'
import { buildLogReadCommand, parseLogOutput } from './remote-log'

export async function readExperimentRunLog(
  store: AppStore, ssh: SshService, taskId: string, runId: string
): Promise<ExperimentRunLog> {
  const task = store.listExperimentTasks().find((item) => item.id === taskId)
  const run = task?.runs.find((item) => item.id === runId)
  if (!task || !run) throw new Error('实验运行记录不存在')
  if (!run.logPath) throw new Error('本次运行没有可读取的日志路径')
  if (!run.logPath.startsWith('/') || run.logPath.includes('\0')) throw new Error('运行日志路径无效')
  const serverId = run.serverId ?? task.serverId
  if (!serverId) throw new Error('找不到运行任务对应的服务器')
  const server = store.getServer(serverId)
  if (server.mode !== 'real') throw new Error('实时日志需要真实服务器')
  const routeId = run.accessRouteId ?? getDefaultAccessRouteId(server)
  if (!getAccessRoutes(server).some((route) => route.id === routeId)) throw new Error('本次运行使用的 SSH 连接路径已不存在')
  const profile = applyAccessRoute(server, routeId)
  // Read only the persisted run path, with a fixed bound even for a single enormous line.
  const command = buildLogReadCommand(run.logPath)
  const output = await ssh.runCommand(profile, store.getSecrets(serverId), command, 10_000)
  return parseLogOutput(output)
}
