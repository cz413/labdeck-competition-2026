import { XMLParser, XMLValidator } from 'fast-xml-parser'
import type { GpuMetric, GpuProcessMetric } from '../shared/types'

type XmlNode = Record<string, unknown>
const node = (value: unknown): XmlNode => value && typeof value === 'object' ? value as XmlNode : {}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
const numeric = (value: unknown): number | null => {
  const match = text(value).match(/^(-?\d+(?:\.\d+)?)(?:\s|$)/)
  return match ? Number(match[1]) : null
}
const parser = new XMLParser({ parseTagValue: false, ignoreAttributes: true })

export function gpuProcessMemoryInconsistent(gpu: GpuMetric): boolean {
  const known = gpu.processes.filter(process => !process.memoryUsageUnavailable)
  const total = known.reduce((sum, process) => sum + process.memoryUsedMiB, 0)
  // NVIDIA rounds each process to MiB; tolerate only the small rounding difference.
  return total - gpu.memoryUsedMiB > Math.max(8, known.length)
}

export function parseNvidiaSnapshot(xml: string, processMetadata: string): GpuMetric[] {
  if (xml.includes('__NO_NVIDIA_SMI__')) return []
  if (XMLValidator.validate(xml) !== true) throw new Error('NVIDIA 返回的 GPU 采样数据不完整')
  const document = node(node(parser.parse(xml)).nvidia_smi_log)
  if (!Object.keys(document).length) throw new Error('NVIDIA 返回的 GPU 采样格式无效')
  const metadata = new Map<number, { username: string; elapsedSeconds: number }>()
  for (const line of processMetadata.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\d+)$/)
    if (match) metadata.set(Number(match[1]), { username: match[2], elapsedSeconds: Number(match[3]) })
  }
  return list(document.gpu).map((entry, index) => {
    const gpu = node(entry)
    const memory = node(gpu.fb_memory_usage)
    const utilization = node(gpu.utilization)
    const temperature = node(gpu.temperature)
    const power = node(gpu.gpu_power_readings ?? gpu.power_readings)
    const limit = node(gpu.power_readings)
    const processes: GpuProcessMetric[] = []
    for (const item of list(node(gpu.processes).process_info)) {
      const process = node(item)
      const pid = numeric(process.pid)
      if (pid === null || !Number.isInteger(pid) || pid <= 0) continue
      const usedMemory = numeric(process.used_memory)
      const owner = metadata.get(pid)
      processes.push({
        pid, username: owner?.username ?? '未知', elapsedSeconds: owner?.elapsedSeconds ?? null,
        processName: text(process.process_name) || '未知进程',
        memoryUsedMiB: usedMemory ?? 0,
        ...(usedMemory === null ? { memoryUsageUnavailable: true } : {})
      })
    }
    const memoryUsedMiB = numeric(memory.used)
    const memoryTotalMiB = numeric(memory.total)
    if (memoryUsedMiB === null || memoryTotalMiB === null || memoryTotalMiB <= 0) {
      throw new Error(`GPU ${index} 未返回有效的整卡显存数据`)
    }
    const metric: GpuMetric = {
      index, name: text(gpu.product_name), uuid: text(gpu.uuid),
      utilizationPercent: numeric(utilization.gpu_util) ?? 0,
      memoryUsedMiB, memoryTotalMiB,
      temperatureC: numeric(temperature.gpu_temp) ?? 0,
      powerW: numeric(power.power_draw ?? power.average_power_draw ?? power.instant_power_draw),
      powerLimitW: numeric(power.power_limit ?? power.current_power_limit ?? limit.power_limit ?? limit.current_power_limit),
      fanPercent: numeric(gpu.fan_speed),
      performanceState: text(gpu.performance_state) && text(gpu.performance_state) !== 'N/A' ? text(gpu.performance_state) : null,
      processes
    }
    if (!metric.uuid) throw new Error(`GPU ${index} 未返回设备 UUID`)
    if (gpuProcessMemoryInconsistent(metric)) metric.processMemoryInconsistent = true
    return metric
  })
}
