import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, FolderOpen, LoaderCircle, X } from 'lucide-react'
import type { RepositoryDirectoryView } from '@shared/repository-guide'
import type { CondaManager } from '@shared/types'
import { userFacingError } from '@shared/user-facing-error'
import './remote-directory-picker.css'

interface Props {
  serverId: string
  accessRouteId: string
  initialPath?: string
  title?: string
  manager?: CondaManager
  onSelect(path: string): void
  onClose(): void
}

export function RemoteDirectoryPicker({serverId, accessRouteId, initialPath, title = '选择目录', manager, onSelect, onClose}: Props): React.JSX.Element {
  const titleId = useId()
  const [view, setView] = useState<RepositoryDirectoryView | null>(null)
  const [path, setPath] = useState(initialPath ?? '')
  const [busy, setBusy] = useState(true)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [selectionError, setSelectionError] = useState('')
  const request = useRef(0)
  const loading = busy || checking
  const pendingPath = !!view && path.trim() !== view.path
  async function browse(target?: string): Promise<void> {
    const id = ++request.current
    setBusy(true); setChecking(false); setError(''); setSelectionError('')
    try {
      const result = await window.labApi.intelligence.browseRepositoryDirectory({serverId, accessRouteId, path: target})
      if (id !== request.current) return
      setView(result); setPath(result.path)
    } catch (cause) {
      if (id === request.current) setError(userFacingError(cause, '无法读取目录，请检查路径和服务器连接。'))
    } finally {
      if (id === request.current) setBusy(false)
    }
  }
  useEffect(() => {
    setView(null)
    void browse(initialPath?.startsWith('/') ? initialPath : undefined)
    return () => { request.current++ }
  }, [serverId, accessRouteId, initialPath, manager])
  function openPath(): void {
    if (loading) return
    const value = path.trim()
    if (!value.startsWith('/')) { setError('请输入服务器上的绝对目录路径'); return }
    void browse(value)
  }
  async function useDirectory(): Promise<void> {
    if (!view || loading || error || pendingPath) return
    const directory = view.path
    if (!manager) { onSelect(directory); return }
    const id = ++request.current
    setChecking(true); setSelectionError('')
    try {
      // Inspect files only; choosing a folder never executes or installs software.
      const entries = await window.labApi.sftp.list(serverId, directory, accessRouteId)
      if (id !== request.current) return
      let found = entries.some(entry => entry.name === manager && (entry.type === 'file' || entry.type === 'link'))
      for (const folder of ['bin', 'condabin']) {
        if (found) break
        if (!entries.some(entry => entry.name === folder && (entry.type === 'directory' || entry.type === 'link'))) continue
        const files = await window.labApi.sftp.list(serverId, `${directory.replace(/\/$/, '')}/${folder}`, accessRouteId)
        if (id !== request.current) return
        found = files.some(entry => entry.name === manager && (entry.type === 'file' || entry.type === 'link'))
      }
      if (!found) { setSelectionError(`此目录未找到 ${manager} 管理器文件，请选择对应的安装目录。`); return }
      onSelect(directory)
    } catch (cause) {
      if (id === request.current) setSelectionError(userFacingError(cause, '无法检查此目录，请检查访问权限和服务器连接。'))
    } finally {
      if (id === request.current) setChecking(false)
    }
  }
  return createPortal(<div className="app-modal-overlay remote-directory-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <section className="app-modal smart-browser remote-picker-browser" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="dialog-header app-modal-header"><div className="dialog-title-wrap app-modal-title"><div className="dialog-icon"><FolderOpen size={18} /></div><div><h2 id={titleId}>{manager ? `选择 ${manager === 'conda' ? 'Conda' : manager} 安装目录` : title}</h2></div></div><button type="button" className="icon-button" aria-label="关闭目录选择" onClick={onClose}><X size={16} /></button></header>
      <div className="smart-browser-body">
        <div className="smart-browser-path">
          <div className="smart-browser-location"><input autoFocus aria-label="浏览目录路径" value={path} disabled={loading} onChange={event => { setPath(event.target.value); setSelectionError('') }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); openPath() } }} placeholder="输入服务器目录，例如 /opt/miniconda3" spellCheck={false} /><button type="button" className="secondary-button" disabled={loading || !path.trim()} onClick={openPath}>前往</button></div>
          <div className="smart-browser-navigation"><button type="button" className="wb-text-button" disabled={loading} onClick={() => void browse(view?.home)}>主目录</button><button type="button" className="wb-text-button" disabled={loading || !view?.parent} onClick={() => view?.parent && void browse(view.parent)}>上一级</button></div>
        </div>
        <p className="smart-note">点击文件夹进入下一级，找到安装目录后点击“使用当前目录”。</p>
        <div className="remote-picker-entries" aria-busy={busy}>
          {busy ? <p className="smart-note" role="status"><LoaderCircle size={14} className="spin" /> 正在读取目录…</p> : error ? <div><p role="alert" className="intel-error">{error}</p><button type="button" className="secondary-button" onClick={openPath}>重试</button></div> : view && <div className="smart-browser-list">{view.entries.map(entry => <button type="button" key={entry.path} disabled={checking} onClick={() => void browse(entry.path)}><FolderOpen size={14} /><span>{entry.name}</span><ChevronRight className="remote-picker-enter" size={14} /></button>)}{!view.entries.length && <p className="smart-note">没有子目录，可使用当前目录或返回上一级。</p>}</div>}
        </div>
      </div>
      <footer className="dialog-footer app-modal-footer remote-picker-footer">
        {(selectionError || pendingPath) && <p className={selectionError ? 'intel-error' : 'smart-note'} role={selectionError ? 'alert' : 'status'}>{selectionError || '路径已修改，请先点击“前往”或按回车加载。'}</p>}
        <div className="remote-picker-confirm"><div className="remote-picker-current"><span>当前目录</span><code title={view?.path}>{busy ? '正在读取…' : error ? '尚未加载有效目录' : view?.path ?? '尚未选择'}</code></div><button type="button" className="primary-button" disabled={loading || !!error || !view || pendingPath} onClick={() => void useDirectory()}>{checking ? <><LoaderCircle size={14} className="spin" />检查中…</> : '使用当前目录'}</button></div>
      </footer>
    </section>
  </div>, document.body)
}
