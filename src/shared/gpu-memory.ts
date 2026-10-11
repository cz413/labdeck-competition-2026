import type { GpuProcessMetric } from './types'

export function formatGpuProcessMemory(process: GpuProcessMetric, inconsistent = false): string {
  if (inconsistent) return '待确认'
  if (process.memoryUsageUnavailable) return '—'
  return process.memoryUsedMiB >= 1024
    ? `${(process.memoryUsedMiB / 1024).toFixed(1)} GiB`
    : `${Math.round(process.memoryUsedMiB)} MiB`
}
