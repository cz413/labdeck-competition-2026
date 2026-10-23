import type { ExperimentLaunchMode } from './types'

export function cpuLaunchCommand(command: string): string {
  return command.replace(/(^|\s)(--device(?:=|\s+))(?:"(?:cuda(?::\d+)?|gpu)"|'(?:cuda(?::\d+)?|gpu)'|cuda(?::\d+)?|gpu)(?=\s|$)/g, '$1$2cpu')
}

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
  const launchCommand = config.computeDevice === 'cpu' ? cpuLaunchCommand(original) : original
  if (!launchCommand) throw new Error('自动运行需要填写启动命令')
  return { codePath, launchCommand }
}
