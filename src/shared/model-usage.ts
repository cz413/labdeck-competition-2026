export interface ModelUsage { requests:number; elapsedMs:number; promptTokens?:number; completionTokens?:number; totalTokens?:number }
export function sumModelUsage(items:ModelUsage[]):ModelUsage {
  const sum=(key:'promptTokens'|'completionTokens'|'totalTokens'):number|undefined=>items.length&&items.every(item=>item[key]!==undefined)?items.reduce((n,item)=>n+(item[key]??0),0):undefined
  return {requests:items.reduce((n,item)=>n+item.requests,0),elapsedMs:items.reduce((n,item)=>n+item.elapsedMs,0),promptTokens:sum('promptTokens'),completionTokens:sum('completionTokens'),totalTokens:sum('totalTokens')}
}
