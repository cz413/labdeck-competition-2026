import { describe,it,expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RunDeviceFields, type RunDeviceValue } from './RunDeviceFields'
const value:RunDeviceValue={computeDevice:'gpu',gpuUuid:null,gpuIndex:null,gpuNameSnapshot:null,minimumFreeVramGiB:8,maximumGpuUtilizationPercent:50}
const render=(patch:Partial<RunDeviceValue>={})=>renderToStaticMarkup(<RunDeviceFields value={{...value,...patch}} onChange={()=>{}} refreshing={false} onRefresh={()=>{}}/>)
describe('shared run device selection',()=>{
  it('shows the automatic GPU choice and resource limits',()=>{
    const html=render()
    expect(html).toContain('自动分配（等待符合条件的 GPU）')
    expect(html).toContain('最低空闲显存')
    expect(html).toContain('最高 GPU 利用率')
    expect(html).toContain('value="8"')
  })
  it('hides GPU choices on CPU runs',()=>{
    const html=render({computeDevice:'cpu'})
    expect(html).not.toContain('GPU 执行方式')
    expect(html).toContain('请确认启动命令或脚本支持 CPU')
  })
  it('preserves a selected GPU when sampling is temporarily unavailable',()=>{
    const html=render({gpuUuid:'GPU-2',gpuIndex:2})
    expect(html).toContain('GPU 2 · 当前采样不可用')
    expect(html).toContain('value="GPU-2"')
  })
})
