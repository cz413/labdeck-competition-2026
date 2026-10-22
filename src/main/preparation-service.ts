import type { ModelUsage } from '../shared/model-usage'
import { sumModelUsage } from '../shared/model-usage'
import { projectConfigurationKey } from '../shared/project-task'
import { app } from 'electron'
import { Annotation, Command, START, StateGraph, interrupt } from '@langchain/langgraph'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DiskCheckpointSaver } from './research-checkpointer'
import { createExperimentPlan, planGaps, projectSignals, recommendProjectFiles, experimentDraftChanges, planLaunchCitations } from '../shared/experiment-plan'
import { experimentTaskDraftSchema } from '../shared/schemas'
import { redactSecrets } from '../shared/diagnosis-engine'
import type { AgentTraceEvent, AgentTraceObserver } from '../shared/agent-trace'
import type { PreparationAction, PreparationEdit, PreparationFlow, PreparationInput, PreparationSummary, PreparationView } from '../shared/preparation'
import type { RepositoryAnalysisInput, RepositoryGuide, RepositoryInput, RepositorySnapshot } from '../shared/repository-guide'
import type { CondaEnvironmentInfo, ExperimentTask, ExperimentTaskDraft } from '../shared/types'
import type { PlanDataCandidate } from '../shared/experiment-plan'

const inputSchema=z.object({serverId:z.string().uuid(),accessRouteId:z.string().min(1).max(80),path:z.string().trim().min(1).max(4096).refine(p=>p.startsWith('/')&&!/[\0\r\n]/.test(p),'项目目录必须是绝对路径'),goal:z.string().trim().min(1).max(2000),filePaths:z.array(z.string().min(1).max(512)).min(1).max(2000).optional()})
const fieldSchema=z.object({source:z.enum(['file','server','suggested','user','recent']),note:z.string().max(4000).optional()})
const fieldsSchema=z.record(z.string().max(40),fieldSchema)
const draftSchema=experimentTaskDraftSchema.extend({title:z.string().max(160)})
const modeSchema=z.enum(['train','evaluate'])
const editSchema=z.object({draft:draftSchema,mode:modeSchema,fields:fieldsSchema,deferredGaps:z.array(z.string().max(100)).max(20),conflicts:z.array(z.object({id:z.string().max(200),label:z.string().max(1000),current:z.string().max(20000),suggested:z.string().max(20000),suggestedDraft:experimentTaskDraftSchema.partial(),suggestedMode:modeSchema.optional(),suggestedField:z.object({field:z.enum(['title','objective','mode','codePath','launchCommand','dataPath','environment','artifactPath']),state:fieldSchema})})).max(30),history:z.array(z.object({id:z.number(),label:z.string().max(2000),at:z.string().max(80),before:z.object({draft:draftSchema,mode:modeSchema,fields:fieldsSchema})})).max(20)})
const actionSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('edit'),expectedRevision:z.number().int().nonnegative(),edit:editSchema,label:z.string().max(1000).optional()}),
  z.object({kind:z.literal('save'),expectedRevision:z.number().int().nonnegative()}),
  z.object({kind:z.literal('recheck'),expectedRevision:z.number().int().nonnegative()}),
  z.object({kind:z.literal('resume')})
])
const usageSchema=z.object({requests:z.number().int().nonnegative(),elapsedMs:z.number().nonnegative(),promptTokens:z.number().nonnegative().optional(),completionTokens:z.number().nonnegative().optional(),totalTokens:z.number().nonnegative().optional()})
const traceSchema=z.object({id:z.string().uuid(),kind:z.enum(['step','tool','model','user']),name:z.string().max(300),status:z.enum(['running','completed','warning','failed','cancelled']),startedAt:z.string().datetime(),finishedAt:z.string().datetime().optional(),elapsedMs:z.number().nonnegative().optional(),summary:z.string().max(4000),references:z.array(z.object({path:z.string().max(4096),startLine:z.number().int().positive().optional(),endLine:z.number().int().positive().optional()})).max(20).optional(),usage:usageSchema.optional()})
const bookSchema=z.record(z.string().uuid(),z.object({input:inputSchema,createdAt:z.string().datetime(),trace:z.array(traceSchema).max(240),error:z.string().max(2000).optional(),paused:z.boolean().optional(),modelUsage:z.record(z.string().uuid(),usageSchema).optional()}))
const state=Annotation.Root({flow:Annotation<PreparationFlow>(),action:Annotation<PreparationAction|null>()})
interface Operations {
  scan(input:RepositoryInput):Promise<RepositorySnapshot>
  environments(input:PreparationInput):Promise<CondaEnvironmentInfo[]>
  analyze(input:RepositoryAnalysisInput,signal:AbortSignal,trace:AgentTraceObserver):Promise<RepositoryGuide>
  candidates(input:PreparationInput):Promise<PlanDataCandidate[]>
  recheck(flow:PreparationFlow):Promise<NonNullable<PreparationFlow['checks']>>
  save(draft:ExperimentTaskDraft,id:string):Promise<ExperimentTask>
  tasks():ExperimentTask[]
}
interface Entry {modelUsage?:Record<string,ModelUsage>;trace:AgentTraceEvent[];error?:string;paused?:boolean;input:PreparationInput;createdAt:string}
const now=():string=>new Date().toISOString()

/** Owns durable preparation. Model work and task writes are confined to explicit graph nodes. */
export class PreparationService {
  private readonly directory:string
  private readonly saver:DiskCheckpointSaver
  private readonly graph:ReturnType<PreparationService['buildGraph']>
  private book:Record<string,Entry>={}
  private readyPromise?:Promise<void>
  private writes:Promise<void>=Promise.resolve()
  private running=new Map<string,AbortController>()
  constructor(private readonly ops:Operations,private readonly changed:(id:string)=>void=()=>{},directory?:string){
    this.directory=directory??join(app.getPath('userData'),'experiment-preparations')
    this.saver=new DiskCheckpointSaver(join(this.directory,'checkpoints.json'),8)
    this.graph=this.buildGraph()
  }
  private config(id:string){return {configurable:{thread_id:id},recursionLimit:16}}
  private touch(flow:PreparationFlow,patch:Partial<PreparationFlow>={}):PreparationFlow{return {...flow,...patch,updatedAt:now()}}
  private record(id:string,event:AgentTraceEvent):void{
    const entry=this.book[id];if(!entry)return
    const safe={...event,name:redactSecrets(event.name).slice(0,300),summary:redactSecrets(event.summary).slice(0,4000),references:event.references?.slice(0,20).map(r=>({...r,path:redactSecrets(r.path).slice(0,4096)}))}
    if(event.kind==='model'&&event.usage){entry.modelUsage??={};entry.modelUsage[event.id]=event.usage}
    const existing=entry.trace.findIndex(item=>item.id===event.id)
    if(existing>=0)entry.trace[existing]=safe;else entry.trace.push(safe)
    if(entry.trace.length>240)entry.trace=entry.trace.slice(-240)
    void this.persist().catch(()=>{})
    this.changed(id)
  }
  private async step<T>(id:string,name:string,summary:string,work:()=>Promise<T>,kind:AgentTraceEvent['kind']='step'):Promise<T>{
    const started=Date.now(),event:AgentTraceEvent={id:randomUUID(),kind,name,status:'running',startedAt:now(),summary}
    this.record(id,event)
    try{const result=await work();this.running.get(id)?.signal.throwIfAborted();this.record(id,{...event,status:'completed',finishedAt:now(),elapsedMs:Date.now()-started});return result}
    catch(error){this.record(id,{...event,status:this.running.get(id)?.signal.aborted?'cancelled':'failed',finishedAt:now(),elapsedMs:Date.now()-started,summary:redactSecrets(error instanceof Error?error.message:String(error))});throw error}
  }
  private buildGraph(){return new StateGraph(state)
    .addNode('scan',async({flow})=>{
      const snapshot=await this.step(flow.id,'读取项目清单',flow.input.path,()=>this.ops.scan({source:'remote',...flow.input}))
      const files=flow.input.filePaths??recommendProjectFiles(snapshot.files,flow.input.goal)
      if(!files.length)throw new Error('没有找到可分析的文本文件，请检查目录或阅读范围')
      if(files.some(path=>!snapshot.files.some(file=>file.path===path)))throw new Error('部分勾选文件已不存在，请重新选择范围')
      const signals=projectSignals(snapshot)
      this.record(flow.id,{id:randomUUID(),kind:'tool',name:'识别项目入口',status:'completed',startedAt:now(),summary:`已列出 ${snapshot.files.length} 个文件，选择 ${files.length} 个相关文件；找到 ${signals.entries.length} 个候选入口`,references:signals.entries.map(e=>({path:e.path}))})
      return {flow:this.touch(flow,{snapshot,files})}
    })
    .addNode('environment',async({flow})=>{
      let environments:CondaEnvironmentInfo[]=[]
      try{environments=await this.step(flow.id,'读取可用环境','只读检查服务器 Conda 环境',()=>this.ops.environments(flow.input),'tool')}
      catch(error){this.running.get(flow.id)?.signal.throwIfAborted();this.record(flow.id,{id:randomUUID(),kind:'step',name:'环境稍后补充',status:'warning',startedAt:now(),summary:'未读取到环境清单，保留项目建议并允许继续准备'})}
      this.record(flow.id,{id:randomUUID(),kind:'tool',name:'环境检查结果',status:environments.length?'completed':'warning',startedAt:now(),summary:environments.length?`已找到 ${environments.length} 个环境：${environments.slice(0,8).map(environment=>environment.name).join('、')}`:'环境清单不可用，可在方案中补充'})
      return {flow:this.touch(flow,{environments})}
    })
    .addNode('analyze',async({flow})=>{
      const controller=this.running.get(flow.id);if(!controller)throw new Error('准备流程已停止')
      const guide=await this.step(flow.id,'理解项目与生成方案',flow.input.goal,()=>this.ops.analyze({source:'remote',...flow.input,filePaths:flow.files},controller.signal,event=>this.record(flow.id,event)))
      const plan=createExperimentPlan({guide,goal:flow.input.goal,environments:flow.environments,now:new Date()})
      plan.draft={...plan.draft,serverId:flow.input.serverId,accessRouteId:flow.input.accessRouteId}
      if(plan.draft.projectPreparation)plan.draft.projectPreparation.configurationKey=projectConfigurationKey(plan.draft)
      this.record(flow.id,{id:randomUUID(),kind:'step',name:'形成实验方案',status:'completed',startedAt:now(),summary:[plan.fields.launchCommand?.note,plan.fields.environment?.note].filter(Boolean).join('；')||plan.summary,references:planLaunchCitations(plan).map(c=>({path:c.path,startLine:c.startLine,endLine:c.endLine}))})
      return {flow:this.touch(flow,{plan,initialPlan:structuredClone(plan),revision:flow.revision+1})}
    })
    .addNode('candidates',async({flow})=>{
      let dataCandidates:PlanDataCandidate[]=[]
      try{dataCandidates=await this.step(flow.id,'寻找数据位置','列出项目数据目录与最近使用的位置',()=>this.ops.candidates(flow.input),'tool')}
      catch{this.running.get(flow.id)?.signal.throwIfAborted()}
      return {flow:this.touch(flow,{dataCandidates})}
    })
    .addNode('wait',({flow})=>({action:interrupt({kind:'experiment-preparation',id:flow.id,revision:flow.revision}) as PreparationAction}))
    .addNode('apply',async({flow,action})=>{
      if(!action||action.kind==='resume')return {flow,action:null}
      if(action.expectedRevision!==flow.revision)throw new Error('准备方案已更新，请恢复最新版本后继续')
      if(!flow.plan)throw new Error('请先完成项目理解')
      let next=flow
      if(action.kind==='edit'){
        const edit=action.edit
        if(edit.draft.serverId!==flow.input.serverId||edit.draft.accessRouteId!==flow.input.accessRouteId)throw new Error('请为其他服务器或连接路径新建准备流程')
        const draft={...edit.draft,id:flow.taskId,preparationId:undefined}
        next=this.touch(flow,{plan:{...flow.plan,draft,mode:edit.mode,fields:edit.fields},edit:{...edit,draft},revision:flow.revision+1,checks:flow.checks})
        this.record(flow.id,{id:randomUUID(),kind:'user',name:'更新实验方案',status:'completed',startedAt:now(),summary:experimentDraftChanges(flow.plan.draft,draft).map(change=>`${change.label}：${change.before||'未填写'} → ${change.after||'未填写'}`).join('；')||action.label||'更新待补信息与选择，未调用模型'})
      }else if(action.kind==='recheck'){
        const checks=await this.step(flow.id,'重新核对当前配置','检查当前目录、入口与数据位置，未调用模型',()=>this.ops.recheck(flow),'tool')
        this.record(flow.id,{id:randomUUID(),kind:'tool',name:'当前配置核对结果',status:checks.lines.every(line=>line.ok)?'completed':'warning',startedAt:now(),summary:checks.lines.map(line=>line.text).join('；')})
        next=this.touch(flow,{checks:{...checks,configurationKey:projectConfigurationKey(flow.plan.draft)},revision:flow.revision+1,savedRevision:flow.savedRevision===flow.revision?flow.revision+1:flow.savedRevision})
      }else{
        if(flow.taskId&&!this.ops.tasks().some(task=>task.id===flow.taskId))throw new Error('关联任务已删除；请新建准备流程，避免意外重建任务')
        const existing=this.ops.tasks().find(task=>task.preparationId===flow.id)
        if(existing&&['queued','preparing','running'].includes(existing.status))throw new Error('任务已经进入运行流程，请从任务详情新建配置')
        const task=await this.step(flow.id,'保存实验草稿','使用准备流程标识保存，重复提交会更新同一任务',()=>this.ops.save({...flow.plan!.draft,id:flow.taskId??existing?.id},flow.id),'user')
        next=this.touch(flow,{taskId:task.id,savedRevision:flow.revision,plan:{...flow.plan,draft:{...flow.plan.draft,id:task.id}}})
      }
      return {flow:next,action:null}
    })
    .addEdge(START,'scan').addEdge('scan','environment').addEdge('environment','analyze').addEdge('analyze','candidates').addEdge('candidates','wait').addEdge('wait','apply').addEdge('apply','wait')
    .compile({checkpointer:this.saver})}
  private ready():Promise<void>{return this.readyPromise??=(async()=>{
    await mkdir(this.directory,{recursive:true});await this.saver.load()
    try{this.book=bookSchema.parse(JSON.parse(await readFile(join(this.directory,'sessions.json'),'utf8')))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('准备记录无法读取，请保留数据文件检查')}
    // Recover an interrupted index write from the graph checkpoint.
    for(const id of Object.keys(this.saver.storage)){
      if(this.book[id]||!z.string().uuid().safeParse(id).success)continue
      const current=await this.graph.getState(this.config(id)),flow=current.values.flow
      if(flow)this.book[id]={trace:[],input:flow.input,createdAt:flow.createdAt}
    }
    for(const entry of Object.values(this.book))for(const event of entry.trace)if(event.status==='running'){event.status='warning';event.summary=('上次应用在此步骤结束前关闭，继续时将重做这个未完成步骤；'+event.summary).slice(0,4000)}
    await this.persist()
  })()}
  private persist():Promise<void>{
    const job=this.writes.then(async()=>{await mkdir(this.directory,{recursive:true});const target=join(this.directory,'sessions.json'),temporary=target+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(this.book),'utf8');await rename(temporary,target)})
    this.writes=job.catch(()=>{});return job
  }
  async get(rawId:string):Promise<PreparationView>{
    await this.ready();const id=z.string().uuid().parse(rawId),entry=this.book[id]
    if(!entry)throw new Error('准备流程不存在')
    const current=await this.graph.getState(this.config(id))
    const flow:PreparationFlow=current.values.flow??{id,input:entry.input,createdAt:entry.createdAt,updatedAt:entry.createdAt,revision:0,files:[],environments:[],dataCandidates:[]}
    const busy=this.running.has(id),plan=flow.plan,task=this.ops.tasks().find(task=>task.id===flow.taskId||task.preparationId===id)
    const gaps=plan?planGaps(plan,{environments:flow.environments,dataCandidates:flow.dataCandidates}).filter(gap=>!flow.edit?.deferredGaps.includes(gap.id)):[]
    const phase:PreparationView['phase']=busy&&!plan?'analyzing':entry.paused?'paused':entry.error?'failed':!plan?'paused':task&&flow.savedRevision===flow.revision?'saved':gaps.length?'needs_input':'review'
    return {...structuredClone(flow),taskId:flow.taskId??task?.id,task:task?structuredClone(task):undefined,phase,busy,pending:[...current.next],error:entry.error,trace:structuredClone(entry.trace),usage:entry.modelUsage?sumModelUsage(Object.values(entry.modelUsage)):undefined}
  }
  async list():Promise<PreparationSummary[]>{await this.ready();const results:PreparationSummary[]=[];for(const id of Object.keys(this.book)){const view=await this.get(id);results.push({id,input:view.input,updatedAt:view.updatedAt,phase:view.phase,title:view.plan?.draft.title||view.input.goal,taskId:view.taskId})}return results.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))}
  private async execute(id:string,operation:()=>Promise<unknown>):Promise<PreparationView>{
    if(this.running.has(id))throw new Error('准备流程正在处理，请稍候')
    const controller=new AbortController();this.running.set(id,controller);delete this.book[id].error;delete this.book[id].paused;this.changed(id)
    try{await operation()}catch(error){this.book[id].error=redactSecrets(error instanceof Error?error.message:String(error)).slice(0,2000);this.book[id].paused=controller.signal.aborted}
    finally{this.running.delete(id);await this.persist();this.changed(id)}
    return this.get(id)
  }
  async create(rawInput:PreparationInput,rawId:string):Promise<PreparationView>{
    await this.ready();const id=z.string().uuid().parse(rawId),input=inputSchema.parse(rawInput)
    if(this.book[id]){if(JSON.stringify(this.book[id].input)!==JSON.stringify(input))throw new Error('准备标识已经用于其他输入');return this.get(id)}
    if(Object.keys(this.book).length>=100)throw new Error('准备流程已达到 100 项，请先整理本地历史')
    const at=now();this.book[id]={trace:[],input,createdAt:at}
    return this.execute(id,async()=>{await this.persist();return this.graph.invoke({flow:{id,input,createdAt:at,updatedAt:at,revision:0,files:[],environments:[],dataCandidates:[]},action:null},this.config(id))})
  }
  async act(rawId:string,rawAction:PreparationAction):Promise<PreparationView>{
    await this.ready();const id=z.string().uuid().parse(rawId),action=actionSchema.parse(rawAction) as PreparationAction
    if(!this.book[id])throw new Error('准备流程不存在')
    if(this.running.has(id))throw new Error('准备流程正在处理，请稍候')
    const current=await this.graph.getState(this.config(id))
    if(action.kind!=='resume'&&action.expectedRevision!==current.values.flow?.revision)throw new Error('准备方案已更新，请恢复最新版本后继续')
    if(action.kind==='resume'){
      if(!current.values.flow)return this.execute(id,()=>this.graph.invoke({flow:{id,input:this.book[id].input,createdAt:this.book[id].createdAt,updatedAt:now(),revision:0,files:[],environments:[],dataCandidates:[]},action:null},this.config(id)))
      if(current.next.includes('wait')){delete this.book[id].error;delete this.book[id].paused;await this.persist();return this.get(id)}
      // A save interrupted before checkpoint completion is replayed with the same preparation id.
      return this.execute(id,()=>this.graph.invoke(null,this.config(id)))
    }
    if(!current.next.includes('wait')&&!current.next.includes('apply'))throw new Error('请先继续未完成的项目分析')
    return this.execute(id,async()=>{
      if(current.next.includes('wait'))await this.graph.invoke(new Command({resume:action}),this.config(id))
      else{await this.graph.updateState(this.config(id),{action});await this.graph.invoke(null,this.config(id))}
    })
  }
  async cancel(rawId:string):Promise<void>{await this.ready();const id=z.string().uuid().parse(rawId);this.running.get(id)?.abort(new Error('准备已暂停，已完成的步骤与方案已保存'))}
  stop():void{for(const controller of this.running.values())controller.abort(new Error('应用已关闭，准备流程可在下次继续'))}
}
