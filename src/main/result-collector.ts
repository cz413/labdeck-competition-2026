import { z } from 'zod'
import { stripVTControlCharacters } from 'node:util'
import type { Client } from 'ssh2'
import type { SshService } from './ssh-service'
import type { ExperimentRun } from '../shared/types'
import type { RunObservation } from '../shared/research'
import type { ResultCollectionConfig } from '../shared/research-results'
import { MAX_RESULT_BYTES, evidenceState, legacyMetricValues, normalizeResultConfig, parseStructuredMetrics, processEvidenceState, resolveResultPath } from '../shared/research-results'
import { parseMetricLog } from '../shared/parameter-engine'
import { redactSecrets } from '../shared/diagnosis-engine'

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
const fileSchema = z.object({
  path: z.string().max(4096), status: z.enum(['available','missing','unreadable','unsupported','too_large','changed']),
  kind: z.enum(['file','directory']).optional(), sizeBytes: z.number().int().nonnegative().optional(),
  truncated:z.boolean().optional(), modifiedAt: z.string().datetime({offset:true}).optional(), resolvedPath: z.string().optional(), content: z.string().max(180000).optional()
})
const filesSchema = z.array(fileSchema).max(9)
// Fixed read-only program. Paths are JSON arguments, never executable code. No training files are imported.
export const RESULT_FILES_SCRIPT = String.raw`
import os, sys, json, stat, base64, datetime
request = json.loads(sys.argv[1])
limit = 131072
text_budget = 262144
text_files = sum(1 for item in request if item.get('text'))
results = []
for item in request:
    text_share = min(65536, text_budget // max(text_files, 1))
    if item.get('text'):
        text_files -= 1
    path = item['path']
    result = {'path': path, 'status': 'unreadable'}
    try:
        info = os.lstat(path)
        result.update(sizeBytes=info.st_size, modifiedAt=datetime.datetime.fromtimestamp(info.st_mtime, datetime.timezone.utc).isoformat(), resolvedPath=os.path.realpath(path))
        if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            result['status'] = 'unsupported'
        elif stat.S_ISDIR(info.st_mode):
            result.update(kind='directory', status='unsupported' if item['metrics'] or item.get('text') else 'available')
        elif item['metrics'] and info.st_size > limit:
            result.update(kind='file', status='too_large')
        else:
            result.update(kind='file', status='available')
            if item['metrics'] or item.get('text'):
                fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
                with os.fdopen(fd, 'rb') as stream:
                    before = os.fstat(stream.fileno())
                    if not stat.S_ISREG(before.st_mode) or before.st_ino != info.st_ino or before.st_dev != info.st_dev:
                        result['status'] = 'changed'
                    else:
                        amount = text_share if item.get('text') else limit
                        offset = max(0, before.st_size - amount) if item.get('text') else 0
                        if offset:
                            stream.seek(offset)
                        data = stream.read(amount if item.get('text') else limit + 1)
                        if item.get('text'):
                            text_budget -= len(data)
                            result['truncated'] = offset > 0
                            if amount == 0:
                                result['status'] = 'too_large'
                        after = os.fstat(stream.fileno())
                        if result['status'] == 'too_large' or len(data) > limit:
                            result['status'] = 'too_large'
                        elif before.st_mtime_ns != after.st_mtime_ns or before.st_size != after.st_size:
                            result['status'] = 'changed'
                        else:
                            result['content'] = base64.b64encode(data).decode('ascii')
    except FileNotFoundError:
        result['status'] = 'missing'
    except (OSError, ValueError, OverflowError):
        result['status'] = 'unreadable'
    results.append(result)
sys.stdout.write('__LABDECK_RESULT_FILES__' + json.dumps(results, ensure_ascii=True, allow_nan=False))
`
function message(error: unknown): string { return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0,800) }
function addWarning(observation: RunObservation, text: string): void { observation.warning = [observation.warning,text].filter(Boolean).join('；') }
const fileMessages: Record<string,string> = {
  missing: '指定路径不存在', unreadable: '无法读取，检查权限、连接和远程 Python 3',
  unsupported: '结果须为普通文件；不读取目录、符号链接或特殊文件', too_large: '指标文件超过 128 KiB 限制',
  changed: '采集期间文件发生变化，请重新采集', invalid: '指标内容不符合 JSON 协议'
}
export async function collectRunResults(ssh: SshService, client: Client, run: ExperimentRun, observation: RunObservation, rawConfig?: ResultCollectionConfig,outputDirectory?:string): Promise<RunObservation> {
  const config = normalizeResultConfig(rawConfig)
  observation.collectedAt = new Date().toISOString()
  observation.metricDetails = []
  observation.files = []
  if (run.logPath?.startsWith('/') && !/[\x00-\x1f\x7f]/.test(run.logPath)) {
    try {
      const log = await ssh.exec(client, `if [ -f ${quote(run.logPath)} ]; then tail -n 240 -- ${quote(run.logPath)} | tail -c 65536; fi`,15000)
      observation.excerpt = redactSecrets(log).slice(-16000)
      if (!config.metricsFile&&!config.resultFiles?.length) observation.metricDetails = Object.entries(parseMetricLog(log.slice(-65536))).map(([name,value]) => ({name,value,source:'log',sourcePath:run.logPath!}))
      if (!log.trim()) addWarning(observation,'本次未取得日志片段')
    } catch (error) { addWarning(observation,`日志：${message(error)}`) }
  } else addWarning(observation,'未记录可读取的远程日志路径')
  // Exit code and configured evidence are independent of whether a log is available.
  if (run.remoteRunDir?.startsWith('/') && !/[\x00-\x1f\x7f]/.test(run.remoteRunDir)) {
    try {
      const path = run.remoteRunDir + '/exit-code'
      const raw = await ssh.exec(client, `if [ -f ${quote(path)} ]; then printf '__LABDECK_EXIT__'; cat -- ${quote(path)}; fi`,10000)
      const match = /^__LABDECK_EXIT__(\d{1,3})\s*$/.exec(raw.trim())
      if (match && Number(match[1]) <= 255) observation.exitCode = Number(match[1])
    } catch (error) { addWarning(observation,`退出码：${message(error)}`) }
  }
  if (observation.exitCode === undefined) addWarning(observation,'本次未读取到远程退出码，进程状态待确认')
  if ((run.status === 'completed' && observation.exitCode !== undefined && observation.exitCode !== 0) || (run.status === 'failed' && observation.exitCode === 0)) addWarning(observation,'任务记录与远程退出码冲突，请核对运行')
  const requests: {path:string;metrics:boolean;text:boolean}[] = []
  for (const [template,role] of [[config.metricsFile,'metrics'], ...config.artifacts.map(path => [path,'artifact']),...(config.resultFiles??[]).map(path=>[path,'result'])] as [string,'metrics'|'artifact'|'result'][]) {
    if (!template) continue
    try {
      const path = resolveResultPath(template,{...run,codePath:outputDirectory??run.codePath})
      requests.push({path,metrics:role==='metrics',text:role==='result'})
      observation.files.push({path,role,status:'unreadable'})
    } catch (error) { observation.files.push({path:template,role,status:'invalid',message:message(error)}); addWarning(observation,message(error)) }
  }
  if (requests.length) {
    try {
      const argumentsJson = JSON.stringify(requests)
      const command = `if command -v python3 >/dev/null 2>&1; then python3 -I -c ${quote(RESULT_FILES_SCRIPT)} ${quote(argumentsJson)}; elif command -v python >/dev/null 2>&1; then python -I -c ${quote(RESULT_FILES_SCRIPT)} ${quote(argumentsJson)}; else exit 127; fi`
      const output = await ssh.exec(client,command,15000)
      if (!output.startsWith('__LABDECK_RESULT_FILES__') || output.length > 500000) throw new Error('结果文件采集响应不符合协议')
      const files = filesSchema.parse(JSON.parse(output.slice('__LABDECK_RESULT_FILES__'.length)))
      if (files.length !== requests.length || files.some((file,i) => file.path !== requests[i].path)) throw new Error('结果文件采集路径与请求不一致')
      for (const [index,file] of files.entries()) {
        const requested = requests[index]
        const target = observation.files.find(item => item.path === file.path && item.role === (requested.metrics?'metrics':requested.text?'result':'artifact'))!
        const {content, ...metadata} = file
        Object.assign(target,metadata)
        if(file.status==='missing'){delete target.kind;delete target.sizeBytes;delete target.modifiedAt;delete target.resolvedPath}
        target.association = file.status==='missing'||!file.kind ? undefined : run.remoteRunDir && (file.resolvedPath ?? file.path).startsWith(run.remoteRunDir.replace(/\/$/,'')+'/') ? 'run_directory' : 'unverified'
        if(outputDirectory&&file.resolvedPath?.startsWith(outputDirectory.replace(/\/$/,'')+'/'))target.association='output_directory'
        if (file.status !== 'available') target.message = fileMessages[file.status]
        if(requested.text&&file.status==='available'){
          try{
            if(content===undefined)throw new Error('未取得文件内容')
            const bytes=Buffer.from(content,'base64')
            if(bytes.length>65536)throw new Error('文件片段超过读取范围')
            let offset=0
            if(file.truncated)while(offset<Math.min(4,bytes.length)&&(bytes[offset]&0xc0)===0x80)offset++
            const text=stripVTControlCharacters(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(offset)))
            if(/[\x00-\x08\x0e-\x1f]/.test(text))throw new Error('不是可读取的文本结果文件')
            target.text=redactSecrets(text).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,'[私钥已隐藏]')
            if(!text.trim())target.message='文件为空，暂无结果内容'
            else if(file.truncated)target.message='文件较大，仅采集末尾片段'
          }catch(error){target.status='invalid';target.message='无法作为 UTF-8 文本读取，请提供文本日志或导出的文本结果'}
        }
        if (requested.metrics && file.status === 'available') {
          try {
            if (content === undefined) throw new Error('指标响应缺少文件内容')
            const bytes = Buffer.from(content,'base64')
            if (bytes.length > MAX_RESULT_BYTES) throw new Error('指标文件超过 128 KiB 限制')
            const raw = new TextDecoder('utf-8',{fatal:true}).decode(bytes)
            const parsed = parseStructuredMetrics(raw,file.path,run.id)
            observation.metricDetails = parsed.metrics.map(metric => ({...metric, dataset:metric.dataset?redactSecrets(metric.dataset):undefined,split:metric.split?redactSecrets(metric.split):undefined,unit:metric.unit?redactSecrets(metric.unit):undefined}))
            if (parsed.runId) target.association = 'run_id'
          } catch (error) { target.status = 'invalid'; target.message = message(error instanceof z.ZodError ? new Error('指标文件字段不符合协议，请核对数值、口径和格式') : error) }
        }
        if (file.modifiedAt && run.startedAt && Date.parse(file.modifiedAt) < Date.parse(run.startedAt)-5000) {
          target.association = 'unverified'
          target.message = [target.message,'文件修改时间早于运行开始时间，可能是旧文件或存在服务器时钟偏差'].filter(Boolean).join('；')
        }
        if (target.status === 'available' && target.association === 'unverified') target.message = [target.message,'已读取，但未确认文件归属本次运行'].filter(Boolean).join('；')
        if (target.message) addWarning(observation,`${target.path}：${target.message}`)
      }
    } catch (error) {
      for (const file of observation.files.filter(file => file.status === 'unreadable')) file.message = `文件采集：${message(error)}`
      addWarning(observation,`文件采集：${message(error)}`)
    }
  }
  observation.metrics = legacyMetricValues(observation.metricDetails)
  observation.processState = processEvidenceState(observation)
  observation.evidenceState = evidenceState(observation)
  return observation
}
/** Keep evidence from every run/file while limiting model context size. */
export function researchModelEvidence(observations:RunObservation[]):RunObservation[] {
  const perRun=Math.floor(100000/Math.max(1,observations.length))
  return observations.map(observation=>{
    const sourceCount=1+(observation.files??[]).filter(file=>file.text!==undefined).length
    const perSource=Math.floor(perRun/sourceCount)
    return {...observation,excerpt:observation.excerpt.slice(-perSource),files:observation.files?.map(file=>({...file,...(file.text!==undefined?{text:file.text.slice(-perSource),truncated:file.truncated||file.text.length>perSource}:{})}))}
  })
}
