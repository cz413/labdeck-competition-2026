import { ResearchOutputNames } from './research-output-names'
import { deviceLaunchCommand } from '../shared/experiment-launch'
import { app, dialog, ipcMain } from 'electron'
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AppStore } from './store'
import type { IntelligenceService } from './intelligence-service'
import type { SshService } from './ssh-service'
import type { ExperimentTask, ExperimentTaskDraft } from '../shared/types'
import type { ResearchAnalysis, ResearchCampaign, ResearchInput, ResearchRunTarget, ResearchOutputIsolation, ResearchSuggestion, ResearchView, RunObservation } from '../shared/research'
import { baselineDraft } from '../shared/research'
import { resultAnalysisPayload, resultAnalysisPrompt, hasInternalAnalysisText } from './research-analysis'
import { isolateResearchVariants, reuseResearchOutput, researchOutputLocations } from './research-output'
import { analyzeResearchOutput } from './research-output-model'
import type { RepositorySnapshot, RepositoryExcerpt } from '../shared/repository-guide'
import { researchMemberTitle } from '../shared/research-pool'
import { axesSchema, expandParameters } from '../shared/parameter-engine'
import { experimentRunStartInputSchema, experimentTaskDraftSchema } from '../shared/schemas'
import { applyAccessRoute, getAccessRoutes, getDefaultAccessRouteId } from '../shared/access-routes'
import { redactSecrets } from '../shared/diagnosis-engine'
import { DiskCheckpointSaver } from './research-checkpointer'
import { ParameterBridge } from './parameter-bridge'
import type { ResultCollectionConfig } from '../shared/research-results'
import { collectRunResults } from './result-collector'
import { openRepositoryReadSession } from './repository-reader'
import { commandParameter, researchDesignPrompt, researchImports, researchParameters, researchReadPaths, validateResearchDesign } from './research-design'
import { evidenceState, metricColumns, metricContext, metricIdentity, normalizeResultConfig, resultConfigForRun, observationMetrics, processEvidenceState, resultConfigSchema, resultConfigurationWarnings } from '../shared/research-results'
const runTargetSchema=experimentRunStartInputSchema.pick({computeDevice:true,gpuUuid:true,gpuIndex:true,gpuNameSnapshot:true,minimumFreeVramGiB:true,maximumGpuUtilizationPercent:true}).strict()
const campaignState=Annotation.Root({campaign:Annotation<ResearchCampaign>()})
const designVariableSchema=z.object({flag:z.string().max(50),baselineValue:z.string().max(80),source:z.object({path:z.string().max(512),startLine:z.number().int().positive(),quote:z.string().max(1200)})})
const designSchema=z.object({status:z.literal('ready'),axes:axesSchema,baselineCommand:z.string().max(20000),hypothesis:z.string().max(1500),rationale:z.string().max(1800).optional(),assumptions:z.array(z.string().max(500)).max(12),readFiles:z.array(z.string().max(512)).max(8).optional(),variable:designVariableSchema.optional(),variables:z.array(designVariableSchema).min(1).max(5).optional()})
const inputSchema=z.object({taskId:z.string().uuid(),sourceRunId:z.string().uuid().optional(),objective:z.string().trim().min(1).max(2000),axes:axesSchema,maxRuns:z.number().int().min(1).max(32),useModel:z.boolean().optional(),resultConfig:resultConfigSchema.optional(),expectedBaselineCommand:z.string().max(20000).optional(),design:designSchema.optional()})
const analysisSchema=z.object({summary:z.string().max(3000),observations:z.array(z.string().max(800)).max(10),limitations:z.array(z.string().max(800)).max(10).default([]),evidenceIds:z.array(z.string()).min(1).max(32),nextSuggestion:z.object({objective:z.string().min(1).max(2000),axes:axesSchema}).optional()})
const capturedSchema=z.object({key:z.string(),taskId:z.string(),runId:z.string(),status:z.string(),evidenceId:z.string(),metrics:z.record(z.string(),z.number()),excerpt:z.string()}).passthrough()
const bookSchema=z.record(z.string().uuid(),z.object({paused:z.boolean(),error:z.string().optional(),deleted:z.boolean().optional(),captured:z.array(capturedSchema).optional()}))
const now=():string=>new Date().toISOString()
function event(c:ResearchCampaign,node:string,message:string):ResearchCampaign {return {...c,updatedAt:now(),events:[...c.events,{at:now(),node,message}]}}
function configIdentity(d:ExperimentTaskDraft):string {
  return createHash('sha256').update(JSON.stringify({server:d.serverId,route:d.accessRouteId,code:d.codePath,data:d.dataPath,command:d.launchCommand,env:d.condaEnvironment,artifact:d.artifactPath,vram:d.minimumFreeVramGiB,util:d.maximumGpuUtilizationPercent})).digest('hex')
}
export class ResearchService {
  private readonly directory:string
  private readonly outputNames:ResearchOutputNames
  private readonly saver:DiskCheckpointSaver
  private readonly bridge:ParameterBridge
  private readonly graph:ReturnType<ResearchService['buildGraph']>
  private readyPromise?:Promise<void>
  private book:Record<string,{paused:boolean;error?:string;deleted?:boolean;captured?:RunObservation[]}>={}
  private bookWrites:Promise<void>=Promise.resolve()
  private readonly running=new Set<string>()
  private timer?:NodeJS.Timeout
  constructor(private readonly store:AppStore,private readonly intelligence:IntelligenceService,private readonly ssh:SshService,private readonly changed:()=>void=()=>{},private readonly queueChanged:()=>void=()=>{},options?:{directory?:string;engineDirectory?:string}) {
    this.directory=options?.directory??join(app.getPath('userData'),'research')
    this.outputNames=new ResearchOutputNames(join(this.directory,'output-names.json'))
    this.saver=new DiskCheckpointSaver(join(this.directory,'checkpoints.json'))
    this.bridge=new ParameterBridge(options?.engineDirectory??(app.isPackaged?join(process.resourcesPath,'cangjie'):join(app.getAppPath(),'resources','cangjie')))
    this.graph=this.buildGraph()
  }
  private buildGraph(){
    return new StateGraph(campaignState)
      .addNode('expand',async({campaign})=>{
        const expansion=await this.bridge.expand(campaign.baseline.launchCommand,campaign.axes,campaign.maxRuns)
        if(campaign.axes.some(axis=>[campaign.outputIsolation?.flag,...(campaign.outputIsolation?.targets??[]).map(target=>target.flag)].includes(axis.flag)))throw new Error('输出目录由系统独立分配，不能同时作为对比变量')
        const variants=isolateResearchVariants(campaign.id,campaign.baseline,expansion.variants,campaign.outputIsolation??{status:'unverified'},await this.outputNames.allocate(campaign.id))
        const previous=this.store.listExperimentTasks()
        const repeats=expansion.variants.filter(v=>previous.some(t=>configIdentity({...campaign.baseline,launchCommand:v.command})===configIdentity(t)&&t.runs.length))
        return {campaign:event({...campaign,members:variants,expansionEngine:expansion.engine,warnings:[...expansion.warnings,...resultConfigurationWarnings(normalizeResultConfig(campaign.resultConfig),variants),...(campaign.outputIsolation?.status==='verified'?[]:[campaign.outputIsolation?.reason??'本批尚未确认独立输出目录']),...(repeats.length?[`${repeats.length} 个配置存在历史运行；再次执行有助于复现，请确认是否需要。`]:[])]},'expand',`生成 ${expansion.variants.length} 组配置，等待审查`)}
      })
      .addNode('review',({campaign})=>{
        const approved=interrupt({kind:'approval',campaignId:campaign.id,count:campaign.members.length})
        if(approved!==true)throw new Error('需要明确确认参数、服务器和运行数量')
        return {campaign:event({...campaign,approvedAt:now()},'review','用户确认本批配置及运行数量')}
      })
      .addNode('queue',async({campaign})=>({campaign:event(await this.queue(campaign),'queue','本批实验已接入已有任务队列')}))
      .addNode('observe',({campaign})=>{
        interrupt({kind:'wait-runs',campaignId:campaign.id})
        return {campaign:event(campaign,'observe','本批运行已结束，开始收集证据')}
      })
      .addNode('collect',async({campaign})=>({campaign:event({...campaign,observations:await this.collect(campaign)},'collect','已分别采集进程、指标来源和产物证据；科学结果不设通过阈值')}))
      .addNode('diagnose',async({campaign})=>{
        const observations:RunObservation[]=[]
        let automaticDiagnoses=0
        for(const observation of campaign.observations){
          if(observation.status!=='failed' && (observation.exitCode===undefined||observation.exitCode===0)){observations.push(observation);continue}
          try {
            const prior=(await this.intelligence.history()).find(r=>r.taskId===observation.taskId&&r.runId===observation.runId)
            if(!prior && automaticDiagnoses>=4){observations.push({...observation,warning:[observation.warning,'本批自动诊断已达到 4 项上限，可从任务栏手动诊断此运行'].filter(Boolean).join('；')});continue}
            if(!prior)automaticDiagnoses++
            const report=prior??await this.intelligence.diagnose({taskId:observation.taskId,runId:observation.runId,useModel:false})
            observations.push({...observation,diagnosisId:report.id})
          } catch(error) {observations.push({...observation,warning:[observation.warning,this.errorMessage(error)].filter(Boolean).join('；')})}
        }
        return {campaign:event({...campaign,observations},'diagnose','故障运行已关联规则诊断；模型深入分析和修复需从指定运行手动发起')}
      })
      .addNode('analyze',async({campaign})=>({campaign:event({...campaign,stage:'analysis',analysis:await this.analysis(campaign)},'analyze','运行结果已汇总，可按需请求 AI 分析')}))
      .addEdge(START,'expand').addEdge('expand','review').addEdge('review','queue').addEdge('queue','observe').addEdge('observe','collect')
      .addConditionalEdges('collect',({campaign})=>campaign.observations.some(o=>o.status==='failed'||(o.exitCode!==undefined&&o.exitCode!==0))?'diagnose':'analyze',['diagnose','analyze'])
      .addEdge('diagnose','analyze').addEdge('analyze',END).compile({checkpointer:this.saver})
  }
  private ready():Promise<void>{return this.readyPromise??=(async()=>{
    await mkdir(this.directory,{recursive:true});await this.saver.load()
    try{this.book=bookSchema.parse(JSON.parse(await readFile(join(this.directory,'campaigns.json'),'utf8')))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('实验研究索引无法读取，请保留文件检查')}
    // A crash between saving a graph checkpoint and saving the index must not hide that workflow.
    let recovered=false
    for(const [id,entry] of Object.entries(this.book))if(entry.deleted){await this.saver.deleteThread(id);delete this.book[id];recovered=true}
    for(const id of Object.keys(this.saver.storage))if(!this.book[id]&&z.string().uuid().safeParse(id).success){
      const state=await this.graph.getState(this.config(id))
      if(state.values.campaign){this.book[id]={paused:false};recovered=true}
    }
    if(recovered)await this.persistBook()
  })()}
  private async persistBook():Promise<void>{
    const content=JSON.stringify(this.book,null,2)
    const job=this.bookWrites.then(async()=>{const file=join(this.directory,'campaigns.json');const temporary=`${file}.${randomUUID()}.tmp`;await writeFile(temporary,content,'utf8');await rename(temporary,file)})
    this.bookWrites=job.catch(()=>{});await job
  }
  private config(id:string){return {configurable:{thread_id:id},recursionLimit:16}}
  private async view(id:string):Promise<ResearchView>{
    const meta=this.book[id];if(!meta||meta.deleted)throw new Error('实验研究不存在')
    const state=await this.graph.getState(this.config(id))
    if(!state.values.campaign)throw new Error('实验研究尚未写入检查点，请检查历史文件')
    const campaign=structuredClone(state.values.campaign) as ResearchCampaign
    if(state.next.includes('review')&&!campaign.members.some(member=>member.taskId)&&campaign.outputIsolation?.engine!=='model'&&campaign.outputIsolation?.status!=='unverified'){
      campaign.outputIsolation={status:'unverified',reason:'本方案尚未经过 AI 源码核对，请重新核对输出位置后运行。'}
    }
    const observations=[...campaign.observations,...(meta.captured??[]).filter(item=>campaign.members.some(member=>member.runId===item.runId)&&!campaign.retrySubmission?.items.some(retry=>retry.previousRunId===item.runId)&&!campaign.observations.some(old=>old.runId===item.runId))]
    return {...campaign,busy:this.running.has(id),paused:meta.paused,error:meta.error,observations,pending:campaign.retrySubmission?['retry']:[...state.next]}
  }
  async list():Promise<ResearchView[]>{
    await this.ready();const views:ResearchView[]=[]
    for(const id of Object.keys(this.book)){if(this.book[id]?.deleted)continue;try{views.push(await this.view(id))}catch(error){if(this.book[id]&&!this.book[id].deleted)throw error}}
    return views.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
  }
  async remove(rawId:string):Promise<void>{return this.removeRecord(rawId,false)}
  async removeBatch(rawId:string):Promise<void>{return this.removeRecord(rawId,true)}
  private async removeRecord(rawId:string,includeTasks:boolean):Promise<void>{
    await this.ready();const id=z.string().uuid().parse(rawId)
    if(this.running.has(id))throw new Error('对照记录正在处理，请稍后再删除')
    if(!this.book[id])return
    this.running.add(id)
    try{
      if(includeTasks){
        const campaign=await this.view(id)
        const ids=new Set(campaign.members.flatMap(member=>member.taskId?[member.taskId]:[]))
        // Also cover children saved before a partially submitted graph was checkpointed.
        for(const task of this.store.listExperimentTasks())if(campaign.members.some((_member,index)=>task.notes.split('\n')[0]===`[研究:${id}:${index}]`))ids.add(task.id)
        ids.delete(campaign.sourceTaskId)
        await this.store.deleteExperimentTasks([...ids])
        this.queueChanged()
      }
      this.book[id].deleted=true;await this.persistBook()
      await this.saver.deleteThread(id)
      delete this.book[id];await this.persistBook()
    }finally{this.running.delete(id);this.changed()}
  }
  async engine(){return this.bridge.status()}
  private task(id:string):ExperimentTask {const task=this.store.listExperimentTasks().find(t=>t.id===id);if(!task)throw new Error('来源任务不存在');return task}
  async suggest(taskId:string,objective:string,maxRuns:number,sourceRunId?:string):Promise<ResearchSuggestion>{
    z.string().uuid().parse(taskId);z.string().trim().min(1).max(2000).parse(objective);z.number().int().min(1).max(32).parse(maxRuns)
    await this.ready()
    z.string().uuid().optional().parse(sourceRunId)
    const source=this.task(taskId),task={...source,...baselineDraft(source,sourceRunId)}
    if(task.launchMode==='script')throw new Error('智能设计暂支持 Python 命令，请选择命令模式任务')
    if(!task.serverId||!task.codePath)throw new Error('请先为基准任务配置服务器和代码目录')
    if(maxRuns<2)throw new Error('对照方案至少需要 2 次运行，包含基线和一个候选值')
    const paths=researchReadPaths(task.launchCommand,task.codePath)
    const session=await openRepositoryReadSession(this.store,this.ssh,{source:'remote',path:task.codePath,serverId:task.serverId,accessRouteId:task.accessRouteId})
    try {
      const warnings:string[]=[]
      let bytes=0
      const read=async(path:string):Promise<void>=>{
        if(session.snapshot.excerpts.some(f=>f.path===path))return
        const file=session.snapshot.files.find(f=>f.path===path)
        if(!file)return
        if(session.snapshot.excerpts.length>=8||file.sizeBytes>128000||bytes+file.sizeBytes>180000){warnings.push(`${path} 超出本次读取范围，请手动核对`);return}
        try{await session.read(path);bytes+=file.sizeBytes}catch{warnings.push(`${path} 未能读取，请检查文件或连接`)}
      }
      await read(paths.entry)
      const readme=session.snapshot.files.find(f=>/^readme(?:\.|$)/i.test(f.path))
      if(readme)await read(readme.path)
      for(const path of paths.configs)await read(path)
      // Follow local imports from the entry, then their immediate imports, within a fixed budget.
      for(let i=0;i<session.snapshot.excerpts.length&&i<8;i++)if(session.snapshot.excerpts[i].path.endsWith('.py'))for(const path of researchImports(session.snapshot.excerpts[i]))await read(path)
      const files=session.snapshot.excerpts
      const entry=files.find(f=>f.path===paths.entry)
      if(!entry)return {axes:[],status:'needs_info',baselineCommand:task.launchCommand,hypothesis:'',assumptions:['未读取到训练入口，请检查代码目录和入口文件。',...warnings],readFiles:files.map(f=>f.path)}
      let parameters=researchParameters(task.launchCommand,files)
      // Configuration loading / set_defaults may override static argparse defaults.
      if(paths.configs.length||files.some(f=>/\.set_defaults\s*\(|(?:yaml|json)\.(?:safe_)?load|parse_known_args/.test(f.text))){
        parameters=parameters.filter(p=>new RegExp('(?:^|\\s)'+p.flag+'(?:=|\\s)').test(task.launchCommand))
        warnings.push('配置可能覆盖默认值，仅对比启动命令中明确指定的参数。')
      }
      if(!parameters.some(p=>p.baselineValue!==undefined))return {axes:[],status:'needs_info',baselineCommand:task.launchCommand,hypothesis:'',assumptions:['未找到具有明确基线值的常见 argparse 参数，请手动指定变量并核对定义。',...warnings],readFiles:files.map(f=>f.path)}
      const answer=await this.intelligence.requestResearchModel(researchDesignPrompt,{objective,maxRuns,baseline:{command:task.launchCommand,device:task.computeDevice??'gpu',dataPath:task.dataPath},parameters,files:files.map(f=>({...f,text:f.text.slice(0,60000),truncated:f.truncated||f.text.length>60000})),warnings})
      const result=validateResearchDesign(answer,task.launchCommand,parameters,maxRuns)
      return {...result,assumptions:[...result.assumptions,...warnings,...session.snapshot.warnings].slice(0,12),readFiles:files.map(f=>f.path)}
    }finally{session.close()}
  }
  private async inspectOutput(baseline:ExperimentTaskDraft,preparationId?:string):Promise<ResearchOutputIsolation>{
    if(!baseline.serverId)return {status:'unverified',reason:'缺少输出目录核对所需的服务器'}
    let cached:RepositorySnapshot|undefined
    const warnings:string[]=[]
    if(preparationId){
      try{
        const snapshot=await this.intelligence.preparationRepository(preparationId)
        if(snapshot){
          const root=posix.resolve(snapshot.input.path),directory=posix.resolve(baseline.codePath)
          if(snapshot.input.source==='remote'&&snapshot.input.serverId===baseline.serverId&&(snapshot.input.accessRouteId??'direct')===(baseline.accessRouteId??'direct')&&(directory===root||directory.startsWith(root+'/')))cached=snapshot
          else warnings.push('准备记录的服务器、连接路径或项目目录与本次基准不一致，未复用其源码。')
        }
      }catch{warnings.push('原准备记录已删除或无法读取，本次重新读取项目源码。')}
    }
    const root=cached?.input.path??baseline.codePath
    const files=new Map<string,RepositoryExcerpt>((cached?.excerpts??[]).map(file=>[file.path,structuredClone(file)]))
    if(cached)warnings.push(...cached.warnings,`复用智能实验在 ${cached.collectedAt} 读取的源码快照；工作目录为 ${baseline.codePath}，文件路径相对项目根目录 ${root}。快照未重新核验服务器最新内容。`)
    const complete=!!cached&&cached.files.length>0&&cached.files.every(file=>files.has(file.path)&&!files.get(file.path)!.truncated)
    if(!complete){
      try{
        const session=await openRepositoryReadSession(this.store,this.ssh,{source:'remote',serverId:baseline.serverId,accessRouteId:baseline.accessRouteId,path:root})
        try{
          for(const file of session.snapshot.files){
            if(files.has(file.path)&&!files.get(file.path)!.truncated)continue
            try{files.set(file.path,await session.read(file.path))}catch{warnings.push(`${file.path} 未能补读，判断输出位置时必须考虑此缺口。`)}
          }
          warnings.push(...session.snapshot.warnings)
        }finally{session.close()}
      }catch{warnings.push('未能连接服务器补读文件，本次只能根据已缓存源码判断。')}
    }
    return analyzeResearchOutput(baseline,[...files.values()],warnings,(system,payload)=>this.intelligence.requestResearchModel(system,payload,{purpose:'repository'}),{root,collectedAt:cached?.collectedAt,reused:!!cached})
  }
  async create(raw:ResearchInput):Promise<ResearchView>{
    await this.ready();const input=inputSchema.parse(raw),source=this.task(input.taskId),task={...source,...baselineDraft(source,input.sourceRunId)}
    if(input.design&&(input.design.baselineCommand!==task.launchCommand||JSON.stringify(input.design.axes)!==JSON.stringify(input.axes)))throw new Error('智能方案与当前参数不一致，请重新设计或使用手动参数')
    if(input.expectedBaselineCommand!==undefined&&input.expectedBaselineCommand!==task.launchCommand)throw new Error('基准命令已变化，请重新生成对照方案')
    if(task.launchMode==='script')throw new Error('第一版对照实验仅支持命令模式，请选择 Python 命令任务')
    if(!task.serverId||this.store.getServer(task.serverId).mode!=='real')throw new Error('选择实际服务器上的实验任务；离线体验请使用演示入口')
    const baseline=experimentTaskDraftSchema.parse({...baselineDraft(task),accessRouteId:task.accessRouteId??getDefaultAccessRouteId(this.store.getServer(task.serverId)),launchMode:'command',scriptPath:''})
    expandParameters(baseline.launchCommand,input.axes,input.maxRuns)
    if(Object.keys(this.book).length>=100)throw new Error('本地实验研究已达到 100 项，请导出并整理历史')
    const outputIsolation=await this.inspectOutput(baseline,source.preparationId)
    const id=randomUUID(),timestamp=now()
    const campaign:ResearchCampaign={id,createdAt:timestamp,updatedAt:timestamp,objective:input.objective,sourceTaskId:task.id,sourceRunId:input.sourceRunId,sourceRunNumber:source.runs.find(run=>run.id===input.sourceRunId)?.number,baseline,sourcePreparationId:source.preparationId,outputIsolation,design:input.design,axes:input.axes,maxRuns:input.maxRuns,useModel:false,resultConfig:normalizeResultConfig(input.resultConfig),stage:'review',members:[],expansionEngine:'typescript',warnings:[],observations:[],events:[]}
    this.book[id]={paused:false}
    await this.execute(id,()=>this.graph.invoke({campaign},this.config(id)))
    return this.view(id)
  }
  private async execute(id:string,operation:()=>Promise<unknown>):Promise<void>{
    if(!this.book[id]||this.book[id].deleted)throw new Error('对照记录已删除')
    if(this.running.has(id))throw new Error('该实验流程正在处理，请稍后再试')
    this.running.add(id)
    try{await operation();delete this.book[id].error}
    catch(error){this.book[id].error=this.errorMessage(error);throw error}
    finally{this.running.delete(id);await this.persistBook();this.changed()}
  }
  private errorMessage(error:unknown):string{return redactSecrets(error instanceof Error?error.message:String(error)).slice(0,1000)}
  async recheckOutput(rawId:string):Promise<ResearchView>{
    await this.ready();const id=z.string().uuid().parse(rawId),current=await this.view(id)
    const submitted=current.members.some(member=>member.taskId)
    if(submitted&&(current.stage!=='analysis'||current.pending.length||current.retrySubmission))throw new Error('请等待本批运行结束后核对保存目录')
    const outputIsolation=await this.inspectOutput(current.baseline,current.sourcePreparationId??this.store.listExperimentTasks().find(task=>task.id===current.sourceTaskId)?.preparationId)
    if(submitted){
      if(outputIsolation.status!=='verified')throw new Error(outputIsolation.reason??'尚未确认实际保存目录')
      await this.execute(id,async()=>{
        const members=current.members.map(member=>{const task=this.task(member.taskId!);const run=task.runs.find(run=>run.id===member.runId);if(!run)throw new Error('关联运行已删除');return {...member,...researchOutputLocations(run.launchCommand??member.command,run.codePath??current.baseline.codePath,outputIsolation)}})
        const config=normalizeResultConfig(current.resultConfig),runResultFiles={...config.runResultFiles}
        for(const [index,member] of members.entries()){
          const old=current.members[index].outputDirectory
          if(old&&member.runId&&runResultFiles[member.runId])runResultFiles[member.runId]=runResultFiles[member.runId].map(path=>path.startsWith(old+'/')?member.outputDirectory+path.slice(old.length):path)
        }
        const updated=event({...current,members,outputIsolation,resultConfig:{...config,runResultFiles},analysis:undefined,observations:[],events:current.events.map(event=>event.node==='result_analysis'?{...event,node:'previous_result_analysis'}:event)},'output_paths_recheck','根据 AI 源码复核修正保存目录；未修改命令、移动文件或启动运行，请重新采集结果')
        await this.graph.updateState(this.config(id),{campaign:updated},'analyze')
        this.book[id].captured=[];await this.persistBook()
      })
      return this.view(id)
    }
    await this.execute(id,async()=>{
      // Start expansion again, rather than resuming the failed/paused node with stale warnings.
      const {busy:_busy,paused:_paused,error:_error,pending:_pending,...campaign}=current
      await this.graph.updateState(this.config(id),{campaign:event({...campaign,outputIsolation,approvedAt:undefined},'output_recheck','重新核对保存参数并更新各组独立输出位置')},START)
      await this.graph.invoke(null,this.config(id))
    })
    return this.view(id)
  }
  async approve(id:string,confirmed:boolean,rawTarget?:ResearchRunTarget):Promise<ResearchView>{
    await this.ready();z.string().uuid().parse(id);if(confirmed!==true)throw new Error('需要明确确认后才能加入队列')
    const current=await this.view(id)
    if(current.paused)throw new Error('先恢复流程，再确认运行')
    if(current.outputIsolation?.status==='unverified')throw new Error(current.outputIsolation.reason??'尚未确认各组独立保存位置，请重新核对输出位置。')
    let target=rawTarget===undefined?current.runTarget:runTargetSchema.parse(rawTarget)
    if(target?.computeDevice==='cpu')target={...target,gpuUuid:null,gpuIndex:null,gpuNameSnapshot:null,minimumFreeVramGiB:null,maximumGpuUtilizationPercent:null}
    if(current.pending.includes('queue')&&rawTarget!==undefined&&JSON.stringify(target)!==JSON.stringify(current.runTarget))throw new Error('本批已确认，恢复提交时不能更换运行设备')
    if(current.pending.includes('review'))await this.execute(id,async()=>{
      if(target){
        await this.graph.updateState(this.config(id),{campaign:{...current,runTarget:target}},'expand')
        await this.graph.invoke(null,this.config(id))
      }
      await this.graph.invoke(new Command({resume:true}),this.config(id))
    })
    else if(current.pending.includes('queue'))await this.execute(id,()=>this.graph.invoke(null,this.config(id)))
    return this.view(id)
  }
  async retryFailed(rawId:string,confirmed:boolean,rawTarget?:ResearchRunTarget):Promise<ResearchView>{
    await this.ready();const id=z.string().uuid().parse(rawId)
    if(confirmed!==true)throw new Error('请先确认重跑失败组')
    await this.execute(id,async()=>{
      const view=await this.view(id)
      let current:ResearchCampaign=view
      if(view.paused)throw new Error('请先恢复本批跟踪')
      if(!current.retrySubmission){
        const tasks=this.store.listExperimentTasks()
        const entries=current.members.map((member,index)=>({member,index,task:tasks.find(task=>task.id===member.taskId),run:tasks.find(task=>task.id===member.taskId)?.runs.find(run=>run.id===member.runId)}))
        if(!entries.length||entries.some(entry=>!entry.task||!entry.run))throw new Error('关联任务或运行已删除，无法重跑本批')
        if(entries.some(entry=>!['completed','failed','cancelled'].includes(entry.run!.status)))throw new Error('请等待本批运行全部结束后重跑失败组')
        const failed=entries.filter(entry=>entry.run!.status==='failed')
        if(!failed.length)throw new Error('本批没有需要重跑的失败组')
        if(current.outputIsolation?.status!=='verified'||current.outputIsolation.engine!=='model')throw new Error('本批缺少 AI 确认的输出位置，请重新创建对照方案')
        let target=runTargetSchema.parse(rawTarget??current.runTarget??{computeDevice:current.baseline.computeDevice??'gpu',gpuUuid:null,gpuIndex:null,gpuNameSnapshot:null,minimumFreeVramGiB:current.baseline.minimumFreeVramGiB??null,maximumGpuUtilizationPercent:current.baseline.maximumGpuUtilizationPercent??null})
        if(target.computeDevice==='cpu')target={...target,gpuUuid:null,gpuIndex:null,gpuNameSnapshot:null,minimumFreeVramGiB:null,maximumGpuUtilizationPercent:null}
        for(const entry of failed){
          const task=entry.task!
          if(Object.entries(entry.member.parameters).some(([flag,value])=>commandParameter(task.launchCommand,flag)!==value))throw new Error('失败组的对比参数已改变，请恢复原对比值或创建新的对照方案')
          if(task.archived||task.runs.some(run=>['queued','preparing','running'].includes(run.status)))throw new Error('失败组任务已归档或已有运行，请先处理后重试')
          if(task.serverId!==current.baseline.serverId||task.codePath!==current.baseline.codePath||task.launchMode==='script'||researchReadPaths(task.launchCommand,task.codePath).entry!==researchReadPaths(current.baseline.launchCommand,current.baseline.codePath).entry)throw new Error('失败组的服务器、入口或代码目录已改变，请为新配置创建对照方案')
        }
        const count=(current.retryCount??0)+1,attempt=randomUUID()
        const items=failed.map(({member,index,task,run})=>{
          const next=member,command=deviceLaunchCommand(reuseResearchOutput(task!.launchCommand,member.command,current.outputIsolation!),target.computeDevice??current.baseline.computeDevice??'gpu')
          return {index,taskId:task!.id,previousRunId:run!.id,member:{...next,command,taskId:task!.id,runId:undefined},input:experimentRunStartInputSchema.parse({serverId:task!.serverId??null,accessRouteId:task!.accessRouteId??current.baseline.accessRouteId??null,computeDevice:target.computeDevice??current.baseline.computeDevice??'gpu',gpuUuid:target.gpuUuid,gpuIndex:target.gpuIndex,gpuNameSnapshot:target.gpuNameSnapshot,codePath:task!.codePath,dataPath:task!.dataPath,launchCommand:command,launchMode:'command',scriptPath:'',condaEnvironment:task!.condaEnvironment??null,artifactPath:next.outputDirectory??task!.artifactPath,outputDirectories:next.outputDirectories,stdoutLogPath:task!.stdoutLogPath,minimumFreeVramGiB:target.minimumFreeVramGiB,maximumGpuUtilizationPercent:target.maximumGpuUtilizationPercent,notes:`[研究重跑:${id}:${attempt}:${index}]\n${member.key}`})}
        })
        const oldIds=new Set(items.map(item=>item.previousRunId))
        current=event({...current,stage:'waiting',retryCount:count,retrySubmission:{id:attempt,target,items},analysis:undefined,observations:current.observations.filter(observation=>!oldIds.has(observation.runId)),events:current.events.map(event=>event.node==='result_analysis'?{...event,node:'previous_result_analysis'}:event)},'retry',`用户确认重跑 ${items.length} 个失败组，成功组保持原运行`)
        await this.graph.updateState(this.config(id),{campaign:current},'queue')
        this.book[id].captured=(this.book[id].captured??[]).filter(item=>!oldIds.has(item.runId));await this.persistBook()
      }else if(rawTarget!==undefined)throw new Error('重跑提交已确认，恢复时不能更换设备')
      const submission=current.retrySubmission!
      for(const item of submission.items){
        let task=this.task(item.taskId)
        const marker=item.input.notes.split('\n')[0]
        let run=task.runs.find(run=>run.notes.split('\n')[0]===marker)
        if(!run){task=await this.store.startExperimentRun(task.id,item.input);run=task.runs.find(run=>run.notes.split('\n')[0]===marker)}
        if(!run)throw new Error('未能确认重跑记录，请重新检查提交进度')
        if(current.members[item.index].runId===run.id)continue
        const members=[...current.members];members[item.index]={...item.member,runId:run.id}
        const config=normalizeResultConfig(current.resultConfig),runResultFiles={...config.runResultFiles}
        const previous=current.members[item.index]
        const paths=resultConfigForRun(config,item.previousRunId).resultFiles??[]
        if(paths.length)runResultFiles[run.id]=paths.map(path=>previous.outputDirectory&&path.startsWith(previous.outputDirectory+'/')&&item.member.outputDirectory?item.member.outputDirectory+path.slice(previous.outputDirectory.length):path)
        delete runResultFiles[item.previousRunId]
        current={...current,members,resultConfig:{...config,runResultFiles}}
        await this.graph.updateState(this.config(id),{campaign:current},'queue')
        this.queueChanged()
      }
      current=event({...current,retrySubmission:undefined},'retry_queued','失败组已重新提交，跟踪新的运行记录')
      await this.graph.updateState(this.config(id),{campaign:current},'queue')
      await this.graph.invoke(null,this.config(id))
    })
    return this.view(id)
  }
  private async queue(c:ResearchCampaign):Promise<ResearchCampaign>{
    if(!c.approvedAt)throw new Error('本批实验尚未确认')
    if(c.members.length>c.maxRuns||!c.members.length)throw new Error('运行数量超过预算或为空')
    const members=[]
    const target=c.runTarget
    for(const [index,variant] of c.members.entries()){
      const marker=`[研究:${c.id}:${index}]`
      const draft=experimentTaskDraftSchema.parse({...c.baseline,...(target?{computeDevice:target.computeDevice??c.baseline.computeDevice,minimumFreeVramGiB:target.minimumFreeVramGiB??undefined,maximumGpuUtilizationPercent:target.maximumGpuUtilizationPercent??undefined}:{}),...(variant.outputDirectory?{artifactPath:variant.outputDirectory,outputDirectories:variant.outputDirectories}:{}),title:researchMemberTitle(c,variant),objective:c.objective,tags:[...new Set([...c.baseline.tags.slice(0,15),'对照实验'])],status:'planned',launchCommand:target?deviceLaunchCommand(variant.command,target.computeDevice??c.baseline.computeDevice??'gpu'):variant.command,resultSummary:'',notes:`${marker}\n来源任务：${c.sourceTaskId}\n${variant.key}\n${c.baseline.notes.slice(0,3000)}`})
      let task=this.store.listExperimentTasks().find(t=>t.notes.split('\n')[0]===marker)
      if(task && configIdentity(task)!==configIdentity(draft))throw new Error(`对照 ${index+1} 配置在确认后发生变化，已停止继续提交；请核对已有任务`)
      task??=await this.store.saveExperimentTask(draft)
      let run=task.runs.find(r=>r.notes.split('\n')[0]===marker)
      if(!run&&task.runs.length)throw new Error('对照任务已经存在其他运行，但无法核对本批去重标记；请审查已有记录后再继续')
      if(!run){
        task=await this.store.startExperimentRun(task.id,experimentRunStartInputSchema.parse({serverId:draft.serverId??null,accessRouteId:draft.accessRouteId??null,computeDevice:draft.computeDevice,gpuUuid:target?.gpuUuid??null,gpuIndex:target?.gpuIndex??null,gpuNameSnapshot:target?.gpuNameSnapshot??null,codePath:draft.codePath,dataPath:draft.dataPath,launchCommand:draft.launchCommand,launchMode:'command',scriptPath:'',condaEnvironment:draft.condaEnvironment??null,outputDirectories:draft.outputDirectories,artifactPath:draft.artifactPath,minimumFreeVramGiB:draft.minimumFreeVramGiB??null,maximumGpuUtilizationPercent:draft.maximumGpuUtilizationPercent??null,notes:`${marker}\n${variant.key}`}))
        run=task.runs.at(-1)!
      }
      members.push({...variant,command:draft.launchCommand,taskId:task.id,runId:run.id})
    }
    this.queueChanged()
    return {...c,members,stage:'waiting'}
  }
  private finished(c:ResearchCampaign):boolean{
    const tasks=this.store.listExperimentTasks()
    return c.members.length>0&&c.members.every(member=>{
      const run=tasks.find(t=>t.id===member.taskId)?.runs.find(r=>r.id===member.runId)
      if(!run)throw new Error('关联任务或运行已删除，无法继续收集；已有远程任务不会自动取消')
      return ['completed','failed','cancelled'].includes(run.status)
    })
  }
  async refresh(id:string):Promise<ResearchView>{
    await this.ready();z.string().uuid().parse(id);const current=await this.view(id)
    if(current.paused||current.retrySubmission)return current
    if(current.pending.includes('observe')){
      const tasks=this.store.listExperimentTasks()
      const newlyFinished=current.members.some(member=>{
        const run=tasks.find(task=>task.id===member.taskId)?.runs.find(run=>run.id===member.runId)
        const captured=this.book[id].captured?.find(item=>item.runId===member.runId)
        return run&&['completed','failed','cancelled'].includes(run.status)&&!(captured&&(captured.excerpt.trim()||captured.exitCode!==undefined||captured.status==='cancelled'))
      })
      if(newlyFinished||this.finished(current))await this.execute(id,async()=>{
        await this.collect(current,{onlyFinished:true})
        if(this.finished(current))await this.graph.invoke(new Command({resume:true}),this.config(id))
      })
    }else if(current.pending.length && !current.pending.includes('review'))await this.execute(id,()=>this.graph.invoke(null,this.config(id)))
    this.changed();return this.view(id)
  }
  async analyze(id:string):Promise<ResearchView>{
    await this.ready();const current=await this.view(z.string().uuid().parse(id));if(current.stage!=='analysis'||current.pending.length)throw new Error('等待本批运行结束后再分析')
    if(current.paused)throw new Error('先恢复流程，再分析结果')
    if(current.events.filter(e=>e.node==='result_analysis').length>=2)throw new Error('本批 AI 分析已达到次数上限，已有结果仍可查看和导出')
    await this.execute(id,async()=>this.graph.updateState(this.config(id),{campaign:event({...current,analysis:await this.analysis(current,true)},'result_analysis','用户请求 AI 分析结果')},'analyze'))
    return this.view(id)
  }
  async recollect(id:string,rawConfig?:ResultCollectionConfig):Promise<ResearchView>{
    await this.ready();const current=await this.view(z.string().uuid().parse(id))
    if(current.stage!=='analysis'||current.pending.length)throw new Error('等待本批运行结束后再重新采集')
    if(current.paused)throw new Error('先恢复流程，再重新采集')
    const collection={...current,resultConfig:normalizeResultConfig(rawConfig??current.resultConfig)}
    if(Object.keys(collection.resultConfig.runResultFiles??{}).some(runId=>!current.members.some(member=>member.runId===runId)))throw new Error('单独指定的结果文件不属于本批运行，请重新选择')
    const fromFiles=!!(collection.resultConfig.metricsFile||collection.resultConfig.resultFiles?.length||Object.keys(collection.resultConfig.runResultFiles??{}).length)
    if(fromFiles&&current.members.some(member=>{const config=resultConfigForRun(collection.resultConfig,member.runId??'');return !config.metricsFile&&!config.resultFiles?.length}))throw new Error('部分对照组尚未配置结果文件，请填写共用文件或为各组单独选择')
    // Explicit read-only refresh; it does not queue, retry or repair remote experiments.
    await this.execute(id,async()=>{
      const observations=await this.collect(collection,{force:true})
      for(const observation of observations)observation.diagnosisId=current.observations.find(old=>old.runId===observation.runId)?.diagnosisId
      const updated=event({...collection,observations,analysis:undefined},'recollect','用户重新采集结果文件、产物和退出码；未启动新运行')
      // Preserve the model call budget: refreshing evidence itself never calls the model.
      const analysis=await this.analysis({...updated,useModel:false})
      await this.graph.updateState(this.config(id),{campaign:{...updated,analysis}},'analyze')
    })
    return this.view(id)
  }
  private async collect(c:ResearchCampaign,options:{onlyFinished?:boolean;force?:boolean}={}):Promise<RunObservation[]>{
    const observations:RunObservation[]=[]
    for(const member of c.members){
      const task=this.task(member.taskId!),run=task.runs.find(r=>r.id===member.runId)
      if(!run)throw new Error('关联运行不存在')
      if(options.onlyFinished&&!['completed','failed','cancelled'].includes(run.status))continue
      const captured=this.book[c.id]?.captured?.find(item=>item.runId===run.id)
      if(!options.force&&captured&&(captured.excerpt.trim()||captured.exitCode!==undefined||captured.status==='cancelled')){observations.push(structuredClone(captured));continue}
      const observation:RunObservation={key:member.key,taskId:task.id,runId:run.id,status:run.status,evidenceId:`run-${run.id}`,metrics:{},excerpt:'',metricDetails:[],files:[],collectedAt:now()}
      if(run.status==='cancelled')observation.warning='运行已取消，未作为科学结果比较'
      else try{
        const server=this.store.getServer(run.serverId??task.serverId!),routeId=run.accessRouteId??task.accessRouteId??getDefaultAccessRouteId(server)
        if(server.mode!=='real'||!getAccessRoutes(server).some(r=>r.id===routeId))throw new Error('运行连接路径不可用')
        const profile=applyAccessRoute(server,routeId)
        if(!profile.hostFingerprint||(profile.jumpHost&&!profile.jumpHost.hostFingerprint))throw new Error('主机指纹尚未确认')
        const connected=await this.ssh.connect(profile,this.store.getSecrets(server.id))
        try{await collectRunResults(this.ssh,connected.client,{...run,codePath:run.codePath??task.codePath},observation,resultConfigForRun(c.resultConfig,run.id),member.outputDirectory)}
        finally{connected.client.end()}
      }catch(error){observation.warning=this.errorMessage(error)}
      observation.processState=processEvidenceState(observation);observation.evidenceState=evidenceState(observation)
      observations.push(observation)
      if(options.force)continue
      const cached=this.book[c.id].captured??=[]
      const oldIndex=cached.findIndex(item=>item.runId===observation.runId)
      if(oldIndex>=0)cached[oldIndex]=structuredClone(observation);else cached.push(structuredClone(observation))
      await this.persistBook()
    }
    return observations
  }
  private async analysis(c:ResearchCampaign,useModel=false):Promise<ResearchAnalysis>{
    const completed=c.observations.filter(o=>processEvidenceState(o)==='completed')
    const comparable=completed.filter(o=>!o.files?.some(file=>file.role==='metrics'&&(file.status!=='available'||!file.association||file.association==='unverified')))
    const columns=metricColumns(comparable)
    const observations=columns.slice(0,10).map(metric=>{
      const values=comparable.flatMap(o=>observationMetrics(o).filter(point=>metricIdentity(point)===metricIdentity(metric)).map(point=>point.value))
      return `${metric.name}（${metricContext(metric)}；${metric.source==='metrics_json'?'结构化文件':'日志末值'}）：记录 ${values.length} 次，范围 ${Math.min(...values)}～${Math.max(...values)}；只比较相同已声明口径，未声明部分仍需核对。`
    })
    const limitations=c.observations.some(o=>observationMetrics(o).some(metric=>metric.source==='log'))?['自动提取的指标来自结果末尾，不一定代表最佳评估结果。']:[]
    const hasFiles=c.observations.some(o=>o.files?.some(file=>file.role==='result'&&file.text))
    const fallback:ResearchAnalysis={engine:'rules',contentVersion:2,summary:columns.length?'已采集指标，可选择 AI 分析比较各组差异。':hasFiles?'已采集结果文件，可选择 AI 分析比较各组差异。':'尚未读取到可比较的结果，请检查所选结果内容。',observations,limitations,evidenceIds:c.observations.map(o=>o.evidenceId)}
    if(!useModel)return fallback
    try{
      const result=analysisSchema.parse(await this.intelligence.requestResearchModel(resultAnalysisPrompt,resultAnalysisPayload(c)))
      if(hasInternalAnalysisText(result))throw new Error('模型结果包含不适合展示的后台信息')
      const valid=new Set(c.observations.map(o=>o.evidenceId))
      if(result.evidenceIds.some(id=>!valid.has(id)))throw new Error('模型引用了不存在的运行证据')
      return {summary:result.summary,observations:result.observations,evidenceIds:result.evidenceIds,engine:'model',contentVersion:2,limitations:[]}
    }catch(error){console.warn('对照实验结果分析失败',this.errorMessage(error));return {...fallback,summary:'本次 AI 结果分析未完成，请重新分析。',observations:[],limitations:[]}}
  }
  async setPaused(id:string,paused:boolean):Promise<ResearchView>{await this.ready();z.string().uuid().parse(id);z.boolean().parse(paused);await this.view(id);if(this.running.has(id))throw new Error('当前节点正在处理，请完成后暂停');this.book[id].paused=paused;await this.persistBook();this.changed();if(!paused)this.wake();return this.view(id)}
  async start():Promise<void>{await this.ready();this.wake()}
  stop():void{if(this.timer)clearTimeout(this.timer);this.timer=undefined}
  wake():void{if(this.timer)return;this.timer=setTimeout(()=>{this.timer=undefined;void this.sweep().catch(error=>console.error('实验研究跟踪失败：',error))},150)}
  private async sweep():Promise<void>{for(const id of Object.keys(this.book)){if(!this.book[id]||this.book[id].deleted||this.running.has(id)||this.book[id].paused||this.book[id].error)continue;try{const current=await this.view(id);if(current.pending.length&&!current.pending.includes('review'))await this.refresh(id)}catch(error){if(this.book[id]&&!this.book[id].deleted){this.book[id].error=this.errorMessage(error);await this.persistBook();this.changed()}}}}
  async export(id:string):Promise<string|null>{
    await this.ready();const view=await this.view(z.string().uuid().parse(id))
    const result=await dialog.showSaveDialog({title:'导出实验研究记录',defaultPath:`LabDeck-research-${view.id.slice(0,8)}.json`,filters:[{name:'JSON',extensions:['json']}]})
    if(result.canceled||!result.filePath)return null
    await writeFile(result.filePath,JSON.stringify(view,null,2),'utf8');return result.filePath
  }
  registerIpc():void{
    ipcMain.handle('research:retryFailed',(_e,id,confirmed,target)=>this.retryFailed(id,confirmed,target))
    ipcMain.handle('research:recheckOutput',(_e,id)=>this.recheckOutput(id))
    ipcMain.handle('research:preview',(_e,command,axes,maxRuns)=>this.bridge.expand(z.string().max(20000).parse(command),axesSchema.parse(axes),z.number().int().min(1).max(32).parse(maxRuns)))
    ipcMain.handle('research:list',()=>this.list());ipcMain.handle('research:remove',(_e,id)=>this.remove(id));ipcMain.handle('research:removeBatch',(_e,id)=>this.removeBatch(id));ipcMain.handle('research:engine',()=>this.engine())
    ipcMain.handle('research:suggest',(_e,id,objective,max,runId)=>this.suggest(id,objective,max,runId))
    ipcMain.handle('research:create',(_e,input)=>this.create(input));ipcMain.handle('research:approve',(_e,id,confirmed,target)=>this.approve(id,confirmed,target))
    ipcMain.handle('research:refresh',(_e,id)=>this.refresh(id));ipcMain.handle('research:analyze',(_e,id)=>this.analyze(id));ipcMain.handle('research:recollect',(_e,id,config)=>this.recollect(id,config));ipcMain.handle('research:paused',(_e,id,paused)=>this.setPaused(id,paused));ipcMain.handle('research:export',(_e,id)=>this.export(id))
  }
}





