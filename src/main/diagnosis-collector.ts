import { randomUUID } from 'node:crypto'
import type { DiagnosisInput, DiagnosisReport } from '../shared/intelligence'
import type { ExperimentTask, ExperimentRun } from '../shared/types'
import { diagnosticSamples, logEvidence, redactSecrets } from '../shared/diagnosis-engine'
import { applyAccessRoute, getAccessRoutes, getDefaultAccessRouteId } from '../shared/access-routes'
import { collectExternalLog } from './external-diagnosis'
import { selectDiagnosticLog } from './log-selection'
import type { AppStore } from './store'
import type { SshService } from './ssh-service'
import type { MonitorService } from './monitor-service'
import type { CondaService } from './conda-service'
const quote = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`

/** Reads bounded, read-only evidence. Does not call models, persist reports or start runs. */
export class DiagnosisCollector {
  constructor(private readonly store: AppStore, private readonly ssh: SshService,
    private readonly monitor: MonitorService, private readonly conda: CondaService,
    private readonly findRun:(taskId:string,runId?:string)=>{task:ExperimentTask;run:ExperimentRun}) {}
  async collect(input: DiagnosisInput, signal?: AbortSignal): Promise<Omit<DiagnosisReport, 'id' | 'createdAt' | 'engine' | 'findings'>> {
    let raw = input.logText ?? (input.sample ? diagnosticSamples[input.sample] : '')
    const report: Omit<DiagnosisReport, 'id' | 'createdAt' | 'engine' | 'findings'> = { title: input.sample ? '示例日志诊断' : '粘贴日志诊断', source: input.sample ? 'sample' : 'pasted', logExcerpt:'', evidence:[], warnings:[] }
    if(input.external){
      const collected=await collectExternalLog(this.store,this.ssh,input.external,signal)
      raw=collected.text
      const context={...collected.context,launchCommand:redactSecrets(collected.context.launchCommand)}
      Object.assign(report,{title:`${collected.serverName} · 手动实验日志`,source:'external',externalContext:context,externalLog:collected.snapshot})
      report.evidence.push({id:'external-runtime',source:'runtime',label:'用户提供的手动实验上下文（未核验进程状态）',text:redactSecrets(JSON.stringify({...context,processStatus:'unknown',server:collected.serverName}))})
      report.evidence.push({id:'external-log-file',source:'runtime',label:'实际读取的服务器日志文件',text:JSON.stringify({...collected.snapshot,path:context.logPath})})
      report.warnings.push('本报告来自已有日志；原命令、工作目录和环境由用户填写，不能据此确认进程已退出或日志属于哪次运行。没有创建任务或执行原命令。')
      if(collected.snapshot.truncated)report.warnings.push('在最多 256 KiB 的文件开头/末尾范围中选取错误上下文与末尾状态；结果最多 240 行 / 64 KiB，省略处不表示原日志连续。')
      if(collected.snapshot.changed)report.warnings.push('读取期间日志发生变化，片段可能来自仍在写入的进程。')
    }
    if (input.taskId) {
      const {task, run} = this.findRun(input.taskId, input.runId)
      Object.assign(report, {title: `${task.title} · 第 ${run.number} 次运行`, source:'remote', taskId:task.id, runId:run.id})
      report.evidence.push({id:'runtime',source:'runtime',label:'运行记录',text:redactSecrets(JSON.stringify({status:run.status,message:run.message,command:run.launchCommand,codePath:run.codePath,server:run.serverNameSnapshot,startedAt:run.startedAt,finishedAt:run.finishedAt}))})
      const serverId = run.serverId ?? task.serverId
      if (!serverId) throw new Error('运行记录缺少服务器')
      const server = this.store.getServer(serverId)
      if (server.mode !== 'real') throw new Error('演示节点不能采集真实日志；请使用示例日志入口')
      const routeId = run.accessRouteId ?? task.accessRouteId ?? getDefaultAccessRouteId(server)
      if (!getAccessRoutes(server).some(r => r.id === routeId)) throw new Error('这次运行的连接路径已不存在')
      const profile = applyAccessRoute(server, routeId)
      if (!profile.hostFingerprint || (profile.jumpHost && !profile.jumpHost.hostFingerprint)) throw new Error('请先在资源页核对并信任 SSH 主机指纹')
      const secrets = this.store.getSecrets(serverId)
      if (run.logPath) {
        if (!run.logPath.startsWith('/') || run.logPath.includes('\0')) throw new Error('运行日志路径无效')
        const connected = await this.ssh.connect(profile, secrets)
        const abort=()=>connected.client.end()
        signal?.addEventListener('abort',abort,{once:true})
        try {
          if(signal?.aborted)throw new Error('诊断已停止')
          const split=`__LABDECK_LOG_${randomUUID()}__`
          const scanned=await this.ssh.exec(connected.client,`if [ -f ${quote(run.logPath)} ]; then head -c 196608 -- ${quote(run.logPath)}; printf '\\n${split}\\n'; tail -c 65536 -- ${quote(run.logPath)}; else printf '日志文件不存在\\n'; fi`,15000)
          raw=selectDiagnosticLog(scanned.split(`\n${split}\n`).map((text,index)=>({text,label:index?'文件末尾最多 64 KiB':'文件开头最多 192 KiB'}))).text
        } catch { report.warnings.push('远程日志读取失败，请检查连接或粘贴日志重试') }
        finally { signal?.removeEventListener('abort',abort); connected.client.end() }
      } else report.warnings.push('这次运行没有记录日志路径')
      if(!input.useModel && !signal?.aborted) {
      try {
        const snapshot = await this.monitor.snapshot(profile,secrets)
        report.evidence.push({id:'resource',source:'resource',label:'检查时的资源快照',text:JSON.stringify({sampledAt:snapshot.sampledAt,status:snapshot.status,gpus:snapshot.gpus.map(g=>({index:g.index,name:g.name,freeMiB:g.memoryTotalMiB-g.memoryUsedMiB,utilization:g.utilizationPercent,temperature:g.temperatureC}))})})
        report.warnings.push('资源快照采集于本次检查，不能当作失败时的占用记录')
      } catch { report.warnings.push('资源快照未采集到；资源相关原因尚未验证') }
      const environment = run.condaEnvironment ?? task.condaEnvironment
      if (environment) {
        try {
          const result = await this.conda.checkEnvironment(profile,secrets,environment)
          report.evidence.push({id:'environment',source:'environment',label:'Conda 环境检查',text:JSON.stringify(result)})
          if (result.found) {
            const probe = 'import json,importlib.util; p=importlib.util.find_spec("torch"); t=__import__("torch") if p else None; print(json.dumps({"torch":getattr(t,"__version__",None),"cuda_build":getattr(getattr(t,"version",None),"cuda",None),"cuda_available":t.cuda.is_available() if t else False}))'
            const connected = await this.ssh.connect(profile,secrets)
            try {
              const info = await this.ssh.exec(connected.client,this.conda.buildEnvironmentRunCommand({...environment,managerPath:result.managerPath},`python -c ${quote(probe)}`),20_000)
              report.evidence.push({id:'torch',source:'environment',label:'PyTorch / CUDA 检查',text:redactSecrets(info).slice(0,6000)})
            } finally { connected.client.end() }
          }
        } catch { report.warnings.push('环境检查未完成，不能确定依赖或 CUDA 是否可用') }
      }
      }
    }
    const logs = logEvidence(raw)
    report.logExcerpt = logs.logExcerpt
    report.evidence = [...logs.evidence,...report.evidence]
    if (logs.clipped) report.warnings.push('日志仅保留最后 240 行 / 64 KiB；行号相对于显示的日志片段')
    if (report.source === 'remote') report.warnings.push('远程日志在有限的文件开头/末尾范围提取错误上下文；片段间可能不连续，未扫描区域仍可能有其他错误')
    if (!raw.trim()) report.warnings.push('没有可用日志，现有证据不足以判断失败原因')
    return report
  }
}
