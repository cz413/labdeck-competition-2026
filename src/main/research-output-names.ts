import { mkdir,readFile,writeFile,rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
const schema=z.record(z.string(),z.number().int().nonnegative())
export function outputBatchName(index:number):string {
  let letters=''
  for(let value=index+1;value>0;value=Math.floor((value-1)/26))letters=String.fromCharCode(97+(value-1)%26)+letters
  return 'labdeck'+letters
}
/** Keep reservations after campaign deletion so output directories are never reused. */
export class ResearchOutputNames {
  private queue:Promise<unknown>=Promise.resolve()
  constructor(private readonly file:string){}
  allocate(id:string):Promise<string>{
    const job=this.queue.then(async()=>{
      let names:Record<string,number>={}
      try{names=schema.parse(JSON.parse(await readFile(this.file,'utf8')))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('输出目录编号记录无法读取，请保留记录后检查')}
      if(names[id]!==undefined)return outputBatchName(names[id])
      const index=Object.values(names).reduce((max,value)=>Math.max(max,value),-1)+1
      names[id]=index
      await mkdir(dirname(this.file),{recursive:true})
      const temporary=this.file+'.'+randomUUID()+'.tmp'
      await writeFile(temporary,JSON.stringify(names),'utf8');await rename(temporary,this.file)
      return outputBatchName(index)
    })
    this.queue=job.catch(()=>{})
    return job
  }
}
