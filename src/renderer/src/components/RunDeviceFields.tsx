import { LoaderCircle, RotateCcw } from 'lucide-react'
import type { ExperimentRunStartInput, ServerSnapshot } from '@shared/types'
import { deviceLaunchCommand } from '@shared/experiment-launch'
export type RunDeviceValue=Pick<ExperimentRunStartInput,'computeDevice'|'gpuUuid'|'gpuIndex'|'gpuNameSnapshot'|'minimumFreeVramGiB'|'maximumGpuUtilizationPercent'> & Partial<Pick<ExperimentRunStartInput,'launchCommand'|'launchMode'>>
export function RunDeviceFields({value:runDraft,onChange:updateRunDraft,snapshot:runServerSnapshot,refreshing:runGpuRefreshBusy,onRefresh:refreshRunGpuSnapshot,canRefresh=true,disabled=false,compact=false}:{value:RunDeviceValue;onChange:(patch:Partial<RunDeviceValue>)=>void;snapshot?:ServerSnapshot;refreshing:boolean;onRefresh:()=>void;canRefresh?:boolean;disabled?:boolean;compact?:boolean}):React.JSX.Element {
  const manuallySelectedGpu=!!runDraft.gpuUuid||runDraft.gpuIndex!=null
  const runSelectedGpu=runServerSnapshot?.gpus.find(gpu=>runDraft.gpuUuid?gpu.uuid===runDraft.gpuUuid:gpu.index===runDraft.gpuIndex)
  return <fieldset className="run-device-fields" disabled={disabled}>
            <label className="field field-wide"><span>运行设备</span><select aria-label="本次运行设备" value={runDraft.computeDevice ?? 'gpu'} onChange={event => updateRunDraft({computeDevice: event.target.value as 'gpu' | 'cpu', gpuUuid: null, gpuIndex: null, gpuNameSnapshot: null, ...(runDraft.launchCommand!==undefined&&runDraft.launchMode !== 'script' ? {launchCommand: deviceLaunchCommand(runDraft.launchCommand,event.target.value as 'gpu' | 'cpu')} : {})})}><option value="gpu">GPU</option><option value="cpu">CPU</option></select>{runDraft.computeDevice === 'cpu' && <small className="field-help">请确认启动命令或脚本支持 CPU。</small>}</label>
            {runDraft.computeDevice !== 'cpu' && <>
            <div className="field field-wide experiment-run-gpu-field"><div className="experiment-run-gpu-heading"><span>GPU 执行方式</span><button type="button" className="secondary-button" onClick={() => void refreshRunGpuSnapshot()} disabled={runGpuRefreshBusy || !canRefresh}>{runGpuRefreshBusy ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}刷新 GPU 列表</button></div><select value={runDraft.gpuUuid ?? ''} onChange={(event) => {
              const gpu = runServerSnapshot?.gpus.find((item) => item.uuid === event.target.value)
              updateRunDraft({ gpuUuid: gpu?.uuid ?? null, gpuIndex: gpu?.index ?? null, gpuNameSnapshot: gpu?.name ?? null })
            }}><option value="">自动分配（等待符合条件的 GPU）</option>{manuallySelectedGpu && runDraft.gpuUuid && (runServerSnapshot?.status === 'offline' || !runServerSnapshot?.gpus.some((gpu) => gpu.uuid === runDraft.gpuUuid)) && <option value={runDraft.gpuUuid} disabled>GPU {runDraft.gpuIndex} · 当前采样不可用</option>}{runServerSnapshot?.status !== 'offline' && runServerSnapshot?.gpus.filter((gpu) => gpu.uuid).map((gpu) => {
              const freeGiB = Math.max(0, gpu.memoryTotalMiB - gpu.memoryUsedMiB) / 1024
              return <option key={gpu.uuid} value={gpu.uuid}>GPU {gpu.index} · {gpu.name} · 利用率 {gpu.utilizationPercent}% · 空闲显存 {freeGiB.toFixed(1)} GiB</option>
            })}</select><small className="field-help">{compact&&runSelectedGpu?`本批使用 GPU ${runSelectedGpu.index}，沿用指定 GPU 启动方式。`:runServerSnapshot?.status === 'offline' ? '服务器最近采样为离线，手动 GPU 暂时不可选；自动队列会在服务器恢复后继续检查。' : runSelectedGpu ? `已选 GPU ${runSelectedGpu.index}，当前利用率 ${runSelectedGpu.utilizationPercent}%，空闲显存 ${(Math.max(0, runSelectedGpu.memoryTotalMiB - runSelectedGpu.memoryUsedMiB) / 1024).toFixed(1)} GiB；提交后会优先立即启动该卡。` : runGpuRefreshBusy ? '正在读取服务器 GPU 状态…' : runServerSnapshot?.sampledAt ? `自动模式将同时应用显存与利用率条件。GPU 状态采样于 ${new Date(runServerSnapshot.sampledAt).toLocaleTimeString('zh-CN')}` : '尚无 GPU 采样；可刷新列表，或使用自动队列等待服务器采样。'}</small></div>
            {(!compact||!manuallySelectedGpu)&&<>
            <label className="field"><span>最低空闲显存（GiB）</span><input type="number" min="0.1" max="1024" step="0.5" value={runDraft.minimumFreeVramGiB ?? ''} disabled={manuallySelectedGpu} onChange={(event) => updateRunDraft({ minimumFreeVramGiB: event.target.value === '' ? null : Number(event.target.value) })} placeholder="不限制" /><small className="field-help">自动模式生效；清空后不限制显存。</small></label>
            <label className="field"><span>最高 GPU 利用率（%）</span><input type="number" min="0" max="100" step="1" value={runDraft.maximumGpuUtilizationPercent ?? ''} disabled={manuallySelectedGpu} onChange={(event) => updateRunDraft({ maximumGpuUtilizationPercent: event.target.value === '' ? null : Number(event.target.value) })} placeholder="不限制" /><small className="field-help">自动模式只选利用率不高于此值的 GPU。</small></label>
            </>}
            </>}
  </fieldset>
}
