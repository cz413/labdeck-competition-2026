import {it,expect} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import type {ServerProfile,ServerSnapshot} from '@shared/types'
import {ResourceWorkbench} from './ResourceWorkbench'
it('shows a Chinese handshake timeout notice without changing the raw snapshot error',()=>{
  const server={id:'server',name:'测试服务器',host:'example.test',port:22,username:'user',authType:'password',mode:'real'} as ServerProfile
  const snapshot={serverId:server.id,status:'offline',sampledAt:'2026-11-05T00:00:00.000Z',gpus:[],fileSystems:[],error:'Timed out while waiting for handshake'} as unknown as ServerSnapshot
  const noop=()=>{}
  const html=renderToStaticMarkup(<ResourceWorkbench server={server} snapshot={snapshot} tasks={[]} watches={[]} accessRouteId="direct" refreshing={false} testing={false} vscodeConnecting={false} onAccessRouteChange={noop} onRefresh={noop} onTerminal={noop} onTunnel={noop} onFiles={noop} onVsCode={noop} onEdit={noop} onTest={noop} onRemove={noop} onMerge={noop} onTask={noop} onNewTask={noop} onGpuDetail={noop} onToggleWatch={noop}/>)
  expect(html).toContain('SSH 连接握手超时')
  expect(html).not.toContain('Timed out while waiting for handshake')
  expect(snapshot.error).toBe('Timed out while waiting for handshake')
})
