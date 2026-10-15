import { evidenceState, parseStructuredMetrics, processEvidenceState } from './research-results'
import type { ParameterExpansion, ResearchView, RunObservation } from './research'
export const researchDemoAxes=[{flag:'--lr',values:['0.001','0.0001']},{flag:'--seed',values:['42','43']}]
export const researchDemoCommand='python train.py --lr 0.01 --batch-size 16'
export function createResearchDemo(expansion:ParameterExpansion):ResearchView {
  const stamp=new Date().toISOString()
  return {id:crypto.randomUUID(),createdAt:stamp,updatedAt:stamp,objective:'【模拟】比较学习率对训练稳定性的影响',sourceTaskId:'demo-source',baseline:{title:'【模拟】对照实验',project:'离线演示',objective:'比较学习率',tags:[],priority:'normal',status:'planned',codePath:'/workspace/vision',dataPath:'/datasets/vision',launchCommand:researchDemoCommand,launchMode:'command',scriptPath:'',artifactPath:'',resultSummary:'',notes:'临时演示'},axes:researchDemoAxes,maxRuns:4,useModel:false,resultConfig:{metricsFile:'{runDir}/metrics.json',artifacts:['{runDir}/model.pt']},stage:'review',members:expansion.variants,expansionEngine:expansion.engine,warnings:[...expansion.warnings,'参数由实际配置引擎展开；运行、指标与流程状态为模拟，不连接服务器、不调用模型、不保存研究记录。'],observations:[],events:[{at:stamp,node:'expand',message:'实际展开四份参数配置；后续为临时模拟流程'}],paused:false,pending:['review']}
}
export function queueResearchDemo(current:ResearchView):ResearchView {
  if(current.stage!=='review')return current
  return {...current,stage:'waiting',pending:['observe'],approvedAt:new Date().toISOString(),events:[...current.events,{at:new Date().toISOString(),node:'review',message:'用户确认模拟本批入队'},{at:new Date().toISOString(),node:'queue',message:'模拟四份配置入队，未创建实际任务'}]}
}
export function finishResearchDemo(current:ResearchView,withFault:boolean):ResearchView {
  if(current.stage!=='waiting')return current
  const stamp=new Date().toISOString(),observations=current.members.map<RunObservation>((m,i)=>({key:m.key,taskId:`demo-task-${i}`,runId:`demo-run-${i}`,status:withFault&&i===0?'failed':'completed',evidenceId:`demo-evidence-${i}`,exitCode:withFault&&i===0?1:0,metrics:withFault&&i===0?({} as Record<string,number>):{val_loss:[0.84,0.88,1.15,1.12][i],val_accuracy:[0.76,0.74,0.67,0.69][i]},excerpt:withFault&&i===0?'【模拟日志】CUDA out of memory':'【模拟日志】'+JSON.stringify({val_loss:[0.84,0.88,1.15,1.12][i],val_accuracy:[0.76,0.74,0.67,0.69][i]})}))
  for(const [index,observation] of observations.entries()){
    const path=`/demo/${observation.runId}/metrics.json`
    observation.collectedAt=stamp
    observation.metricDetails=observation.status==='failed'?[]:parseStructuredMetrics(JSON.stringify({schemaVersion:1,runId:observation.runId,dataset:'【模拟】vision-v1',split:'validation',epoch:12,metrics:Object.fromEntries(Object.entries(observation.metrics).map(([name,value])=>[name,{value,unit:name.includes('accuracy')?'ratio':'dimensionless',direction:name.includes('loss')?'minimize':'maximize'}]))}),path,observation.runId).metrics
    observation.files=[{path,role:'metrics',status:observation.status==='failed'?'missing':'available',association:'run_directory',modifiedAt:stamp},
      {path:`/demo/${observation.runId}/model.pt`,role:'artifact',status:index===3||observation.status==='failed'?'missing':'available',association:'run_directory',kind:'file',sizeBytes:1024,modifiedAt:stamp}]
    if(index===3)observation.warning='【模拟】预期产物不存在，作为证据缺口，不判为运行故障'
    observation.processState=processEvidenceState(observation);observation.evidenceState=evidenceState(observation)
  }
  return {...current,stage:'analysis',pending:[],observations,analysis:{engine:'rules',summary:withFault?'模拟：一项运行显存不足，三项正常结束。故障与科学结果分别记录。':'模拟：四项正常结束，较小学习率的验证损失更高；指标变差仍属于正常实验观察。',observations:['当前模拟结果中，学习率 0.0001 的验证损失高于 0.001。','两个 seed 仅用于演示复现比较，不能证明统计显著性。'],limitations:['所有指标与退出码均为预设模拟数据，不能用于评价真实模型。','此演示不调用大模型，不保存检查点；实际实验流程使用 LangGraph 持久化。'],evidenceIds:observations.map(o=>o.evidenceId)},events:[...current.events,{at:stamp,node:'observe',message:'模拟本批运行结束'},{at:stamp,node:'collect',message:'展示预设指标和模拟退出码'},...(withFault?[{at:stamp,node:'diagnose',message:'模拟识别显存故障；未调用实际诊断服务'}]:[]),{at:stamp,node:'analyze',message:'展示模拟结果观察，不按目标阈值判定失败'}]}
}


