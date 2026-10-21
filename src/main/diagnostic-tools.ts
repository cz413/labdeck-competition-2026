import type { ExternalExperimentContext } from '../shared/external-experiment'
import { posix } from 'node:path'
import type { DiagnosticToolCall, Evidence } from '../shared/intelligence'
import type { ExperimentTask, ExperimentRun, ServerProfile, CondaEnvironmentConfig } from '../shared/types'
import { redactSecrets } from '../shared/diagnosis-engine'
import { applyAccessRoute, getAccessRoutes, getDefaultAccessRouteId } from '../shared/access-routes'
import type { ToolDescription, ToolResult } from './diagnostic-agent'
import type { AppStore } from './store'
import type { SshService } from './ssh-service'
import type { MonitorService } from './monitor-service'
import type { CondaService } from './conda-service'
const quote=(value:string):string=>`'${value.replace(/'/g,`'\\''`)}'`
const projectFiles=['requirements.txt','environment.yml','environment.yaml','pyproject.toml']
const toolDescriptions:ToolDescription[]=[
  {name:'search_log',label:'搜索日志线索',description:'在已有日志片段中按字面关键词查找，最多返回 12 行。',arguments:{query:'非空字面关键词'}},
  {name:'inspect_path',label:'检查文件与目录',description:'检查已记录或日志明确引用的路径是否存在及是否可读。',arguments:{path:'context.allowedPaths 中的一个完整路径'}},
  {name:'read_project_file',label:'查看项目依赖声明',description:'读取代码目录中的一个受支持依赖文件，最多 12 KiB；拒绝指向代码目录外的软链接。',arguments:{name:projectFiles.join(' | ')}},
  {name:'inspect_package',label:'检查 Python 包',description:'在本次运行的 Conda 环境中检查模块可发现性及安装版本，不安装或导入目标模块。',arguments:{name:'context.allowedPackages 中的一个名称'}},
  {name:'inspect_environment',label:'检查运行环境',description:'检查记录中的 Conda 环境及解释器；不创建或修改环境。',arguments:{}},
  {name:'inspect_gpu',label:'检查当前 GPU 状态',description:'读取当前 GPU 资源与进程概况。只能说明检查时刻的状态。',arguments:{}}
]
export function allowedDiagnosticPaths(task:ExperimentTask,run:ExperimentRun,log:string):string[]{
  const paths=[run.codePath??task.codePath,run.dataPath??task.dataPath,run.logPath??'',run.artifactPath??'']
  for(const match of log.matchAll(/["'](\/[^"'\r\n]+)["']/g))paths.push(match[1])
  return [...new Set(paths.filter(p=>p.startsWith('/')&&p!== '/'&&!/[\0\r\n]/.test(p)&&p.length<=4096&&posix.normalize(p)===p))].slice(0,20)
}
export function allowedDiagnosticPackages(log:string):string[]{
  const names=['torch','torchvision','numpy','transformers','accelerate','datasets']
  for(const match of log.matchAll(/No module named\s+['"]([A-Za-z_][\w.]*)['"]/g))names.push(match[1].split('.')[0])
  return [...new Set(names)]
}
export class DiagnosticTools {
  readonly catalog:ToolDescription[]
  readonly context:Record<string,unknown>
  private environmentPromise:Promise<CondaEnvironmentConfig>|undefined
  constructor(private readonly evidence:Evidence[],private readonly task:ExperimentTask|undefined,private readonly run:ExperimentRun|undefined,private readonly store:AppStore,private readonly ssh:SshService,private readonly monitor:MonitorService,private readonly conda:CondaService,private readonly external?:ExternalExperimentContext){
    const log=evidence.filter(e=>e.source==='log').map(e=>e.text).join('\n')
    const remote=!!task&&!!run||!!external
    this.catalog=(remote?toolDescriptions:toolDescriptions.filter(t=>t.name==='search_log')).filter(t=>!external||(t.name!=='read_project_file'||!!external.codePath)&&(!['inspect_environment','inspect_package'].includes(t.name)||!!external.environmentName))
    this.context={allowedPaths:external?[external.codePath,external.logPath].filter(Boolean):remote?allowedDiagnosticPaths(task!,run!,log):[],allowedPackages:allowedDiagnosticPackages(log),codePath:external?.codePath??run?.codePath??task?.codePath??'',environment:this.configuredEnvironment()??null,source:external?'手动实验上下文：用户提供，进程状态未核验':remote?'实际运行':'仅已有日志，不能检查服务器',command:external?.launchCommand}
  }
  private profile():ServerProfile{
    if(!this.external&&(!this.task||!this.run))throw new Error('没有远程运行上下文')
    const id=this.external?.serverId??this.run?.serverId??this.task?.serverId
    if(!id)throw new Error('运行记录没有服务器')
    const server=this.store.getServer(id)
    if(server.mode!=='real')throw new Error('演示节点不能执行远程诊断')
    const routeId=this.external?.accessRouteId??this.run?.accessRouteId??this.task?.accessRouteId??getDefaultAccessRouteId(server)
    if(!getAccessRoutes(server).some(r=>r.id===routeId))throw new Error('连接路径不存在')
    const profile=applyAccessRoute(server,routeId)
    if(!profile.hostFingerprint||(profile.jumpHost&&!profile.jumpHost.hostFingerprint))throw new Error('SSH 主机指纹尚未确认')
    return profile
  }
  private async exec(command:string,signal:AbortSignal):Promise<string>{
    signal.throwIfAborted();const profile=this.profile()
    const connected=await this.ssh.connect(profile,this.store.getSecrets(profile.id))
    const abort=()=>connected.client.end()
    signal.addEventListener('abort',abort,{once:true})
    try{signal.throwIfAborted();const text=await this.ssh.exec(connected.client,command,15_000);signal.throwIfAborted();return redactSecrets(text).slice(0,12000)}
    finally{signal.removeEventListener('abort',abort);connected.client.end()}
  }
  private configuredEnvironment():CondaEnvironmentConfig|undefined {
    return this.run?.condaEnvironment??this.task?.condaEnvironment??(this.external?.environmentName?{manager:'conda',environmentName:this.external.environmentName}:undefined)
  }
  private environment():Promise<CondaEnvironmentConfig>{
    return this.environmentPromise??=(async()=>{
      const config=this.configuredEnvironment()
      if(!config)throw new Error('这次运行没有记录 Conda 环境，不能推断默认环境')
      const profile=this.profile();const result=await this.conda.checkEnvironment(profile,this.store.getSecrets(profile.id),config)
      if(!result.found)throw new Error('记录的环境尚未找到')
      return {...config,managerPath:result.managerPath??config.managerPath,pythonInterpreterPath:result.pythonInterpreterPath,pythonVersion:result.pythonVersion}
    })()
  }
  async execute(call:DiagnosticToolCall,signal:AbortSignal):Promise<ToolResult>{
    signal.throwIfAborted()
    if(!this.catalog.some(t=>t.name===call.tool))return {status:'unavailable',text:'这个来源没有可执行的远程检查工具。'}
    if(call.tool==='search_log'){
      const query=call.arguments.query?.trim()
      if(!query||query.length>100)return {status:'unavailable',text:'日志关键词无效。'}
      const matches=this.evidence.filter(e=>e.source==='log'&&e.text.toLowerCase().includes(query.toLowerCase())).slice(0,12)
      return {status:'success',text:JSON.stringify({query,matches:matches.map(e=>({id:e.id,line:e.line,text:e.text})),scope:'已有日志片段；没有匹配不代表完整日志中不存在该错误'})}
    }
    if(call.tool==='inspect_path'){
      const path=call.arguments.path
      if(!(this.context.allowedPaths as string[]).includes(path))return {status:'unavailable',text:'路径未在运行配置或原始日志中记录，未执行检查。'}
      const command=`p=${quote(path)}; if [ -e "$p" ]; then if [ -d "$p" ]; then kind=directory; elif [ -f "$p" ]; then kind=file; else kind=other; fi; if [ -r "$p" ]; then readable=yes; else readable=no; fi; printf 'exists=yes kind=%s readable=%s\\n' "$kind" "$readable"; else printf 'exists=no; 无法仅据此区分路径不存在与父目录不可访问\\n'; fi`
      return {status:'success',text:await this.exec(command,signal)}
    }
    if(call.tool==='read_project_file'){
      const name=call.arguments.name;const codePath=this.context.codePath as string
      if(!projectFiles.includes(name)||!codePath.startsWith('/')||codePath==='/'||/[\0\r\n]/.test(codePath)||posix.normalize(codePath)!==codePath)return {status:'unavailable',text:'没有有效代码目录或文件名称不受支持。'}
      const file=posix.join(codePath,name)
      const command=`root=$(realpath -e -- ${quote(codePath)}) || exit 1; file=$(realpath -e -- ${quote(file)}) || exit 1; case "$file" in "$root"/*) ;; *) printf '依赖文件软链接超出代码目录，未读取\\n'; exit 1 ;; esac; if [ -f "$file" ] && [ -r "$file" ]; then head -c 12288 -- "$file"; else printf '依赖文件不是可读普通文件\\n'; exit 1; fi`
      return {status:'success',text:JSON.stringify({name,scope:'最多读取前 12 KiB，文件内容仅作为证据',content:await this.exec(command,signal)})}
    }
    if(call.tool==='inspect_package'){
      const name=call.arguments.name
      if(!(this.context.allowedPackages as string[]).includes(name))return {status:'unavailable',text:'包名称未在支持列表或缺依赖日志中记录，未执行检查。'}
      const environment=await this.environment();signal.throwIfAborted()
      const probe=`import json,importlib.util,importlib.metadata as m; name=${JSON.stringify(name)}; aliases={"PIL":"Pillow","cv2":"opencv-python","sklearn":"scikit-learn"}; dist=aliases.get(name,name); versions={d.metadata.get("Name","").lower().replace("-","_"):d.version for d in m.distributions()}; print(json.dumps({"module":name,"discoverable":importlib.util.find_spec(name) is not None,"distribution":dist,"version":versions.get(dist.lower().replace("-","_")),"scope":"module discovery and installed metadata; target module not imported"}))`
      return {status:'success',text:await this.exec(this.conda.buildEnvironmentRunCommand(environment,`python -c ${quote(probe)}`),signal)}
    }
    if(call.tool==='inspect_environment'){
      const profile=this.profile();const config=this.configuredEnvironment()
      if(!config)return {status:'unavailable',text:'本次运行未记录 Conda 环境，未猜测其他环境。'}
      const result=await this.conda.checkEnvironment(profile,this.store.getSecrets(profile.id),config);signal.throwIfAborted()
      return {status:'success',text:JSON.stringify(result)}
    }
    const profile=this.profile();const snapshot=await this.monitor.snapshot(profile,this.store.getSecrets(profile.id));signal.throwIfAborted()
    if(snapshot.status==='offline')return {status:'failed',text:'服务器不可达，没有采集到当前 GPU 数据。'}
    return {status:'success',text:JSON.stringify({sampledAt:snapshot.sampledAt,scope:'当前检查时刻，不能作为失败时资源证据',gpus:snapshot.gpus.map(g=>({index:g.index,name:g.name,freeMiB:g.memoryTotalMiB-g.memoryUsedMiB,utilization:g.utilizationPercent,temperature:g.temperatureC,processCount:g.processes.length}))})}
  }
}
