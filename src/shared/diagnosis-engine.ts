import type { BatchRepair, Evidence, Finding } from './intelligence'

export const diagnosticSamples = {
  oom: 'Epoch 1/5 | batch_size=32\nTraceback (most recent call last):\n  File "/workspace/vision/train.py", line 83, in train\n    loss.backward()\ntorch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB. GPU 0 has a total capacity of 24.00 GiB.',
  dependency: 'Traceback (most recent call last):\n  File "/workspace/vision/train.py", line 8, in <module>\n    import torchvision\nModuleNotFoundError: No module named \'torchvision\'',
  path: 'Loading dataset...\nFileNotFoundError: [Errno 2] No such file or directory: \'/datasets/flowers/train.json\''
}

export function redactSecrets(text: string): string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[私钥已隐藏]')
    .replace(/\b(Bearer\s+)[\w.\-+/=]+/gi, '$1[已隐藏]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|password|passwd|secret|token)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[密钥已隐藏]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[凭据已隐藏]@')
}

export function logEvidence(raw: string): { logExcerpt: string; evidence: Evidence[]; clipped: boolean } {
  const clipped = raw.length > 65_536 || raw.split(/\r?\n/).length > 240
  const logExcerpt = redactSecrets(raw).slice(-65_536).split(/\r?\n/).slice(-240).join('\n')
  const evidence = logExcerpt.split('\n').flatMap((text, i): Evidence[] => text.trim() ? [{ id: `log-${i + 1}`, source: 'log', label: `日志片段第 ${i + 1} 行`, line: i + 1, text: text.slice(0, 1500) }] : [])
  return { logExcerpt, evidence, clipped }
}

export function diagnoseEvidence(evidence: Evidence[]): Finding[] {
  const rules: {category: string; pattern: RegExp; title: string; explanation: string; steps: string[]}[] = [
    { category: 'oom', pattern: /CUDA out of memory|torch\.OutOfMemoryError|CUDA_ERROR_OUT_OF_MEMORY/i, title: '训练触发 GPU 显存不足', explanation: '日志明确包含显存分配失败。仅凭这条日志不能区分参数过大、显存碎片或其他进程竞争，需要结合失败时的资源记录判断。', steps: ['核对失败时 GPU 占用；当前资源快照只代表检查时刻。', '若启动命令明确包含 batch size，可减小后创建新运行。', '仍失败时，检查输入尺寸、梯度累积与混合精度配置。'] },
    { category: 'dependency', pattern: /ModuleNotFoundError:\s*No module named|ImportError:\s*cannot import name/i, title: '当前环境的依赖导入失败', explanation: '日志中的 Python 导入错误指向缺少依赖或依赖版本不兼容。应先确认实际解释器与所选环境一致。', steps: ['核对实际 Python 解释器与 Conda 环境。', '查看项目 requirements 或 environment 文件，确认依赖及版本。', '在独立环境中安装或调整依赖，再通过实验任务创建一次运行。'] },
    { category: 'path', pattern: /FileNotFoundError|No such file or directory|NotADirectoryError/i, title: '运行引用的文件或目录不可用', explanation: '日志报告路径无法访问。可能是路径错误、数据尚未准备或相对路径依赖当前工作目录。', steps: ['根据日志中的具体路径检查文件是否存在。', '核对代码目录、数据目录和启动命令中的路径。', '修正配置后通过实验任务重新运行。'] },
    { category: 'permission', pattern: /PermissionError|Permission denied/i, title: '当前 SSH 用户缺少访问权限', explanation: '日志包含权限拒绝。需要核对目标路径权限和实际运行用户。', steps: ['核对运行用户与文件的读写权限。', '使用当前用户有权限的目录保存日志和产物。', '需要共享权限时，请管理员按实际需求调整。'] },
    { category: 'cuda', pattern: /Torch not compiled with CUDA|Found no NVIDIA driver|CUDA driver version is insufficient|No CUDA GPUs are available/i, title: '训练环境无法使用 CUDA', explanation: '日志报告 CUDA 支持或驱动问题。环境内的 PyTorch、CUDA 运行时和服务器驱动需要共同核对。', steps: ['查看环境检查中的 PyTorch 版本和 CUDA 可用性。', '核对服务器 nvidia-smi 输出与项目版本要求。', '选择兼容环境后再运行。'] }
  ]
  const findings = rules.flatMap(rule => {
    const matching = evidence.filter(item => item.source === 'log' && rule.pattern.test(item.text))
    return matching.length ? [{ category: rule.category, title: rule.title, confidence: 'high' as const, explanation: rule.explanation, evidenceIds: matching.slice(0, 5).map(e => e.id), steps: rule.steps }] : []
  })
  return findings.length ? findings : [{ category: 'unknown', title: '现有证据不足以确定原因', confidence: 'low', explanation: '没有匹配到受支持的明确错误信号。不能把未知退出或空日志直接判定为训练成功。', evidenceIds: [], steps: ['检查任务退出码与完整错误日志。', '补充环境信息和错误附近的日志。', '配置模型后可进一步分析，结论仍需证据验证。'] }]
}

export function proposeBatchRepair(command: string, hasOom: boolean, launchMode?: string): BatchRepair | undefined {
  if (!hasOom || launchMode === 'script' || !/^python(?:3(?:\.\d+)?)?\s+[A-Za-z0-9_./-]+\.py(?:\s|$)/.test(command.trim()) || /[\r\n;&|`$<>"'\\]/.test(command) || redactSecrets(command) !== command) return undefined
  const matches = [...command.matchAll(/(?:^|\s)(--batch[_-]size)(\s+|=)(\d+)(?=\s|$)/g)]
  if (matches.length !== 1) return undefined
  const match = matches[0]
  const previousBatch = Number(match[3])
  if (!Number.isSafeInteger(previousBatch) || previousBatch < 2) return undefined
  const nextBatch = Math.max(1, Math.floor(previousBatch / 2))
  const after = command.slice(0, match.index) + match[0].slice(0, -match[3].length) + nextBatch + command.slice(match.index! + match[0].length)
  return { kind: 'reduce-batch', before: command, after, previousBatch, nextBatch }
}
