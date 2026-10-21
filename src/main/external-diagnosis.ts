import { selectDiagnosticLog } from './log-selection'
import type { SFTPWrapper, Stats } from 'ssh2'
import { applyAccessRoute, getAccessRoutes, getDefaultAccessRouteId } from '../shared/access-routes'
import { externalExperimentSchema } from '../shared/external-experiment'
import type { ExternalExperimentContext, ExternalLogSnapshot } from '../shared/external-experiment'
import type { AppStore } from './store'
import type { SshService } from './ssh-service'
export const EXTERNAL_LOG_MAX_BYTES=65536
export const EXTERNAL_LOG_SCAN_BYTES=262144
export async function readExternalTail(sftp:SFTPWrapper,path:string,signal?:AbortSignal):Promise<{text:string;snapshot:ExternalLogSnapshot}> {
  signal?.throwIfAborted()
  const stat=await new Promise<Stats>((resolve,reject)=>sftp.lstat(path,(error,value)=>error?reject(error):resolve(value)))
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error('日志必须是普通文件，不读取目录、软链接或特殊文件')
  const resolvedPath=await new Promise<string>((resolve,reject)=>sftp.realpath(path,(error,value)=>error?reject(error):resolve(value)))
  const handle=await new Promise<Buffer>((resolve,reject)=>sftp.open(path,'r',(error,value)=>error?reject(error):resolve(value)))
  try {
    const before=await new Promise<Stats>((resolve,reject)=>sftp.fstat(handle,(error,value)=>error?reject(error):resolve(value)))
    if(!before.isFile())throw new Error('日志不是普通文件')
    const ranges=before.size<=EXTERNAL_LOG_SCAN_BYTES?[{offset:0,length:before.size}]:[{offset:0,length:EXTERNAL_LOG_SCAN_BYTES-EXTERNAL_LOG_MAX_BYTES},{offset:before.size-EXTERNAL_LOG_MAX_BYTES,length:EXTERNAL_LOG_MAX_BYTES}]
    const chunks:{text:string;label:string}[]=[]
    let bytesRead=0
    for(const range of ranges){
      const buffer=Buffer.alloc(range.length);let count=0
      while(count<range.length){
        signal?.throwIfAborted()
        const n=await new Promise<number>((resolve,reject)=>sftp.read(handle,buffer,count,Math.min(32768,range.length-count),range.offset+count,(error,n)=>error?reject(error):resolve(n)))
        if(!n)break
        count+=n;bytesRead+=n
      }
      const raw=buffer.subarray(0,count).toString('utf8')
      if(raw.includes('\0'))throw new Error('所选日志不是受支持的文本文件')
      const text=range.offset>0&&raw.includes('\n')?raw.slice(raw.indexOf('\n')+1):raw
      chunks.push({text,label:`文件字节 ${range.offset}–${range.offset+count}`})
    }
    signal?.throwIfAborted()
    const after=await new Promise<Stats>((resolve,reject)=>sftp.fstat(handle,(error,value)=>error?reject(error):resolve(value)))
    const selected=selectDiagnosticLog(chunks)
    return {text:selected.text,snapshot:{collectedAt:new Date().toISOString(),modifiedAt:Number.isFinite(after.mtime)?new Date(after.mtime*1000).toISOString():undefined,sizeBytes:after.size,bytesRead,resolvedPath,truncated:before.size>EXTERNAL_LOG_SCAN_BYTES||selected.text.length<chunks.reduce((n,chunk)=>n+chunk.text.length,0),changed:before.size!==after.size||before.mtime!==after.mtime,segments:ranges,selection:selected.selectedErrors?'errors_and_tail':'tail'}}
  } finally {await new Promise<void>(resolve=>sftp.close(handle,()=>resolve()))}
}
export async function collectExternalLog(store:AppStore,ssh:SshService,raw:ExternalExperimentContext,signal?:AbortSignal):Promise<{context:ExternalExperimentContext;serverName:string;text:string;snapshot:ExternalLogSnapshot}> {
  const input=externalExperimentSchema.parse(raw),server=store.getServer(input.serverId)
  if(server.mode!=='real')throw new Error('请选择实际服务器；示例节点不能读取手动实验日志')
  const route=input.accessRouteId??getDefaultAccessRouteId(server)
  if(!getAccessRoutes(server).some(r=>r.id===route))throw new Error('所选 SSH 连接路径不存在')
  const profile=applyAccessRoute(server,route)
  if(!profile.hostFingerprint||(profile.jumpHost&&!profile.jumpHost.hostFingerprint))throw new Error('请先在资源页连接服务器并确认主机指纹')
  signal?.throwIfAborted()
  const connected=await ssh.connect(profile,store.getSecrets(server.id))
  let cancelRead:(()=>void)|undefined
  const abort=()=>{connected.client.end();cancelRead?.()}
  signal?.addEventListener('abort',abort,{once:true})
  let timer:ReturnType<typeof setTimeout>|undefined
  try {
    const result=await new Promise<{text:string;snapshot:ExternalLogSnapshot}>((resolve,reject)=>{
      cancelRead=()=>reject(signal?.reason??new Error('诊断已停止'))
      timer=setTimeout(()=>{reject(new Error('读取日志超时，请检查连接或缩小日志范围'));connected.client.end()},15000)
      if(signal?.aborted){reject(new Error('诊断已停止'));return}
      connected.client.sftp((error,sftp)=>{
        if(error){reject(error);return}
        readExternalTail(sftp,input.logPath,signal).then(resolve,reject)
      })
    })
    return {...result,context:{...input,accessRouteId:route},serverName:server.name}
  } finally {if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);connected.client.end()}
}
