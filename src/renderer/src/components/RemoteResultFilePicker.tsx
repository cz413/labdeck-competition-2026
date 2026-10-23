import { userFacingError } from '@shared/user-facing-error'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileText, FolderOpen, LoaderCircle, X } from 'lucide-react'
import type { SftpEntry } from '@shared/types'
import './remote-directory-picker.css'

interface Props {
  serverId:string; accessRouteId?:string; initialPath:string; serverName?:string
  onSelect(path:string):void; onClose():void
}
function normalize(path:string):string {
  const parts:string[]=[]
  for(const part of path.split('/')){if(!part||part==='.')continue;if(part==='..')parts.pop();else parts.push(part)}
  return '/'+parts.join('/')
}
export function RemoteResultFilePicker({serverId,accessRouteId,initialPath,serverName,onSelect,onClose}:Props):React.JSX.Element {
  const [path,setPath]=useState(initialPath),[directory,setDirectory]=useState(initialPath)
  const [entries,setEntries]=useState<SftpEntry[]>([]),[selected,setSelected]=useState('')
  const [busy,setBusy]=useState(true),[error,setError]=useState('')
  const request=useRef(0)
  async function browse(target:string):Promise<void>{
    if(!target.trim().startsWith('/')){setError('请输入服务器上的绝对目录路径');return}
    const id=++request.current,normalized=normalize(target.trim())
    setBusy(true);setError('');setSelected('')
    try{
      const result=await window.labApi.sftp.list(serverId,normalized,accessRouteId)
      if(id!==request.current)return
      setEntries(result);setDirectory(normalized);setPath(normalized)
    }catch(cause){if(id===request.current)setError(userFacingError(cause,'无法读取目录，请检查路径和服务器连接。'))}
    finally{if(id===request.current)setBusy(false)}
  }
  useEffect(()=>{void browse(initialPath);return()=>{request.current++}},[serverId,accessRouteId,initialPath])
  const parent=directory==='/'?null:directory.slice(0,directory.lastIndexOf('/'))||'/'
  return createPortal(<div className="app-modal-overlay remote-directory-overlay" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onClose()}}}>
    <section className="app-modal smart-browser remote-picker-browser" role="dialog" aria-modal="true" aria-labelledby="result-file-picker-title">
      <header className="dialog-header app-modal-header"><div className="dialog-title-wrap app-modal-title"><div className="dialog-icon"><FolderOpen size={18}/></div><div><h2 id="result-file-picker-title">选择结果文件</h2><p>{serverName?`${serverName} · `:''}{directory}</p></div></div><button type="button" className="icon-button" aria-label="关闭文件选择" onClick={onClose}><X size={16}/></button></header>
      <div className="smart-browser-body">
        <div className="smart-browser-path"><div className="smart-browser-location"><input autoFocus aria-label="结果文件所在目录" value={path} disabled={busy} onChange={event=>setPath(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();void browse(path)}}}/><button type="button" className="secondary-button" disabled={busy} onClick={()=>void browse(path)}>前往</button></div><div className="smart-browser-navigation"><button type="button" className="wb-text-button" disabled={busy} onClick={()=>void browse(initialPath)}>起始目录</button>{parent&&<button type="button" className="wb-text-button" disabled={busy} onClick={()=>void browse(parent)}>上一级</button>}</div></div>
        <p className="smart-note">点击文件夹浏览，选中文件后点击“使用所选文件”。</p>
        <div className="remote-picker-entries">{busy?<p className="smart-note"><LoaderCircle className="spin" size={14}/>正在读取目录…</p>:error?<div><p className="intel-error" role="alert">{error}</p><button type="button" className="secondary-button" onClick={()=>void browse(path)}>重试</button></div>:<div className="smart-browser-list">{entries.filter(entry=>entry.type==='directory'||entry.type==='file').map(entry=><button type="button" key={entry.path} className={selected===entry.path?'selected':''} aria-pressed={entry.type==='file'?selected===entry.path:undefined} onClick={()=>entry.type==='directory'?void browse(entry.path):setSelected(entry.path)}>{entry.type==='directory'?<FolderOpen size={14}/>:<FileText size={14}/>}<span>{entry.name}</span></button>)}{!entries.some(entry=>entry.type==='directory'||entry.type==='file')&&<p className="smart-note">此目录没有可选择的文件或子目录。</p>}</div>}</div>
      </div>
      <footer className="dialog-footer app-modal-footer remote-picker-footer">
        {path.trim()!==directory&&<p className="smart-note" role="status">路径已修改，请先点击“前往”或按回车加载。</p>}
        <div className="remote-picker-confirm"><div className="remote-picker-current"><span>{selected?'所选文件':'当前目录'}</span><code title={selected||directory}>{busy?'正在读取…':error?'尚未加载有效目录':selected||directory}</code></div><button type="button" className="primary-button" disabled={busy||!!error||!selected||path.trim()!==directory} onClick={()=>onSelect(selected)}>使用所选文件</button></div>
      </footer>
    </section>
  </div>,document.body)
}
