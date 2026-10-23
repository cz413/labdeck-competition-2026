import { describe, expect, it, vi } from 'vitest'
import { readExperimentRunLog } from './experiment-run-log'
import type { AppStore } from './store'
import type { SshService } from './ssh-service'
const taskId='11111111-1111-4111-8111-111111111111',runId='22222222-2222-4222-8222-222222222222'
function fixture(text='epoch 1 loss=0.2\n',size=100){
  const run={id:runId,logPath:'/runs/test/stdout.log',serverId:'server',accessRouteId:'direct'}
  const profile={id:'server',mode:'real',host:'test',port:22,username:'user',hostFingerprint:'trusted'}
  const store={listExperimentTasks:()=>[{id:taskId,runs:[run]}],getServer:()=>profile,getSecrets:()=>({})}
  const end=vi.fn(),exec=vi.fn(async(_client:unknown,command:string)=>`login banner\n${command.match(/__LABDECK_OUTPUT_[0-9a-f-]+__/)![0]}${size}\n${text}`)
  const ssh={connect:vi.fn(async()=>({client:{end}})),exec}
  const read=()=>readExperimentRunLog(store as unknown as AppStore,ssh as unknown as SshService,taskId,runId)
  return {read,run,profile,ssh,end}
}
describe('recorded experiment output',()=>{
  it('reads only the recorded log, strips terminal colors and closes SSH',async()=>{
    const s=fixture('\x1b[32mtraining complete\x1b[0m\n')
    expect(await s.read()).toMatchObject({path:s.run.logPath,text:'training complete\n',truncated:false})
    expect(s.ssh.exec.mock.calls[0][1]).toContain('tail -c 131072')
    expect(s.end).toHaveBeenCalledOnce()
  })
  it('marks large logs as partial and drops a partial leading line',async()=>{
    const s=fixture('partial line\nlast epoch\n',200000)
    expect(await s.read()).toMatchObject({text:'last epoch\n',truncated:true})
  })
  it('does not connect without a recorded log or trusted host',async()=>{
    const s=fixture();s.run.logPath=''
    await expect(s.read()).rejects.toThrow('未记录输出日志路径')
    s.run.logPath='/runs/stdout.log';s.profile.hostFingerprint=''
    await expect(s.read()).rejects.toThrow('主机指纹')
    expect(s.ssh.connect).not.toHaveBeenCalled()
  })
  it('closes SSH when reading fails',async()=>{
    const s=fixture();s.ssh.exec.mockRejectedValueOnce(new Error('read failed'))
    await expect(s.read()).rejects.toThrow('read failed')
    expect(s.end).toHaveBeenCalledOnce()
  })
})
