import { tokenizeTrainingCommand } from './parameter-engine'
export interface ResearchCommandReview {command?:string;preferredGpuIndex?:number;notes:string[];issue?:string}
/** Normalize only equivalent wrappers supported by the platform; never execute arbitrary shell. */
export function reviewResearchCommand(command:string,launchMode?:string):ResearchCommandReview {
  if(launchMode==='script')return {notes:[],issue:'当前为脚本文件模式，需要根据脚本内容判断能否生成参数化的 Python 命令。'}
  try{tokenizeTrainingCommand(command);return {command:command.trim(),notes:[]}}catch{/* Let the model see the original command and explain unsupported forms. */}
  let rest=command.trim(),preferredGpuIndex:number|undefined
  const notes:string[]=[]
  const gpu=rest.match(/^CUDA_VISIBLE_DEVICES=(\d+)\s+/)
  if(gpu){preferredGpuIndex=Number(gpu[1]);rest=rest.slice(gpu[0].length);notes.push(`原命令指定 GPU ${preferredGpuIndex}，设备绑定由运行选择窗口处理。`)}
  if(/^(python(?:3(?:\.\d+)?)?)\s+-u\s+/.test(rest)){rest=rest.replace(/^(python(?:3(?:\.\d+)?)?)\s+-u\s+/,'$1 ');notes.push('python -u 对应的无缓冲输出由平台开启。')}
  try{tokenizeTrainingCommand(rest);return {command:rest,preferredGpuIndex,notes}}catch{return {notes:[],issue:'当前命令不能直接展开参数，请结合源码说明可用的启动方式；不要擅自丢弃 shell 操作、环境变量或必要参数。'}}
}
