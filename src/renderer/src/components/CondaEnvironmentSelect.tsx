import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import type { CondaEnvironmentInfo } from '@shared/types'
import './conda-environment-select.css'

export function CondaEnvironmentSelect({value,environments,busy,disabled,onSelect}:{value:string;environments:CondaEnvironmentInfo[];busy:boolean;disabled?:boolean;onSelect(prefix:string):void}):React.JSX.Element {
  const [open,setOpen]=useState(false),[active,setActive]=useState(0)
  const [position,setPosition]=useState<{left:number;top:number;width:number;maxHeight:number}|null>(null)
  const trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null)
  const id=useId()
  const selected=environments.find(env=>env.prefix===value)
  const locked=disabled||busy||!environments.length
  const placeholder=busy?'正在读取服务器环境…':environments.length?'选择环境':'未找到环境，请指定安装目录后重新读取'
  function expand():void {
    if(locked)return
    setActive(Math.max(0,environments.findIndex(env=>env.prefix===value)))
    setOpen(true)
  }
  function choose(index:number):void {
    const env=environments[index]
    if(!env||locked)return
    onSelect(env.prefix);setOpen(false);trigger.current?.focus()
  }
  useEffect(()=>{setOpen(false)},[value,disabled,busy,environments])
  useEffect(()=>{
    if(!open)return
    const update=():void=>{
      const rect=trigger.current?.getBoundingClientRect();if(!rect)return
      const below=window.innerHeight-rect.bottom-12,above=rect.top-12
      const upward=below<180&&above>below
      const maxHeight=Math.min(280,Math.max(80,(upward?above:below)-6))
      const height=Math.min(maxHeight,environments.length*62+8)
      setPosition({left:Math.max(8,Math.min(rect.left,window.innerWidth-rect.width-8)),top:upward?rect.top-height-6:rect.bottom+6,width:Math.min(rect.width,window.innerWidth-16),maxHeight})
    }
    const outside=(event:PointerEvent):void=>{if(!trigger.current?.contains(event.target as Node)&&!menu.current?.contains(event.target as Node))setOpen(false)}
    const scroll=(event:Event):void=>{if(!menu.current?.contains(event.target as Node))setOpen(false)}
    update();document.addEventListener('pointerdown',outside);window.addEventListener('resize',update);window.addEventListener('scroll',scroll,true)
    return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',update);window.removeEventListener('scroll',scroll,true)}
  },[open,environments.length])
  useEffect(()=>{if(open)menu.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({block:'nearest'})},[open,active,position])
  return <div className="conda-environment-select">
    <button ref={trigger} type="button" role="combobox" aria-label="服务器已有 Conda 环境" aria-expanded={open} aria-haspopup="listbox" aria-controls={open?id:undefined} aria-activedescendant={open?`${id}-${active}`:undefined} className={`conda-environment-trigger ${open?'open':''} ${value?'has-value':''}`} disabled={!!locked} title={selected?.prefix??value??undefined} onClick={()=>open?setOpen(false):expand()} onKeyDown={event=>{
      if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();setOpen(false)}
      else if(event.key==='Tab')setOpen(false)
      else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();if(!open)expand();else setActive(index=>(index+(event.key==='ArrowDown'?1:-1)+environments.length)%environments.length)}
      else if(open&&(event.key==='Enter'||event.key===' ')){event.preventDefault();choose(active)}
      else if(open&&(event.key==='Home'||event.key==='End')){event.preventDefault();setActive(event.key==='Home'?0:environments.length-1)}
    }}><span className="conda-environment-value"><strong>{selected?.name??(value?`${value}（待核对）`:placeholder)}</strong>{selected&&<small>{selected.prefix}</small>}</span><ChevronDown size={16} aria-hidden="true"/></button>
    {open&&position&&createPortal(<div ref={menu} id={id} role="listbox" aria-label="服务器已有环境" className="conda-environment-menu" style={{position:'fixed',...position}}>{environments.map((env,index)=><button type="button" role="option" aria-selected={env.prefix===value} tabIndex={-1} id={`${id}-${index}`} data-index={index} key={env.prefix} className={`conda-environment-option ${active===index?'active':''} ${env.prefix===value?'selected':''}`} title={env.prefix} onPointerMove={()=>setActive(index)} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(index)}><span><strong>{env.name}</strong><small>{env.prefix}</small></span>{env.prefix===value&&<Check size={16} aria-hidden="true"/>}</button>)}</div>,document.body)}
  </div>
}
