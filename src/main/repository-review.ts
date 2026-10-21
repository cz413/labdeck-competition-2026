import { z } from 'zod'
import { isRepositoryLaunchCommand, repositoryReviewQuestions } from '../shared/repository-guide'
import type { RepositoryGuide, RepositoryReviewInput } from '../shared/repository-guide'
export const repositoryReviewSchema=z.object({launchCommand:z.string().trim().min(1).max(4000).refine(isRepositoryLaunchCommand,'请填写单条受支持的启动命令'),workingDirectory:z.string().max(512).refine(v=>!v.startsWith('/')&&!v.includes('\\')&&!v.split('/').includes('..')&&!/[\0\r\n:]/.test(v),'启动子目录必须在当前仓库内'),environmentName:z.string().trim().max(160).refine(v=>!/[\0\r\n]/.test(v)),dataPath:z.string().trim().max(4096).refine(v=>!v||v.startsWith('/')&&!/[\0\r\n]/.test(v),'数据目录必须是服务器绝对路径'),resolutions:z.array(z.object({question:z.string().max(1200),answer:z.string().trim().max(1200)})).max(40)})
export function reviewRepositoryGuide(base:RepositoryGuide,raw:RepositoryReviewInput):RepositoryGuide {
  const input=repositoryReviewSchema.parse(raw)
  const unresolved=repositoryReviewQuestions(base).filter(question=>!input.resolutions.some(r=>r.question===question&&r.answer.trim()))
  if(/<[^>]+>|\$\{|\b(?:YOUR_[A-Z_]+|TODO|REPLACE_ME)\b|\/(?:path\/to|your\/path)(?:\/|$)/i.test(input.launchCommand+' '+input.dataPath))unresolved.push('启动配置中仍有待替换的占位符。')
  const changed=input.launchCommand!==base.launchCommand||input.workingDirectory!==base.workingDirectory
  return {...base,...input,launchOrigin:changed?'user':base.launchOrigin,launchCitations:changed?[]:base.launchCitations,launchSources:changed?[]:base.launchSources,checks:[],missingInputs:unresolved,status:unresolved.length?'needs_info':'ready_for_review',warnings:[...new Set([...base.warnings,'本次配置和问题答复由用户补充，路径由系统只读核对；这不证明依赖、数据内容或实验效果已验证。'])]}
}
