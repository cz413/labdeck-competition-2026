import type { ExperimentLaunchMode } from './types'

/** Synchronize literal device arguments while preserving command formatting and quoted text. */
export function deviceLaunchCommand(command: string, device: 'gpu' | 'cpu'): string {
  const tokens: {text:string; start:number; end:number}[] = []
  let start=-1, quote='', escaped=false
  for(let index=0;index<command.length;index++){
    const char=command[index]
    if(escaped){escaped=false;continue}
    if(char==='\\'&&quote!=="'"){if(start<0)start=index;escaped=true;continue}
    if(quote){if(char===quote)quote='';continue}
    if(char==='"'||char==="'"){if(start<0)start=index;quote=char;continue}
    // Shell composition can contain unrelated programs; leave it for explicit editing.
    if(/[;&|`$<>\r\n]/.test(char))return command
    if(/\s/.test(char)){if(start>=0){tokens.push({text:command.slice(start,index),start,end:index});start=-1}}
    else if(start<0)start=index
  }
  if(quote||escaped)return command
  if(start>=0)tokens.push({text:command.slice(start),start,end:command.length})
  const edits:{start:number;end:number;text:string}[]=[]
  for(let index=0;index<tokens.length;index++){
    const token=tokens[index]
    if(token.text==='--')break
    const equals=token.text.startsWith('--device=')
    if(!equals&&token.text!=='--device')continue
    const valueToken=equals?token:tokens[++index]
    if(!valueToken)continue
    const offset=equals?'--device='.length:0
    const value=valueToken.text.slice(offset)
    const match=value.match(/^(['"]?)(cpu|cuda(?::\d+)?|gpu)\1$/)
    if(!match)continue
    const next=device==='cpu'?'cpu':match[2]==='cpu'?'cuda':match[2]
    edits.push({start:valueToken.start+offset,end:valueToken.end,text:match[1]+next+match[1]})
  }
  for(const edit of edits.reverse())command=command.slice(0,edit.start)+edit.text+command.slice(edit.end)
  return command
}
export function cpuLaunchCommand(command: string): string { return deviceLaunchCommand(command,'cpu') }

interface LaunchConfig {
  computeDevice?: 'gpu' | 'cpu'
  launchMode?: ExperimentLaunchMode
  scriptPath?: string
  codePath?: string
  launchCommand?: string
}

export function validateExperimentScriptPath(path: string): void {
  if (!path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path) || !path.endsWith('.sh')) {
    throw new Error('脚本必须填写服务器上以 .sh 结尾的绝对路径')
  }
}

export function experimentWorkingDirectory(config: LaunchConfig): string {
  const directory = config.codePath?.trim() ?? ''
  if (directory || config.launchMode !== 'script') return directory
  const path = config.scriptPath?.trim() ?? ''
  return path.slice(0, path.lastIndexOf('/')) || '/'
}

export function resolveExperimentLaunch(config: LaunchConfig): { codePath: string; launchCommand: string } {
  if (config.launchMode === 'script') validateExperimentScriptPath(config.scriptPath?.trim() ?? '')
  const codePath = experimentWorkingDirectory(config)
  if (!codePath.startsWith('/') || /[\x00-\x1f\x7f]/.test(codePath)) {
    throw new Error('自动运行需要填写服务器上的代码目录绝对路径')
  }
  if (config.launchMode === 'script') {
    const scriptPath = config.scriptPath!.trim()
    const quoted = `'${scriptPath.replace(/'/g, `'\\''`)}'`
    return { codePath, launchCommand: `bash -- ${quoted}` }
  }
  const original = config.launchCommand?.trim() ?? ''
  const launchCommand = config.computeDevice ? deviceLaunchCommand(original,config.computeDevice) : original
  if (!launchCommand) throw new Error('自动运行需要填写启动命令')
  return { codePath, launchCommand }
}
