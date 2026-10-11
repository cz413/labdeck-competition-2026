import { describe, expect, it } from 'vitest'
import { gpuProcessMemoryInconsistent, parseNvidiaSnapshot } from './nvidia-metrics'
import { formatGpuProcessMemory } from '../shared/gpu-memory'

import { nvidiaXml } from './test-fixtures/nvidia'

describe('NVIDIA unified snapshot parsing', () => {
  it('reads card and process values from the same XML, without mixing GPU minor numbers or memory utilization', () => {
    const gpu = parseNvidiaSnapshot(nvidiaXml(), '42 chen 7322\n43 li 99\n')[0]
    expect(gpu).toMatchObject({ index: 0, uuid: 'GPU-one', name: 'NVIDIA CMP 170HX', utilizationPercent: 97, memoryUsedMiB: 27034, memoryTotalMiB: 65536, temperatureC: 73, powerW: 94.25, powerLimitW: 250, fanPercent: null, performanceState: 'P0' })
    expect(gpu.processes).toHaveLength(2)
    expect(gpu.processes[0]).toMatchObject({ pid: 42, username: 'chen', elapsedSeconds: 7322, memoryUsedMiB: 1365, processName: '/home/user/a&b/python' })
    expect(gpu.processMemoryInconsistent).toBeUndefined()
  })
  it('handles new driver power tags', () => {
    const xml = nvidiaXml().replace(/<power_readings>.*?<\/power_readings>/s,
      '<gpu_power_readings><average_power_draw>91.50 W</average_power_draw><current_power_limit>250.00 W</current_power_limit></gpu_power_readings>')
    expect(parseNvidiaSnapshot(xml, '')[0]).toMatchObject({ powerW: 91.5, powerLimitW: 250 })
  })
  it('keeps per-card process lists separate even when one PID uses multiple GPUs', () => {
    const secondGpu = nvidiaXml(1600, ['1500'], 'GPU-two').match(/<gpu id=.*?<\/gpu>/s)![0]
    const xml = nvidiaXml(1600, ['1500']).replace('<attached_gpus>1</attached_gpus>', '<attached_gpus>2</attached_gpus>').replace('</nvidia_smi_log>', `${secondGpu}</nvidia_smi_log>`)
    const gpus = parseNvidiaSnapshot(xml, '')
    expect(gpus.map(gpu => [gpu.index, gpu.uuid, gpu.processes.length])).toEqual([[0, 'GPU-one', 1], [1, 'GPU-two', 1]])
  })
  it('keeps process ownership and elapsed time optional when ps cannot see the PID', () => {
    expect(parseNvidiaSnapshot(nvidiaXml(1600, ['1500']), '')[0].processes[0]).toMatchObject({ username: '未知', elapsedSeconds: null })
  })
  it('does not turn unavailable process memory into a displayed zero', () => {
    const gpu = parseNvidiaSnapshot(nvidiaXml(1600, ['N/A']), '')[0]
    expect(gpu.processes[0].memoryUsageUnavailable).toBe(true)
    expect(formatGpuProcessMemory(gpu.processes[0])).toBe('—')
    expect(gpu.processMemoryInconsistent).toBeUndefined()
  })
  it('accepts idle GPUs and systems without NVIDIA', () => {
    expect(parseNvidiaSnapshot(nvidiaXml(0, []), '')[0].processes).toEqual([])
    expect(parseNvidiaSnapshot('__NO_NVIDIA_SMI__', '')).toEqual([])
  })
  it('marks the screenshot discrepancy while preserving the raw driver readings', () => {
    const gpu = parseNvidiaSnapshot(nvidiaXml(27034, ['1365', '31846']), '')[0]
    expect(gpu.processMemoryInconsistent).toBe(true)
    expect(gpu.memoryUsedMiB).toBe(27034)
    expect(gpu.processes[1].memoryUsedMiB).toBe(31846)
    expect(formatGpuProcessMemory(gpu.processes[1], gpu.processMemoryInconsistent)).toBe('待确认')
  })
  it('tolerates MiB rounding and driver overhead, without forcing the sums to match', () => {
    const rounded = parseNvidiaSnapshot(nvidiaXml(1600, ['800', '806']), '')[0]
    expect(gpuProcessMemoryInconsistent(rounded)).toBe(false)
    const overhead = parseNvidiaSnapshot(nvidiaXml(1600, ['1400']), '')[0]
    expect(overhead.processMemoryInconsistent).toBeUndefined()
    expect(overhead.memoryUsedMiB).toBe(1600)
    expect(formatGpuProcessMemory(overhead.processes[0])).toBe('1.4 GiB')
  })
  it('rejects malformed or missing device memory instead of presenting an empty card', () => {
    expect(() => parseNvidiaSnapshot(nvidiaXml().slice(0, -10), '')).toThrow('不完整')
    expect(() => parseNvidiaSnapshot('<root/>', '')).toThrow('格式无效')
    expect(() => parseNvidiaSnapshot(nvidiaXml().replace('<used>27034 MiB</used>', '<used>N/A</used>'), '')).toThrow('整卡显存')
  })
})
