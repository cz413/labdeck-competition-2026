import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { applyAccessRoute, getAccessRoutes, getDefaultAccessRouteId } from '../shared/access-routes'
interface ExperimentRunLog { path:string; text:string; truncated:boolean; readAt:string }
import type { AppStore } from './store'
import type { SshService } from './ssh-service'
const quote=(value:string):string=>`'${value.replace(/'/g, `'\\''`)}'`

/** Reads the recorded run's output only; never executes the task or invokes a model. */
export async function readExperimentRunLog(store:AppStore,ssh:SshService,rawTaskId:string,rawRunId:string):Promise<ExperimentRunLog>{
  const taskId=z.string().uuid().parse(rawTaskId),runId=z.string().uuid().parse(rawRunId)
  const task=store.listExperimentTasks().find(task=>task.id===taskId),run=task?.runs.find(run=>run.id===runId)
  if(!task||!run)throw new Error('实验运行记录不存在或已删除')
  const path=run.logPath
  if(!path)throw new Error('这次运行未记录输出日志路径')
  if(!path.startsWith('/')||/[\0\r\n]/.test(path))throw new Error('运行日志路径无效')
  const serverId=run.serverId??task.serverId
  if(!serverId)throw new Error('这次运行未记录服务器')
  const server=store.getServer(serverId)
  if(server.mode!=='real')throw new Error('演示任务没有真实的服务器日志')
  const routeId=run.accessRouteId??task.accessRouteId??getDefaultAccessRouteId(server)
  if(!getAccessRoutes(server).some(route=>route.id===routeId))throw new Error('运行使用的连接路径已不存在')
  const profile=applyAccessRoute(server,routeId)
  if(!profile.hostFingerprint||(profile.jumpHost&&!profile.jumpHost.hostFingerprint))throw new Error('请先在资源页确认并信任 SSH 主机指纹')
  const connected=await ssh.connect(profile,store.getSecrets(serverId))
  try{
    const marker=`__LABDECK_OUTPUT_${randomUUID()}__`
    const command=`file=${quote(path)}; if [ -f "$file" ] && [ -r "$file" ]; then size=$(wc -c < "$file") || exit 1; printf '${marker}%s\\n' "$size"; tail -c 131072 -- "$file"; else printf '日志文件不存在或不可读取\\n' >&2; exit 1; fi`
    const output=await ssh.exec(connected.client,command,15000)
    const start=output.indexOf(marker),line=output.indexOf('\n',start)
    if(start<0||line<0)throw new Error('未能读取有效日志输出')
    const size=Number(output.slice(start+marker.length,line).trim())
    if(!Number.isFinite(size)||size<0)throw new Error('日志长度无效')
    let text=output.slice(line+1)
    if(size>131072){const newline=text.indexOf('\n');if(newline>=0)text=text.slice(newline+1)}
    text=text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r(?!\n)/g,'\n')
    return {path,text,truncated:size>131072,readAt:new Date().toISOString()}
  }finally{connected.client.end()}
}
