import { useState } from 'react'
import { RemoteDirectoryPicker } from './RemoteDirectoryPicker'
import { FolderOpen, LoaderCircle, RotateCcw } from 'lucide-react'
import type { CondaEnvironmentConfig, CondaEnvironmentInfo, CondaManager } from '@shared/types'

interface Props {
  serverId?: string
  accessRouteId?: string
  config: CondaEnvironmentConfig
  environments: CondaEnvironmentInfo[]
  busy: boolean
  disabled?: boolean
  onChange(patch: Partial<CondaEnvironmentConfig>): void
  onReload(): void
  onCheck(): void
}

/** Shared by manual tasks and smart experiment preparation. */
export function CondaEnvironmentFields({ serverId, accessRouteId, config, environments, busy, disabled, onChange, onReload, onCheck }: Props): React.JSX.Element {
  const [picking, setPicking] = useState(false)
  const selected = environments.find(env => config.environmentPrefix ? env.prefix === config.environmentPrefix : env.name === config.environmentName || env.prefix === config.environmentName)
  const value = selected?.prefix ?? config.environmentPrefix ?? config.environmentName ?? ''
  const locked = busy || disabled
  const reset = { lastCheckStatus: 'unknown' as const, lastCheckedAt: undefined, pythonInterpreterPath: undefined, pythonVersion: undefined }
  return <><div className="experiment-conda-fields form-grid">
    <label className="field"><span>环境管理器</span><select value={config.manager} disabled={locked} onChange={event => onChange({ ...reset, manager: event.target.value as CondaManager, managerPath: undefined, environmentName: undefined, environmentPrefix: undefined })}><option value="conda">conda</option><option value="mamba">mamba</option><option value="micromamba">micromamba</option></select></label>
    <div className="field field-wide"><label htmlFor={`conda-manager-path-${serverId}`}>Conda 安装目录或管理器路径</label><div className="smart-path-row"><input id={`conda-manager-path-${serverId}`} value={config.managerPath ?? ''} disabled={locked} onChange={event => onChange({ ...reset, managerPath: event.target.value || undefined })} placeholder="自动识别；未找到环境时选择安装目录" /><button type="button" className="secondary-button" disabled={locked || !serverId || !accessRouteId} onClick={() => setPicking(true)}><FolderOpen size={14} />选择目录</button></div></div>
    <label className="field field-wide"><span>服务器已有环境</span><select aria-label="服务器已有 Conda 环境" style={{color: value ? undefined : 'var(--text-muted, #9aa0a6)'}} value={value} disabled={locked || !environments.length} onChange={event => {
      const env = environments.find(item => item.prefix === event.target.value)
      if (env) onChange({ ...reset, environmentPrefix: env.prefix, environmentName: undefined })
    }}><option value="" disabled hidden>{busy ? '正在读取服务器环境…' : environments.length ? '选择环境' : '未找到环境，请手动指定路径后重新读取'}</option>{value && !selected && <option value={value} disabled>{value}（待核对）</option>}{environments.map(env => <option key={env.prefix} value={env.prefix}>{env.name} · {env.prefix}</option>)}</select>{value && !selected && !busy && <small className="field-help">未在环境列表中找到，请重新读取或检查环境。</small>}</label>
    <div className="experiment-conda-actions field-wide">
      <button type="button" className="secondary-button" onClick={onReload} disabled={locked}>{busy ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}重新读取</button>
      <button type="button" className="secondary-button" onClick={onCheck} disabled={locked || !value}>检查所选环境</button>
    </div>
    {config.lastCheckedAt && config.lastCheckStatus && <p className="experiment-conda-python field-wide">最近检查：{config.lastCheckStatus === 'found' ? '环境存在' : config.lastCheckStatus === 'missing' ? '环境不存在' : '状态未知'}{config.lastCheckedAt ? ` · ${new Date(config.lastCheckedAt).toLocaleString('zh-CN')}` : ''}{config.pythonVersion ? ` · ${config.pythonVersion}` : ''}</p>}
  </div>
    {picking && serverId && accessRouteId && <RemoteDirectoryPicker key={`${serverId}:${accessRouteId}`} serverId={serverId} accessRouteId={accessRouteId} manager={config.manager} initialPath={config.managerPath?.replace(/\/bin\/(?:conda|mamba|micromamba)$/, '')} onClose={() => setPicking(false)} onSelect={path => { onChange({...reset, managerPath: path}); setPicking(false) }} />}
  </>
}
