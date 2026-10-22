import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, LoaderCircle, X } from 'lucide-react'
import type { RepositoryDirectoryView } from '@shared/repository-guide'
import './remote-directory-picker.css'

interface Props {
  serverId: string
  accessRouteId: string
  initialPath?: string
  onSelect(path: string): void
  onClose(): void
}

export function RemoteDirectoryPicker({serverId, accessRouteId, initialPath, onSelect, onClose}: Props): React.JSX.Element {
  const [view, setView] = useState<RepositoryDirectoryView | null>(null)
  const [path, setPath] = useState(initialPath ?? '')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const request = useRef(0)
  async function browse(target?: string): Promise<void> {
    const id = ++request.current
    setBusy(true); setError('')
    try {
      const result = await window.labApi.intelligence.browseRepositoryDirectory({serverId, accessRouteId, path: target})
      if (id !== request.current) return
      setView(result); setPath(result.path)
    } catch (cause) {
      if (id === request.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (id === request.current) setBusy(false)
    }
  }
  useEffect(() => {
    void browse(initialPath?.startsWith('/') ? initialPath : undefined)
    return () => { request.current++ }
  }, [serverId, accessRouteId, initialPath])
  function openPath(): void {
    const value = path.trim()
    if (!value.startsWith('/')) { setError('请输入服务器上的绝对目录路径'); return }
    void browse(value)
  }
  return createPortal(<div className="app-modal-overlay remote-directory-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <section className="app-modal smart-browser" role="dialog" aria-modal="true" aria-label="选择 Conda 安装目录">
      <header className="dialog-header app-modal-header"><div className="dialog-title-wrap app-modal-title"><div className="dialog-icon"><FolderOpen size={18} /></div><div><h2>选择 Conda 安装目录</h2><p>{view?.path ?? '浏览服务器目录'}</p></div></div><button type="button" className="icon-button" aria-label="关闭目录选择" onClick={onClose}><X size={16} /></button></header>
      <div className="smart-browser-body">
        <div className="smart-browser-path">
          <div className="smart-browser-location"><input autoFocus aria-label="浏览目录路径" value={path} disabled={busy} onChange={event => setPath(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); openPath() } }} placeholder="输入服务器目录，例如 /opt/anaconda3" spellCheck={false} /><button type="button" className="secondary-button" disabled={busy} onClick={openPath}>打开目录</button></div>
          <div className="smart-browser-navigation"><button type="button" className="wb-text-button" disabled={busy} onClick={() => void browse(view?.home)}>主目录</button>{view?.parent && <button type="button" className="wb-text-button" disabled={busy} onClick={() => void browse(view.parent!)}>上一级</button>}</div>
        </div>
        <p className="smart-note">选择 Conda 安装目录，例如 anaconda3 或 miniconda3。</p>
        {busy ? <p className="smart-note"><LoaderCircle size={14} className="spin" /> 正在读取目录…</p> : error ? <div><p role="alert" className="intel-error">{error}</p><button type="button" className="secondary-button" onClick={openPath}>重试</button></div> : view && <div className="smart-browser-list">{view.entries.map(entry => <button type="button" key={entry.path} onClick={() => void browse(entry.path)}><FolderOpen size={14} /><span>{entry.name}</span></button>)}{!view.entries.length && <p className="smart-note">没有子目录</p>}</div>}
      </div>
      <footer className="dialog-footer app-modal-footer"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy || !!error || !view || path.trim() !== view.path} onClick={() => view && onSelect(view.path)}>选择此目录</button></footer>
    </section>
  </div>, document.body)
}
