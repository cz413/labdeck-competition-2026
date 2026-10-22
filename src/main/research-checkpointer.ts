import { MemorySaver } from '@langchain/langgraph'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
/** Disk-backed local saver. Uses LangGraph's own serializer; Uint8Array payloads are base64 encoded. */
export class DiskCheckpointSaver extends MemorySaver {
  private writesQueue: Promise<void> = Promise.resolve()
  constructor(private readonly file: string, private readonly retainedCheckpoints?: number) {super()}
  async load(): Promise<void> {
    try {
      const data=JSON.parse(await readFile(this.file,'utf8'),(_key,value)=>value && typeof value==='object' && Object.keys(value).length===1 && typeof value.$bytes==='string' ? new Uint8Array(Buffer.from(value.$bytes,'base64')):value)
      if(data.version!==1 || !data.storage || !data.writes) throw new Error('检查点格式无效')
      this.storage=data.storage;this.writes=data.writes
    } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('实验流程检查点无法读取；请保留原文件检查，系统不会覆盖历史')}
  }
  private prune():void {
    if(!this.retainedCheckpoints)return
    const retained=new Set<string>()
    for(const [thread,namespaces] of Object.entries(this.storage))for(const [namespace,checkpoints] of Object.entries(namespaces)){
      const ids=Object.keys(checkpoints).sort().reverse()
      for(const id of ids.slice(this.retainedCheckpoints))delete checkpoints[id]
      for(const id of ids.slice(0,this.retainedCheckpoints))retained.add(JSON.stringify([thread,namespace,id]))
    }
    for(const key of Object.keys(this.writes))if(!retained.has(key))delete this.writes[key]
  }
  private async flush():Promise<void> {
    const serialized=JSON.stringify({version:1,storage:this.storage,writes:this.writes},(_key,value)=>value instanceof Uint8Array?{$bytes:Buffer.from(value).toString('base64')}:value)
    const job=this.writesQueue.then(async()=>{await mkdir(dirname(this.file),{recursive:true});const temporary=`${this.file}.${randomUUID()}.tmp`;await writeFile(temporary,serialized,'utf8');await rename(temporary,this.file)})
    this.writesQueue=job.catch(()=>{});await job
  }
  override async put(...args:Parameters<MemorySaver['put']>):ReturnType<MemorySaver['put']>{const result=await super.put(...args);this.prune();await this.flush();return result}
  override async putWrites(...args:Parameters<MemorySaver['putWrites']>):Promise<void>{await super.putWrites(...args);this.prune();await this.flush()}
}
