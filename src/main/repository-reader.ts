import { posix } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { z } from 'zod'
import { applyAccessRoute, getAccessRoutes, getDefaultAccessRouteId } from '../shared/access-routes'
import { redactSecrets } from '../shared/diagnosis-engine'
import type { RepositoryFile, RepositoryInput, RepositorySnapshot, RepositoryPathCheck, RepositoryExcerpt } from '../shared/repository-guide'
import type { AppStore } from './store'
import type { SshService } from './ssh-service'

const inputSchema = z.object({source:z.literal('remote'),path:z.string().trim().min(1).max(4096).refine(p=>!/[\0\r\n]/.test(p)),serverId:z.string().uuid(),accessRouteId:z.string().max(80).optional()})
const excluded = new Set(['node_modules','venv','env','__pycache__','data','datasets','checkpoints','weights','outputs','runs','dist','build'])
const permitted = (path: string): boolean => {
  const parts = path.split('/')
  return parts.every(p => !!p && p !== '..' && !p.startsWith('.') && !excluded.has(p.toLowerCase()))
    && !/(?:^|[\/_.-])(secret|credentials?|tokens?|password|private[_-]?key)(?:[_.-]|$)/i.test(path)
    && /(?:\.(md|rst|py|sh|toml|ya?ml|json|cfg|ini)$|(?:^|\/)(?:readme|requirements[^/]*\.txt|setup\.cfg|makefile|dockerfile))$/i.test(path)
}
export function repositoryFilePriority(path: string): number {
  const name = posix.basename(path).toLowerCase()
  if (/^readme(?:\.|$)/.test(name)) return 0
  if (/^(requirements[^/]*\.txt|environment\.ya?ml|pyproject\.toml)$/.test(name)) return 1
  if (/^(train|main|finetune|run_train|run)\.(py|sh)$/.test(name)) return 2
  if (/^(setup\.py|package\.json|dockerfile)$/.test(name)) return 3
  return /\.(md|rst)$/.test(name) ? 4 : 5
}
/** Return the complete text for one file; the scan enforces the single-request budget. */
export function repositoryTextExcerpts(_path:string,text:string):{startLine:number;text:string}[] {
  return [{startLine:1,text}]
}
/** Paths mentioned in README/config text, used to pull referenced scripts into the reading set. */
export function repositoryReferences(text:string):string[] {
  const matches=[...text.matchAll(/\b([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:py|sh|ya?ml|json|toml|cfg|ini))\b/g)]
  return [...new Set(matches.map(match=>match[1].replace(/^\.\//,'')))]
}
export function repositoryReferenceCandidates(from:string,reference:string):string[] {
  if(!reference||reference.startsWith('/')||reference.split('/').includes('..'))return []
  const base=posix.dirname(from)
  const candidates=base==='.'?[reference]:[posix.join(base,reference),reference]
  return [...new Set(candidates.filter(candidate=>!!candidate&&!candidate.startsWith('../')&&!candidate.includes('/../')))]
}
interface Entry {name:string;file:boolean;directory:boolean;link:boolean;size:number}
interface Reader {
  root:string
  full(path:string):string
  inside(path:string):boolean
  real(path:string):Promise<string>
  list(path:string):Promise<Entry[]>
  inspect(path:string):Promise<'file'|'directory'|'other'>
  read(path:string):Promise<{text:string;size:number}>
}
const READ_CHUNK = 64 * 1024
const READ_TIMEOUT = 600_000
// One model request has a finite context window. Keep a generous default and let
// large-context setups raise it with LABDECK_REPO_MAX_CHARS.
const DEFAULT_MAX_CHARS = 300_000
const MAX_TOTAL_CHARS = (() => {
  const configured = Number(process.env.LABDECK_REPO_MAX_CHARS)
  return Number.isFinite(configured) && configured >= 20_000 ? Math.floor(configured) : DEFAULT_MAX_CHARS
})()
function limited<T>(operation:()=>Promise<T>):Promise<T> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('读取仓库超时，请检查连接后重试')),READ_TIMEOUT)
    operation().then(resolve,reject).finally(()=>clearTimeout(timer))
  })
}
async function remoteReader(sftp:SFTPWrapper,root:string):Promise<Reader> {
  const real=(path:string):Promise<string>=>new Promise((resolve,reject)=>sftp.realpath(path,(error,value)=>error?reject(error):resolve(value)))
  const base=await real(root)
  const stat=await new Promise<import('ssh2').Stats>((resolve,reject)=>sftp.stat(base,(error,value)=>error?reject(error):resolve(value)))
  if(!stat.isDirectory())throw new Error('服务器路径不是仓库目录')
  return {
    root:base,full:path=>posix.join(base,path),inside:path=>path===base||path.startsWith(base==='/'?'/':base+'/'),real,
    list:path=>new Promise((resolve,reject)=>sftp.readdir(path,(error,entries)=>error?reject(error):resolve(entries.map(e=>({name:e.filename,file:e.attrs.isFile(),directory:e.attrs.isDirectory(),link:e.attrs.isSymbolicLink(),size:e.attrs.size}))))),
    inspect:path=>new Promise((resolve,reject)=>sftp.lstat(path,(error,value)=>error?reject(error):resolve(value.isFile()?'file':value.isDirectory()?'directory':'other'))),
    read:async path=>{
      const info=await new Promise<import('ssh2').Stats>((resolve,reject)=>sftp.lstat(path,(error,value)=>error?reject(error):resolve(value)))
      if(!info.isFile()||info.isSymbolicLink())throw new Error('只支持普通文件，不读取软链接')
      const handle=await new Promise<Buffer>((resolve,reject)=>sftp.open(path,'r',(error,value)=>error?reject(error):resolve(value)))
      try {
        const stat=await new Promise<import('ssh2').Stats>((resolve,reject)=>sftp.fstat(handle,(error,value)=>error?reject(error):resolve(value)))
        if(!stat.isFile())throw new Error('只支持普通文件')
        const chunks:Buffer[]=[]
        let position=0
        while(position<stat.size){
          const length=Math.min(READ_CHUNK,stat.size-position)
          const buffer=Buffer.alloc(length)
          let received=0
          while(received<length){
            const n=await new Promise<number>((resolve,reject)=>sftp.read(handle,buffer,received,length-received,position+received,(error,value)=>error?reject(error):resolve(value)))
            if(!n)break
            received+=n
          }
          if(!received)break
          chunks.push(buffer.subarray(0,received))
          position+=received
        }
        return {text:Buffer.concat(chunks).toString('utf8'),size:stat.size}
      } finally {await new Promise<void>(resolve=>sftp.close(handle,()=>resolve()))}
    }
  }
}
async function scanFiles(reader:Reader,input:RepositoryInput):Promise<RepositorySnapshot> {
  const result:RepositorySnapshot={input:{...input,path:reader.root},files:[],excerpts:[],warnings:[],collectedAt:new Date().toISOString()}
  const queue=['']
  const visited=new Set<string>()
  while(queue.length){
    const directory=queue.shift()!
    const path=reader.full(directory)
    try {
      const real=await reader.real(path)
      if(!reader.inside(real)||visited.has(real))continue
      visited.add(real)
      const entries=await reader.list(path)
      for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
        if(entry.link||entry.name.startsWith('.')||excluded.has(entry.name.toLowerCase()))continue
        const name=directory?`${directory}/${entry.name}`:entry.name
        if(entry.directory)queue.push(name)
        if(entry.file&&permitted(name))result.files.push({path:name,sizeBytes:entry.size})
      }
    } catch {result.warnings.push(`目录 ${directory||'.'} 无法读取。`)}
  }
  result.files.sort((a,b)=>(repositoryFilePriority(a.path)+a.path.split('/').length*2)-(repositoryFilePriority(b.path)+b.path.split('/').length*2)||a.path.localeCompare(b.path))
  return result
}
async function scan(reader:Reader,input:RepositoryInput,selected:string[]):Promise<RepositorySnapshot> {
  const result=await scanFiles(reader,input)
  let total=0
  const omitted:string[]=[]
  let truncatedFiles=0
  const pending=[...selected]
  const scheduled=new Set<string>()
  const read=new Set<string>()
  let cursor=0
  while(cursor<pending.length){
    const path=pending[cursor++]
    if(read.has(path))continue
    read.add(path)
    if(!permitted(path)||!result.files.some(f=>f.path===path))throw new Error(`文件不在本次可读清单中：${path}`)
    const known=result.files.find(f=>f.path===path)!
    const remaining=MAX_TOTAL_CHARS-total
    if(remaining<=0||known.sizeBytes>remaining*4){omitted.push(path);continue}
    const full=reader.full(path)
    if(!reader.inside(await reader.real(full)))throw new Error(`文件超出仓库目录：${path}`)
    try {
      const file=await reader.read(full)
      if(file.text.includes('\0')){result.warnings.push(`${path} 不是受支持的文本文件。`);continue}
      const privateSafe=file.text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,block=>'[私钥已隐藏]'+'\n'.repeat(block.split('\n').length-1))
      const safe=privateSafe.split('\n').map(line=>redactSecrets(line)).join('\n')
      if(!safe.trim())continue
      if(safe.length>remaining){
        result.excerpts.push({path,text:safe.slice(0,remaining),startLine:1,truncated:true})
        truncatedFiles+=1;total=MAX_TOTAL_CHARS;continue
      }
      total+=safe.length
      result.excerpts.push({path,text:safe,startLine:1,truncated:false})
      // Pull files explicitly referenced by README/config next, before the rest of the queue.
      for(const reference of repositoryReferences(safe)){
        const target=repositoryReferenceCandidates(path,reference).find(candidate=>result.files.some(f=>f.path===candidate))
        if(!target||target===path||read.has(target)||scheduled.has(target))continue
        scheduled.add(target)
        pending.splice(cursor,0,target)
      }
    } catch {result.warnings.push(`文件 ${path} 无法读取，分析时不会使用其内容。`)}
  }
  if(omitted.length)result.warnings.push(`单次分析文本上限约 ${MAX_TOTAL_CHARS.toLocaleString('zh-CN')} 字符，已跳过 ${omitted.length} 个文件：${omitted.slice(0,6).join('、')}${omitted.length>6?' 等':''}。可取消大文件、选择更具体的仓库子目录，或用环境变量 LABDECK_REPO_MAX_CHARS 调整上限（需重启应用）。`)
  if(truncatedFiles)result.warnings.push(`有 ${truncatedFiles} 个文件超出剩余额度，仅包含开头部分；超出部分的引用不可用。`)
  return result
}
async function withReader<T>(store:AppStore,ssh:SshService,raw:RepositoryInput,operation:(reader:Reader,input:RepositoryInput)=>Promise<T>):Promise<T> {
  const input=inputSchema.parse(raw)
  if(!input.path.startsWith('/'))throw new Error('请选择服务器并填写绝对仓库路径')
  const server=store.getServer(input.serverId)
  if(server.mode!=='real')throw new Error('请选择实际服务器')
  const route=input.accessRouteId??getDefaultAccessRouteId(server)
  if(!getAccessRoutes(server).some(r=>r.id===route))throw new Error('连接路径不存在')
  const profile=applyAccessRoute(server,route)
  if(!profile.hostFingerprint||(profile.jumpHost&&!profile.jumpHost.hostFingerprint))throw new Error('请先在资源页面连接服务器并确认 SSH 主机指纹')
  const connected=await ssh.connect(profile,store.getSecrets(profile.id))
  try {
    return await limited(async()=>{
      const sftp=await new Promise<SFTPWrapper>((resolve,reject)=>connected.client.sftp((error,value)=>error?reject(error):resolve(value)))
      return operation(await remoteReader(sftp,input.path),{...input,accessRouteId:route})
    })
  } finally {connected.client.end()}
}
export interface RepositoryReadSession {
  snapshot: RepositorySnapshot
  maxChars: number
  read(path:string):Promise<RepositoryExcerpt>
  list(path:string):{directories:string[];files:RepositoryFile[]}
  find(pattern:string):RepositoryFile[]
  close():void
}
/** Keep one SSH/SFTP session open so a model can inspect files on demand. */
export async function openRepositoryReadSession(store:AppStore,ssh:SshService,raw:RepositoryInput,selectedPaths?:string[]):Promise<RepositoryReadSession> {
  const input=inputSchema.parse(raw)
  if(!input.path.startsWith('/'))throw new Error('请选择服务器并填写绝对仓库路径')
  const server=store.getServer(input.serverId)
  if(server.mode!=='real')throw new Error('请选择实际服务器')
  const route=input.accessRouteId??getDefaultAccessRouteId(server)
  if(!getAccessRoutes(server).some(r=>r.id===route))throw new Error('连接路径不存在')
  const profile=applyAccessRoute(server,route)
  if(!profile.hostFingerprint||(profile.jumpHost&&!profile.jumpHost.hostFingerprint))throw new Error('请先在资源页面连接服务器并确认 SSH 主机指纹')
  const connected=await ssh.connect(profile,store.getSecrets(profile.id))
  let closed=false
  try {
    const sftp=await new Promise<SFTPWrapper>((resolve,reject)=>connected.client.sftp((error,value)=>error?reject(error):resolve(value)))
    const reader=await remoteReader(sftp,input.path)
    const snapshot=await scanFiles(reader,{...input,accessRouteId:route})
    if(selectedPaths){
      const selected=new Set(selectedPaths)
      const omitted=snapshot.files.length-snapshot.files.filter(file=>selected.has(file.path)).length
      snapshot.files=snapshot.files.filter(file=>selected.has(file.path))
      if(omitted)snapshot.warnings.push(`仅分析勾选的文件；${omitted} 个未勾选文件不会被自动补读。`)
    }
    const known=new Map(snapshot.files.map(file=>[file.path,file]))
    let total=0
    const read=async(path:string):Promise<RepositoryExcerpt>=>{
      const existing=snapshot.excerpts.find(excerpt=>excerpt.path===path)
      if(existing)return existing
      const info=known.get(path)
      if(!info)throw new Error(`文件不在仓库文本清单中：${path}`)
      if(!permitted(path))throw new Error(`文件类型不受支持：${path}`)
      const remaining=MAX_TOTAL_CHARS-total
      if(remaining<=0){snapshot.warnings.push('本次读取预算已用完，部分文件未读取。');throw new Error('本次读取预算已用完；请根据已读内容完成方案')}
      if(info.sizeBytes>remaining*4){snapshot.warnings.push(`${path} 约 ${(info.sizeBytes/1024/1024).toFixed(1)} MB，超出剩余读取额度，未读取。`);throw new Error(`文件约 ${(info.sizeBytes/1024/1024).toFixed(1)} MB，超出剩余读取预算`)}
      const full=reader.full(path)
      if(!reader.inside(await reader.real(full)))throw new Error(`文件超出仓库目录：${path}`)
      const file=await reader.read(full)
      if(file.text.includes('\0'))throw new Error('不是受支持的文本文件')
      const privateSafe=file.text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,block=>'[私钥已隐藏]'+'\n'.repeat(block.split('\n').length-1))
      const safe=privateSafe.split('\n').map(line=>redactSecrets(line)).join('\n')
      if(!safe.trim())throw new Error('文件没有可分析的文本内容')
      const text=safe.length>remaining?safe.slice(0,remaining):safe
      total+=text.length
      const excerpt:RepositoryExcerpt={path,text,startLine:1,truncated:text.length<safe.length}
      snapshot.excerpts.push(excerpt)
      if(excerpt.truncated)snapshot.warnings.push(`${path} 超出本次剩余读取额度，只读取了开头部分；超出部分的引用不可用。`)
      return excerpt
    }
    const list=(directory:string):{directories:string[];files:RepositoryFile[]}=>{
      const base=directory.replace(/^\/+|\/+$/g,'')
      const prefix=base?base+'/':''
      const directories=new Set<string>();const files:RepositoryFile[]=[]
      for(const file of snapshot.files){
        if(!file.path.startsWith(prefix))continue
        const rest=file.path.slice(prefix.length)
        const slash=rest.indexOf('/')
        if(slash>=0)directories.add(rest.slice(0,slash))
        else files.push(file)
      }
      return {directories:[...directories].sort().slice(0,80),files:files.sort((a,b)=>a.path.localeCompare(b.path)).slice(0,120)}
    }
    const find=(pattern:string):RepositoryFile[]=>{
      const query=pattern.trim().toLowerCase()
      const score=(file:RepositoryFile)=>posix.basename(file.path).toLowerCase().includes(query)?0:1
      return snapshot.files.filter(file=>file.path.toLowerCase().includes(query)).sort((a,b)=>score(a)-score(b)||a.path.length-b.path.length||a.path.localeCompare(b.path)).slice(0,50)
    }
    return {snapshot,maxChars:MAX_TOTAL_CHARS,read,list,find,close:()=>{if(!closed){closed=true;connected.client.end()}}}
  } catch(error) {
    if(!closed){closed=true;connected.client.end()}
    throw error
  }
}
export async function readRepository(store:AppStore,ssh:SshService,raw:RepositoryInput,paths:string[]=[]):Promise<RepositorySnapshot> {
  const selected=z.array(z.string().min(1).max(512)).parse(paths)
  return withReader(store,ssh,raw,(reader,input)=>scan(reader,input,selected))
}
/** Read-only probe for repo-local data/weight directories. */
export async function findRepositoryDirectories(store:AppStore,ssh:SshService,input:RepositoryInput,candidates:string[]):Promise<string[]> {
  return withReader(store,ssh,input,async reader=>{
    const found:string[]=[]
    for(const candidate of candidates.slice(0,8)){
      if(!candidate||candidate.startsWith('/')||candidate.split('/').includes('..')||/[\\\0\r\n]/.test(candidate))continue
      try {if(await reader.inspect(reader.full(candidate))==='directory')found.push(candidate)} catch { /* missing */ }
    }
    return found
  })
}
export type ServerPathKind='directory'|'file'|'other'|'missing'
export interface ServerPathInspection {path:string;kind:ServerPathKind}
const shellQuote=(value:string):string=>`'${value.replace(/'/g, `'\\''`)}'`
/** Read-only existence probe for absolute server paths already present in the guide. */
export async function inspectServerPaths(store:AppStore,ssh:SshService,input:RepositoryInput,paths:string[]):Promise<ServerPathInspection[]> {
  const parsed=inputSchema.parse(input)
  const targets=[...new Set(paths.filter(path=>path.startsWith('/')&&path.length<=4096&&!/[\0\r\n]/.test(path)))].slice(0,4)
  if(!targets.length)return []
  const server=store.getServer(parsed.serverId)
  if(server.mode!=='real')throw new Error('请选择实际服务器')
  const route=parsed.accessRouteId??getDefaultAccessRouteId(server)
  if(!getAccessRoutes(server).some(r=>r.id===route))throw new Error('连接路径不存在')
  const profile=applyAccessRoute(server,route)
  if(!profile.hostFingerprint||(profile.jumpHost&&!profile.jumpHost.hostFingerprint))throw new Error('请先在资源页面连接服务器并确认 SSH 主机指纹')
  const connected=await ssh.connect(profile,store.getSecrets(profile.id))
  try{
    const script=targets.map(path=>`p=${shellQuote(path)}; if [ -d "$p" ]; then printf '%s\\tdirectory\\n' "$p"; elif [ -f "$p" ]; then printf '%s\\tfile\\n' "$p"; elif [ -e "$p" ]; then printf '%s\\tother\\n' "$p"; else printf '%s\\tmissing\\n' "$p"; fi`).join('; ')
    const raw=await ssh.exec(connected.client,script,15_000)
    const result:ServerPathInspection[]=[]
    for(const line of raw.split('\n')){
      const [path,kind]=line.split('\t')
      if(path&&['directory','file','other','missing'].includes(kind))result.push({path,kind:kind as ServerPathKind})
    }
    return result
  }finally{connected.client.end()}
}
export async function checkRepositoryLocations(store:AppStore,ssh:SshService,input:RepositoryInput,paths:{path:string;expected:'file'|'directory'}[]):Promise<RepositoryPathCheck[]> {
  return withReader(store,ssh,input,async reader=>{
    const results:RepositoryPathCheck[]=[]
    for(const item of paths.slice(0,2)){
      if(posix.isAbsolute(item.path)||item.path.split('/').includes('..')||/[\\\0\r\n]/.test(item.path)){
        results.push({...item,status:'outside',message:'位置超出仓库可核对范围'});continue
      }
      try {
        const full=reader.full(item.path)
        if(!reader.inside(await reader.real(full))){results.push({...item,status:'outside',message:'实际路径位于仓库外'});continue}
        const kind=await reader.inspect(full)
        results.push({...item,status:kind===item.expected?'confirmed':'unreadable',message:kind===item.expected?'只读检查已确认存在':'类型不符或为软链接'})
      }catch(error){
        const missing=(error as {code?:unknown}).code===2||(error as {code?:unknown}).code==='ENOENT'
        results.push({...item,status:missing?'missing':'unreadable',message:missing?'本次未找到该路径':'本次未能读取，不能判定不存在'})
      }
    }
    return results
  })
}
