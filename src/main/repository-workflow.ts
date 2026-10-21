import { app } from 'electron'
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DiskCheckpointSaver } from './research-checkpointer'
import { repositoryReviewSchema } from './repository-review'
import { placeholder } from './repository-analysis'
import { redactSecrets } from '../shared/diagnosis-engine'
import type { AppStore } from './store'
import type { ExperimentTask } from '../shared/types'
import { isRepositoryLaunchCommand } from '../shared/repository-guide'
import type { RepositoryAnalysisInput, RepositoryGuide, RepositoryProgress, RepositoryReviewInput, RepositoryWorkflow, RepositoryWorkflowAction, RepositoryWorkflowView } from '../shared/repository-guide'
const state=Annotation.Root({flow:Annotation<RepositoryWorkflow>(),action:Annotation<RepositoryWorkflowAction|null>()})
const inputSchema=z.object({source:z.literal('remote'),serverId:z.string().uuid(),accessRouteId:z.string().max(80).optional(),path:z.string().min(1).max(4096),filePaths:z.array(z.string().max(512)).min(1),goal:z.string().trim().min(1).max(2000)})
const actionSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('review'),input:repositoryReviewSchema}),z.object({kind:z.literal('step'),index:z.number().int().min(0).max(3),confirmed:z.boolean()}),z.object({kind:z.literal('steps'),confirmed:z.boolean()}),z.object({kind:z.literal('save'),title:z.string().trim().min(1).max(160),force:z.boolean().optional()}),z.object({kind:z.literal('sync')}),z.object({kind:z.literal('retry')})
])
const timestamp=():string=>new Date().toISOString()
interface Operations {analyze(input:RepositoryAnalysisInput,progress?:(event:Omit<RepositoryProgress,'id'>)=>void,signal?:AbortSignal):Promise<RepositoryGuide>;recheck(guide:RepositoryGuide,input:RepositoryReviewInput):Promise<RepositoryGuide>}
export class RepositoryWorkflowService {
  private readonly directory:string
  private readonly saver:DiskCheckpointSaver
  private readonly graph:ReturnType<RepositoryWorkflowService['buildGraph']>
  private readyPromise?:Promise<void>
  private book:Record<string,{error?:string}>={}
  private writes:Promise<void>=Promise.resolve()
  private running=new Set<string>()
  private analyses=new Map<string,AbortController>()
  constructor(private readonly store:AppStore,private readonly operations:Operations,private readonly changed:()=>void=()=>{},directory?:string,private readonly onProgress?:(id:string,event:Omit<RepositoryProgress,'id'>)=>void){
    this.directory=directory??join(app.getPath('userData'),'repository-workflows')
    this.saver=new DiskCheckpointSaver(join(this.directory,'checkpoints.json'));this.graph=this.buildGraph()
  }
  private config(id:string){return {configurable:{thread_id:id},recursionLimit:20}}
  private event(flow:RepositoryWorkflow,message:string):RepositoryWorkflow {return {...flow,updatedAt:timestamp(),events:[...flow.events,{at:timestamp(),message}].slice(-40)}}
  private derive(flow:RepositoryWorkflow):RepositoryWorkflow {
    const task=flow.taskId?this.store.listExperimentTasks().find(t=>t.id===flow.taskId):undefined
    if(flow.taskId&&!task)return {...flow,phase:'task_missing'}
    const run=task?.runs.find(r=>r.id===flow.runId)??(!flow.runId?task?.runs.find(r=>r.number===1):undefined)
    if(!run&&task&&(!!flow.runId||task.runs.length>0))return {...flow,phase:'run_missing'}
    if(run){const phase=run.status==='queued'||run.status==='preparing'?'queued':run.status==='running'?'running':run.status==='paused'?'paused':run.status==='cancelled'?'cancelled':run.status==='completed'?'completed':'failed';return {...flow,runId:run.id,phase}}
    if(!flow.guide)return {...flow,phase:'analyzing'}
    if(flow.guide.status==='needs_info')return {...flow,phase:'needs_info'}
    if(task)return {...flow,phase:'draft'}
    const pending=flow.guide.steps.some((step,index)=>(step.role??'prepare')==='prepare'&&!flow.confirmedSteps.includes(index))
    return {...flow,phase:pending?'preparing':'ready'}
  }
  private buildGraph(){return new StateGraph(state)
    .addNode('read_and_analyze',async({flow})=>{
      if(flow.guide)return {flow}
      const controller=new AbortController();this.analyses.set(flow.id,controller)
      try {
        const guide=await this.operations.analyze(flow.input,event=>this.onProgress?.(flow.id,event),controller.signal)
        controller.signal.throwIfAborted()
        return {flow:this.event({...flow,guide},'已生成有文件依据的指南；后续补充和路径复检不再调用模型')}
      } finally {this.analyses.delete(flow.id)}
    })
    .addNode('assess',({flow})=>({flow:this.derive(flow)}))
    .addNode('await_action',({flow})=>({action:interrupt({kind:'repository-next-step',id:flow.id,phase:flow.phase}) as RepositoryWorkflowAction}))
    .addNode('apply_action',async({flow,action})=>{
      if(!action)throw new Error('缺少明确的流程操作')
      let next=flow
      if(action.kind==='review'){
        if(flow.taskId&&this.store.listExperimentTasks().some(t=>t.id===flow.taskId))throw new Error('任务已创建，请在任务池编辑或新建启动流程，避免配置与运行记录脱节')
        if(!flow.guide)throw new Error('先完成仓库分析')
        next=this.event({...flow,guide:await this.operations.recheck(flow.guide,action.input),resolutions:action.input.resolutions,confirmedSteps:[]},'用户补充启动配置，系统完成只读路径复检；未调用模型，准备确认已重置')
      }else if(action.kind==='step'){
        const step=flow.guide?.steps[action.index]
        if(!step||step.role==='launch')throw new Error('运行步骤由真实任务状态更新，不能手动标成成功')
        if(step.role==='observe'&&!['completed','failed','cancelled'].includes(this.derive(flow).phase))throw new Error('请先等待任务运行结束，再确认结果查看步骤')
        const confirmedSteps=flow.confirmedSteps.filter(index=>index!==action.index)
        if(action.confirmed)confirmedSteps.push(action.index)
        next=this.event({...flow,confirmedSteps},`用户${action.confirmed?'确认已完成':'撤销确认'}：${step.title}；属于用户确认，不代表系统验证`)
      }else if(action.kind==='steps'){
        const indices=(flow.guide?.steps??[]).map((step,index)=>({step,index})).filter(item=>(item.step.role??'prepare')==='prepare').map(item=>item.index)
        const confirmedSteps=action.confirmed?[...new Set([...flow.confirmedSteps,...indices])]:flow.confirmedSteps.filter(index=>!indices.includes(index))
        next=this.event({...flow,confirmedSteps},`用户${action.confirmed?'确认全部':'撤销全部'}准备步骤；属于用户确认，不代表系统验证`)
      }else if(action.kind==='save')next=await this.saveDraft(flow,action.title,action.force)
      else next=this.event(flow,'已同步任务池的实际运行状态，未发起新运行')
      return {flow:next,action:null}
    })
    .addEdge(START,'read_and_analyze').addEdge('read_and_analyze','assess').addEdge('assess','await_action').addEdge('await_action','apply_action').addEdge('apply_action','assess')
    .compile({checkpointer:this.saver})}
  private ready():Promise<void>{return this.readyPromise??=(async()=>{
    await mkdir(this.directory,{recursive:true});await this.saver.load()
    try {this.book=z.record(z.string().uuid(),z.object({error:z.string().optional()})).parse(JSON.parse(await readFile(join(this.directory,'index.json'),'utf8')))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('启动流程索引无法读取，请保留原文件检查')}
    let recovered=false
    for(const id of Object.keys(this.saver.storage))if(!this.book[id]&&z.string().uuid().safeParse(id).success){const current=await this.graph.getState(this.config(id));if(current.values.flow){this.book[id]={};recovered=true}}
    if(recovered)await this.persist()
  })()}
  private async persist():Promise<void>{
    const content=JSON.stringify(this.book),file=join(this.directory,'index.json')
    const job=this.writes.then(async()=>{
      const temporary=`${file}.${randomUUID()}.tmp`
      try {await writeFile(temporary,content,'utf8');await rename(temporary,file)}
      catch(error){
        const code=(error as NodeJS.ErrnoException).code
        if(code==='EPERM'||code==='EACCES')throw new Error(`无法写入启动流程数据目录：${this.directory}。当前用户可能没有写入权限，或应用运行在只读沙箱中；可用环境变量 LABDECK_DATA_DIR 指定工作区内可写目录后重启。`)
        throw error
      }
    })
    this.writes=job.catch(()=>{});await job
  }
  private async view(id:string):Promise<RepositoryWorkflowView>{
    if(!this.book[id])throw new Error('启动流程不存在')
    const current=await this.graph.getState(this.config(id))
    if(!current.values.flow)throw new Error('启动流程正在初始化，请稍后刷新')
    return {...this.derive(structuredClone(current.values.flow)),pending:[...current.next],busy:this.running.has(id),error:this.book[id].error}
  }
  cancel(id:string):void {
    z.string().uuid().parse(id)
    this.analyses.get(id)?.abort(new Error('已取消本次仓库分析；未创建任务或运行。'))
  }
  async list():Promise<RepositoryWorkflowView[]>{await this.ready();const result:RepositoryWorkflowView[]=[];for(const id of Object.keys(this.book)){try{result.push(await this.view(id))}catch(error){if(!this.running.has(id))throw error}}return result.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}
  private async execute(id:string,operation:()=>Promise<unknown>):Promise<RepositoryWorkflowView>{
    if(this.running.has(id))throw new Error('此流程正在处理，请稍后继续')
    this.running.add(id);this.book[id]={};await this.persist();this.changed()
    try {await operation()}catch(error){this.book[id].error=redactSecrets(error instanceof Error?error.message:String(error)).slice(0,1200)}
    finally {this.running.delete(id);await this.persist();this.changed()}
    return this.view(id)
  }
  async create(raw:RepositoryAnalysisInput,id=randomUUID()):Promise<RepositoryWorkflowView>{
    await this.ready();z.string().uuid().parse(id);const input=inputSchema.parse(raw)
    if(this.book[id])return this.view(id)
    if(Object.keys(this.book).length>=100)throw new Error('启动流程已达到 100 项，请先整理历史')
    this.book[id]={};const at=timestamp()
    return this.execute(id,()=>this.graph.invoke({flow:{id,input,createdAt:at,updatedAt:at,phase:'analyzing',confirmedSteps:[],resolutions:[],events:[]},action:null},this.config(id)))
  }
  async act(id:string,raw:RepositoryWorkflowAction):Promise<RepositoryWorkflowView>{
    await this.ready();z.string().uuid().parse(id);if(!this.book[id])throw new Error('启动流程不存在')
    const action=actionSchema.parse(raw),current=await this.graph.getState(this.config(id))
    if(current.next.includes('read_and_analyze')&&action.kind!=='retry')throw new Error('指南尚未生成。重试这一步可能再次调用模型，请明确点击重试')
    return this.execute(id,async()=>{
      if(current.next.includes('await_action'))return this.graph.invoke(new Command({resume:action}),this.config(id))
      if(current.next.includes('apply_action'))await this.graph.updateState(this.config(id),{action})
      return this.graph.invoke(null,this.config(id))
    })
  }
  private async saveDraft(flow:RepositoryWorkflow,title:string,force=false):Promise<RepositoryWorkflow>{
    const guide=flow.guide
    if(!guide)throw new Error('先完成仓库分析')
    if(guide.status!=='ready_for_review'&&!force)throw new Error('先补齐启动信息并完成路径核对')
    if(force&&(!guide.launchCommand||!isRepositoryLaunchCommand(guide.launchCommand)||placeholder(guide.launchCommand)||placeholder(guide.dataPath)))throw new Error('至少需要一条不含占位符的受支持启动命令才能保存草稿')
    if(force&&guide.checks.some(check=>check.expected==='file'&&check.status==='missing'))throw new Error('入口文件未找到，不能强制保存草稿')
    const marker=`[仓库流程:${flow.id}]`
    const old=this.store.listExperimentTasks().find(t=>t.id===flow.taskId||t.notes.includes(marker))
    if(old)return {...flow,taskId:old.id}
    if(guide.steps.some((step,index)=>(step.role??'prepare')==='prepare'&&!flow.confirmedSteps.includes(index)))throw new Error('请先逐项确认准备步骤；这属于用户确认，不代表系统验证')
    const server=this.store.getServer(flow.input.serverId)
    if(server.mode!=='real')throw new Error('原服务器不可用')
    const codePath=guide.snapshot.input.path.replace(/\/$/,'')+(guide.workingDirectory?'/'+guide.workingDirectory:'')||'/'
    const pending=force&&guide.missingInputs.length?[`待确认项：${guide.missingInputs.join('；')}`]:[]
    const notes=[marker,`目标：${flow.input.goal}`,guide.summary,`启动配置来源：${guide.launchOrigin==='user'?'用户补充':'模型建议，已审查'}`,`准备步骤由用户确认：${flow.confirmedSteps.join(',')}`,`补充答复：${flow.resolutions.map(r=>r.question+'：'+r.answer).join('；')}`,`文件依据：${guide.snapshot.excerpts.map(f=>f.path+':'+f.startLine).join('、')}`,...pending,...guide.warnings].join('\n').slice(0,8000)
    const task=await this.store.saveExperimentTask({title,project:'仓库复现实验',objective:flow.input.goal,tags:['仓库启动流程'],priority:'normal',status:'planned',serverId:server.id,accessRouteId:guide.snapshot.input.accessRouteId,codePath,dataPath:guide.dataPath,launchCommand:guide.launchCommand,launchMode:'command',scriptPath:'',condaEnvironment:guide.environmentName?{manager:'conda',environmentName:guide.environmentName}:undefined,artifactPath:'',resultSummary:'',notes})
    return this.event({...flow,taskId:task.id,runId:undefined},force?'已按强制保存创建任务草稿；待确认项已写入备注，请到任务池核对':'已创建任务草稿；请到任务池确认入队，尚未执行启动命令')
  }
}
