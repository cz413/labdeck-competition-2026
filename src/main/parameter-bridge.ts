import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { expandParameters, normalizeAxes, tokenizeTrainingCommand } from '../shared/parameter-engine'
import type { ParameterAxis, ParameterExpansion } from '../shared/research'
export class ParameterBridge {
  constructor(private readonly directory: string) {}
  get executable():string {return join(this.directory,process.platform==='win32'?'parameter-engine.exe':'parameter-engine')}
  async status():Promise<{available:boolean;path:string;message:string}> {
    try {await access(this.executable);return {available:true,path:this.executable,message:'仓颉参数引擎已就绪'}}
    catch {return {available:false,path:this.executable,message:'仓颉引擎未编译，当前使用 TypeScript 参数引擎；引擎名称会明确记录'}}
  }
  async expand(command:string,axes:ParameterAxis[],maxRuns:number):Promise<ParameterExpansion> {
    const expected=expandParameters(command,axes,maxRuns)
    if(!(await this.status()).available)return {...expected,warnings:[...expected.warnings,'仓颉引擎不可用，本次由 TypeScript 展开参数。']}
    // TSV protocol: values cannot contain whitespace; source command and axes are validated before spawn.
    const request=[String(maxRuns),tokenizeTrainingCommand(command).join('\t'),...normalizeAxes(axes).map(a=>[a.flag,...a.values].join('\t'))].join('\n')+'\n'
    const output=await new Promise<string>((resolve,reject)=>{
      const child=spawn(this.executable,[],{cwd:this.directory,windowsHide:true,stdio:['pipe','pipe','pipe']})
      let stdout='',stderr='',settled=false
      const timer=setTimeout(()=>{child.kill();finish(new Error('仓颉参数引擎运行超时'))},5000)
      const finish=(error?:Error):void=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(stdout)}
      child.on('error',error=>finish(error));child.on('close',code=>finish(code===0?undefined:new Error(`仓颉参数引擎失败：${stderr.slice(0,300)||code}`)))
      child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>200000){child.kill();finish(new Error('仓颉输出超过限制'))}})
      child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(0,1000)})
      child.stdin.on('error',error=>finish(error));child.stdin.end(request)
    })
    const parsed=z.object({version:z.literal('1'),commands:z.array(z.string()).max(32),count:z.number().int()}).parse(JSON.parse(output))
    if(parsed.count!==expected.variants.length || parsed.commands.length!==parsed.count || parsed.commands.some((c,i)=>c!==expected.variants[i].command))throw new Error('仓颉输出与参数协议不一致，已阻止创建实验')
    return {...expected,engine:'cangjie',version:parsed.version,variants:expected.variants.map((v,i)=>({...v,command:parsed.commands[i]}))}
  }
}
