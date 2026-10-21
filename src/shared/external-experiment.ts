import { z } from 'zod'
import { isRepositoryLaunchCommand } from './repository-guide'
const absolute=(value:string):boolean=>value.startsWith('/')&&!/[\0\r\n]/.test(value)
export const externalExperimentSchema=z.object({
  serverId:z.string().uuid(),accessRouteId:z.string().max(80).optional(),
  logPath:z.string().trim().min(1).max(4096).refine(absolute,'日志路径必须是服务器绝对路径'),
  codePath:z.string().trim().max(4096).default('').refine(p=>!p||absolute(p),'代码目录必须是服务器绝对路径'),
  launchCommand:z.string().trim().max(20000).default(''),
  environmentName:z.string().trim().max(160).default('').refine(v=>!/[\0\r\n]/.test(v))
})
export type ExternalExperimentContext=z.infer<typeof externalExperimentSchema>
export interface ExternalLogSnapshot {
  segments?:{offset:number;length:number}[];selection?:'errors_and_tail'|'tail';collectedAt:string;modifiedAt?:string;sizeBytes:number;bytesRead:number;resolvedPath:string;truncated:boolean;changed:boolean
}
export const externalDraftSchema=z.object({
  title:z.string().trim().min(1).max(160),codePath:z.string().trim().min(1).max(4096).refine(absolute,'请填写服务器上的代码目录'),
  launchCommand:z.string().trim().min(1).max(20000).refine(isRepositoryLaunchCommand,'请拆分准备命令，仅保留一条受支持的训练或评估启动命令'),
  environmentName:z.string().trim().max(160).refine(v=>!/[\0\r\n]/.test(v)),
  dataPath:z.string().trim().max(4096).default('').refine(p=>!p||absolute(p),'数据目录必须是服务器绝对路径')
})
export type ExternalDraftInput=z.infer<typeof externalDraftSchema>
