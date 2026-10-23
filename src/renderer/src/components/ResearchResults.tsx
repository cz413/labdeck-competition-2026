import { userFacingError } from '@shared/user-facing-error'
import { ChevronDown } from 'lucide-react'
import type { RunObservation } from '@shared/research'
import type { ResultCollectionConfig, ResultFileEvidence } from '@shared/research-results'
import { observationMetrics } from '@shared/research-results'

const fileStatus:Record<ResultFileEvidence['status'],string>={available:'未读到内容',missing:'文件不存在',unreadable:'无法读取',unsupported:'不支持的文件类型',too_large:'超过读取范围',changed:'文件正在变化，请重新采集',invalid:'内容或路径无法读取'}
export function ResearchResults({observations,config}:{observations:RunObservation[];config?:ResultCollectionConfig}):React.JSX.Element {
  const rows=observations.map(observation=>{
    const files=(observation.files??[]).filter(file=>file.role==='result'||file.role==='metrics')
    const fromFiles=!!(config?.resultFiles?.length||config?.metricsFile||files.length)
    const metrics=observationMetrics(observation)
    const readable=files.filter(file=>file.status==='available'&&(file.text?.trim()||(file.role==='metrics'&&metrics.length)))
    const hasContent=fromFiles?readable.length>0:!!observation.excerpt.trim()
    const state=fromFiles?readable.length===files.length&&files.length>0?'已采集':readable.length>0?'部分文件已采集':files.some(file=>file.status==='missing')?'文件不存在':'未读到内容':hasContent?'已采集':'未读到内容'
    return {observation,files,fromFiles,metrics,hasContent,state}
  })
  const empty=rows.every(row=>!row.hasContent&&!row.files.length)
  return <section className="research-observations research-collected-results" aria-label="采集结果"><h3>采集结果</h3>
    {empty?<p className="research-note">尚未读取到结果，请选择结果来源后检查并采集。</p>:rows.map(({observation,files,fromFiles,metrics,hasContent,state})=><details className="research-collected-row" key={observation.runId}>
      <summary><strong>{observation.key}</strong><span>{fromFiles?`${files.length||config?.resultFiles?.length||1} 个结果文件`:'控制台输出'}</span><em className={hasContent&&state==='已采集'?'collected':'needs-attention'}>{state}</em><ChevronDown size={14}/></summary>
      <div className="research-collected-content">
        {observation.collectedAt&&<p className="research-note">采集于 {new Date(observation.collectedAt).toLocaleString('zh-CN')}</p>}
        {fromFiles?files.length?files.map((file,index)=><section className="research-collected-file" key={`${file.path}:${index}`}>
          <header><code>{file.path}</code><span>{file.status==='available'&&(file.text?.trim()||(file.role==='metrics'&&metrics.length))?'已采集':fileStatus[file.status]}{file.truncated?' · 末尾片段':''}</span></header>
          {file.message&&<p className="research-note">{userFacingError(file.message,'结果文件读取遇到问题，请检查路径及文件内容。')}</p>}
          {file.text!==undefined&&<pre>{file.text||'文件为空'}</pre>}
          {file.role==='metrics'&&file.status==='available'&&metrics.length>0&&<pre>{metrics.map(metric=>`${metric.name}: ${metric.value}`).join('\n')}</pre>}
        </section>):<p className="research-note">未读取到结果文件，请检查路径后重新采集。</p>:<pre>{observation.excerpt||'未读取到控制台输出，请重新采集或选择结果日志文件。'}</pre>}
      </div>
    </details>)}
  </section>
}
