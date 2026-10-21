import { describe, expect, it, vi } from 'vitest'
import type { AppStore } from './store'
import type { SshService } from './ssh-service'
import { openRepositoryReadSession } from './repository-reader'
describe('repository file selection boundary',()=>{
  it('excludes unchecked files from tools and refuses attempts to read them',async()=>{
    const files={'README.md':'python train.py\npython excluded.py','train.py':'print(1)','excluded.py':'private project content'}
    const stat=(directory=false,size=0)=>({size,isDirectory:()=>directory,isFile:()=>!directory,isSymbolicLink:()=>false})
    const content=(handle:Buffer)=>Buffer.from(files[handle.toString().slice('/repo/'.length) as keyof typeof files])
    const open=vi.fn((path:string,_flags:string,cb:Function)=>cb(null,Buffer.from(path)))
    const sftp={realpath:(path:string,cb:Function)=>cb(null,path),stat:(path:string,cb:Function)=>cb(null,stat(path==='/repo')),lstat:(path:string,cb:Function)=>cb(null,stat(false,100)),readdir:(_path:string,cb:Function)=>cb(null,Object.entries(files).map(([filename,text])=>({filename,attrs:stat(false,text.length)}))),open,fstat:(handle:Buffer,cb:Function)=>cb(null,stat(false,content(handle).length)),read:(handle:Buffer,buffer:Buffer,offset:number,length:number,position:number,cb:Function)=>cb(null,content(handle).copy(buffer,offset,position,position+length)),close:(_handle:Buffer,cb:Function)=>cb()}
    const end=vi.fn(),server={id:'22222222-2222-4222-8222-222222222222',mode:'real',host:'example.invalid',port:22,username:'test',authType:'password',hostFingerprint:'SHA256:fixture'}
    const store={getServer:()=>server,getSecrets:()=>({})} as unknown as AppStore
    const ssh={connect:async()=>({client:{sftp:(cb:Function)=>cb(null,sftp),end}})} as unknown as SshService
    const session=await openRepositoryReadSession(store,ssh,{source:'remote',serverId:server.id,path:'/repo'},['README.md','train.py'])
    try {
      expect(session.snapshot.files.map(file=>file.path)).toEqual(['README.md','train.py'])
      expect(session.find('excluded')).toEqual([])
      expect(session.list('').files.some(file=>file.path==='excluded.py')).toBe(false)
      await expect(session.read('excluded.py')).rejects.toThrow('不在仓库文本清单')
      expect(open).not.toHaveBeenCalled()
      expect((await session.read('README.md')).text).toContain('train.py')
    } finally {session.close()}
    expect(end).toHaveBeenCalledTimes(1)
  })
})
