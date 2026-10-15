import type { RunObservation } from '@shared/research'
import { evidenceState, metricColumns, metricContext, metricIdentity, observationMetrics, processEvidenceState } from '@shared/research-results'
const processes = {completed:'正常结束（退出码已核对）',failed:'运行故障',cancelled:'已取消',unknown:'进程状态待确认'}
const evidence = {complete:'已取得所需证据',partial:'证据部分缺失或待核对',missing:'尚无结果证据'}
const fileStatus = {available:'已取得',missing:'不存在',unreadable:'无法读取',unsupported:'不支持的文件类型',too_large:'超过读取上限',changed:'采集时发生变化',invalid:'内容或路径无效'}
export function ResearchResults({observations}:{observations:RunObservation[]}):React.JSX.Element {
  const columns=metricColumns(observations)
  return <section className="research-observations" aria-label="结构化实验结果"><h3>记录到的实验结果</h3>
    <p className="research-note">分别查看运行状态、证据完整度和研究观察。指标按来源与口径分列；缺少元信息不能认定可直接比较。产物存在不代表模型有效，指标未提升不判运行失败。</p>
    <div className="research-table-wrap"><table className="research-table research-status-table"><thead><tr><th>配置</th><th>进程状态</th><th>结果证据</th><th>研究观察</th><th>退出码</th></tr></thead><tbody>{observations.map(o=>{
      const process=processEvidenceState(o),state=evidenceState(o),points=observationMetrics(o)
      return <tr key={o.runId}><td>{o.key}</td><td>{processes[process]}</td><td>{evidence[state]}</td><td>{process==='cancelled'?'已取消，未作结果比较':process==='failed'?'故障运行，指标仅供核对':process==='unknown'?'先核对运行状态':points.length?state==='complete'?'已有指标观察，不设达标阈值':'已记录指标，证据仍需核对':'尚无指标观察'}</td><td>{o.exitCode??'未取得'}</td></tr>
    })}</tbody></table></div>
    {columns.length>0&&<div className="research-table-wrap"><table className="research-table research-metric-table"><thead><tr><th>配置</th>{columns.map(metric=><th key={metricIdentity(metric)}><strong>{metric.name}</strong><span>{metricContext(metric)}</span><span>{metric.source==='metrics_json'?'结构化指标文件':'日志末值'}</span></th>)}</tr></thead><tbody>{observations.map(o=><tr key={o.runId}><td>{o.key}</td>{columns.map(metric=><td key={metricIdentity(metric)}>{observationMetrics(o).find(point=>metricIdentity(point)===metricIdentity(metric))?.value??'—'}</td>)}</tr>)}</tbody></table></div>}
    {observations.map(o=><details className="research-evidence" key={o.runId}><summary>{o.key} · 指标来源与运行证据{o.warning?' · 待核对':''}</summary>
      {o.collectedAt&&<p className="research-note">采集时间：{new Date(o.collectedAt).toLocaleString('zh-CN')}</p>}{o.warning&&<p>{o.warning}</p>}<code>{o.evidenceId}</code>
      {observationMetrics(o).length>0&&<ul className="research-metric-sources">{observationMetrics(o).map(metric=><li key={metricIdentity(metric)}><strong>{metric.name} = {metric.value}</strong><span>{metricContext(metric)}</span><code>{metric.source==='metrics_json'?'JSON 文件':'日志'}：{metric.sourcePath}</code></li>)}</ul>}
      {(o.files?.length??0)>0&&<div className="research-table-wrap"><table className="research-table research-file-table"><thead><tr><th>指定文件或目录</th><th>采集结果</th><th>大小 / 修改时间</th><th>运行归属</th></tr></thead><tbody>{o.files!.map((file,index)=><tr key={`${file.role}-${index}`}><td><span>{file.role==='metrics'?'指标文件':'预期产物'}</span><code>{file.path}</code>{file.resolvedPath&&file.resolvedPath!==file.path&&<code>实际路径：{file.resolvedPath}</code>}</td><td>{fileStatus[file.status]}{file.kind&&<span>{file.kind==='directory'?'目录（未统计目录总大小）':'文件'}</span>}{file.message&&<p>{file.message}</p>}</td><td>{file.kind==='file'&&file.sizeBytes!==undefined?`${file.sizeBytes.toLocaleString()} bytes`:'—'}<span>{file.modifiedAt?new Date(file.modifiedAt).toLocaleString('zh-CN'):'未取得修改时间'}</span></td><td>{file.association==='run_id'?'文件声明当前 runId':file.association==='run_directory'?'位于当前运行目录':'归属待核对'}</td></tr>)}</tbody></table></div>}
      <h4>日志片段</h4><pre>{o.excerpt||'未取得日志片段；指定指标文件和退出码会独立采集'}</pre>
    </details>)}
  </section>
}