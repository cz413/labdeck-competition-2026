import type { PreparationView } from '@shared/preparation'

const kindNames={step:'流程步骤',tool:'实际检查',model:'模型调用',user:'方案操作'}
const statusNames={running:'进行中',completed:'已完成',warning:'需留意',failed:'未完成',cancelled:'已暂停'}
export function PreparationTimeline({view}:{view:PreparationView|null}):React.JSX.Element {
  const events=view?.trace??[],calls=events.filter(e=>e.kind==='model'),requests=view?.usage?.requests??calls.reduce((n,e)=>n+(e.usage?.requests??0),0)
  const measured=view?.usage!==undefined||calls.every(event=>event.status==='running'||event.usage?.requests!==undefined)
  const known=calls.length>0&&calls.every(e=>e.usage?.totalTokens!==undefined)
  const tokens=view?.usage?view.usage.totalTokens:(known?calls.reduce((n,e)=>n+(e.usage?.totalTokens??0),0):undefined)
  const active=[...events].reverse().find(e=>e.status==='running'),latest=active??events.at(-1)
  return <section className="preparation-timeline" aria-label="分析过程">
    <header><div><h3>分析过程</h3><p role="status">{latest?`${latest.name} · ${latest.status==='running'?latest.summary:statusNames[latest.status]}`:'等待开始项目理解'}</p></div><span>{view?.busy?'进度会自动保存':view?'准备记录已保存在本机':''}</span></header>
    <div className="preparation-trace-stats"><span>模型请求 <strong>{measured?requests:'未提供'}</strong>{measured?' 次':''}</span><span>Token <strong>{tokens===undefined?'未提供':tokens.toLocaleString()}</strong></span><span>模型耗时 <strong>{((view?.usage?.elapsedMs??calls.reduce((n,e)=>n+(e.usage?.elapsedMs??0),0))/1000).toFixed(1)}</strong> 秒</span></div>
    <details><summary>展开步骤、文件依据与用量（最近 {events.length} 项）</summary><ol>{events.map(event=><li key={event.id} className={`trace-${event.status}`}><div className="preparation-trace-line"><strong>{event.name}</strong><span>{kindNames[event.kind]} · {statusNames[event.status]}</span><time>{new Date(event.startedAt).toLocaleTimeString('zh-CN')}</time>{event.elapsedMs!==undefined&&<small>{event.elapsedMs<1000?`${event.elapsedMs} ms`:`${(event.elapsedMs/1000).toFixed(1)} s`}</small>}</div><p>{event.summary}</p>{event.references?.length? <div className="preparation-trace-refs">{event.references.map((ref,i)=><code key={i}>{ref.path}{ref.startLine?`:${ref.startLine}${ref.endLine&&ref.endLine!==ref.startLine?`–${ref.endLine}`:''}`:''}</code>)}</div>:null}{event.kind==='model'&&event.status!=='running'&&<small>输入 {event.usage?.promptTokens??'未提供'} / 输出 {event.usage?.completionTokens??'未提供'} tokens</small>}</li>)}</ol></details>
  </section>
}
