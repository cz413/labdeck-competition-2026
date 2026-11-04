import { useState } from 'react'
import type { DiagnosisChange } from '@shared/diagnosis-diff'
import { diagnosisDiffText } from '@shared/diagnosis-diff'
export function DiagnosisChanges({changes}:{changes:DiagnosisChange[]}):React.JSX.Element|null {
  const [message,setMessage]=useState('')
  async function copy(text:string):Promise<void>{try{await window.labApi.clipboard.writeText(text);setMessage('已复制')}catch{setMessage('复制未完成，请选中代码手动复制。')}}
  if(!changes.length)return null
  return <section className="diagnosis-changes"><h4>修改前后对比</h4><p className="smart-note">按标注位置替换对应内容；修改建议尚未运行验证。</p>{changes.map((change,index)=><article className="diagnosis-change" key={index}><header><strong>{change.file}{change.kind==='file'?` · 第 ${change.startLine} 行起`:''}</strong><div><button type="button" className="wb-text-button" onClick={()=>void copy(change.after)}>复制修改后内容</button><button type="button" className="wb-text-button" onClick={()=>void copy('```diff\n'+diagnosisDiffText(change)+'\n```')}>复制 Diff</button></div></header><pre aria-label={`${change.file} 修改对比`}>{diagnosisDiffText(change).split('\n').map((line,i)=><span key={i} className={i<3?'diff-meta':line.startsWith('-')?'diff-remove':'diff-add'}>{line||' '}</span>)}</pre></article>)}{message&&<p role="status">{message}</p>}</section>
}
