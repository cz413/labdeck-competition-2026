import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ExperimentTask, ServerProfile, TunnelConfigInput } from '../shared/types'
vi.mock('electron', () => ({ app: { getPath: () => '.' }, safeStorage: {} }))
import { AppStore } from './store'

describe('settings persistence', () => {
  it('keeps the selected theme across unrelated updates and a restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'labdeck-theme-'))
    const filePath = join(directory, 'lab-server-manager.json')
    const store = new AppStore()
    Object.assign(store, { filePath })
    try {
      await store.initialize()
      await store.saveSettings({ theme: 'instrument' })
      await Promise.all([
        store.saveSettings({ serverOrder: ['server-a'] }),
        store.saveSettings({ gpuWatches: [{ serverId: '11111111-1111-4111-8111-111111111111' }] }),
        store.saveSettings({ closeBehavior: 'tray' }),
        store.saveSettings({ pollingIntervalSeconds: 60 })
      ])
      const persisted = JSON.parse(await readFile(filePath, 'utf8'))
      expect(persisted.settings).toMatchObject({ theme: 'instrument', closeBehavior: 'tray', pollingIntervalSeconds: 60, serverOrder: ['server-a'] })
      const restarted = new AppStore()
      Object.assign(restarted, { filePath })
      await restarted.initialize()
      expect(restarted.getSettings()).toEqual(store.getSettings())

      await Promise.all(['ocean', 'instrument', 'ocean', 'instrument'].map(theme =>
        store.saveSettings({ theme: theme as 'ocean' | 'instrument' })
      ))
      await restarted.initialize()
      expect(restarted.getSettings().theme).toBe('instrument')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects an invalid patch without replacing saved settings', async () => {
    const store = new AppStore()
    const settings = { theme: 'instrument', monitoringEnabled: true, pollingIntervalSeconds: 30, maxConcurrentPolls: 5, minimizeToTray: true, closeBehavior: 'ask', notifyOnWarning: true, serverOrder: [], gpuWatches: [] }
    const persist = vi.fn(async () => undefined)
    Object.assign(store, { data: { settings }, persist })
    await expect(store.saveSettings({ pollingIntervalSeconds: 0 })).rejects.toThrow()
    expect(store.getSettings()).toEqual(settings)
    expect(persist).not.toHaveBeenCalled()
  })
})

function taskStore(status: string, runStatuses: string[], archived = false) {
  const task = { id: 'task', status, archived, runs: runStatuses.map((runStatus) => ({ status: runStatus })) } as ExperimentTask
  const data = { experimentTasks: [task] }
  const store = new AppStore()
  const persist = vi.fn(async () => undefined)
  Object.assign(store, { data, persist })
  return { store, data, persist }
}

describe('task deletion', () => {
  it.each(['planned', 'queued', 'cancelled', 'completed', 'failed', 'paused'])('deletes a %s task and its local history', async (status) => {
    const { store, data, persist } = taskStore(status, ['cancelled', 'completed', status])
    await store.deleteExperimentTask('task')
    expect(data.experimentTasks).toEqual([])
    expect(persist).toHaveBeenCalledOnce()
  })

  it('allows deleting archived tasks with history', async () => {
    const { store, data } = taskStore('completed', ['completed'], true)
    await store.deleteExperimentTask('task')
    expect(data.experimentTasks).toEqual([])
  })

  it.each(['preparing', 'running'])('protects a %s task', async (status) => {
    const { store, data, persist } = taskStore(status, [])
    await expect(store.deleteExperimentTask('task')).rejects.toThrow('先取消运行')
    expect(data.experimentTasks).toHaveLength(1)
    expect(persist).not.toHaveBeenCalled()
  })

  it('checks current run status even if the task status is stale', async () => {
    const { store, data } = taskStore('queued', ['preparing'])
    await expect(store.deleteExperimentTask('task')).rejects.toThrow('先取消运行')
    expect(data.experimentTasks).toHaveLength(1)
  })
})

describe('saved SSH tunnels', () => {
  const serverId = '11111111-1111-4111-8111-111111111111'
  const server: ServerProfile = { id: serverId, name: 'gpu', host: 'gpu.test', port: 22, username: 'user', authType: 'password', hasSecret: true, mode: 'real', monitorPolicy: 'manual', group: '', tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  const input: TunnelConfigInput = { name: 'Jupyter', serverId, accessRouteId: 'direct', type: 'local', bindAddress: '127.0.0.1', bindPort: 8888, targetHost: '127.0.0.1', targetPort: 8888, browserProtocol: 'http', autoStart: false, autoReconnect: true }
  const fixture = () => {
    const store = new AppStore()
    const data = { servers: [structuredClone(server)], tunnels: [], secrets: {}, lastSnapshots: {}, gpuHistory: {}, settings: { gpuWatches: [], serverOrder: [] } }
    const persist = vi.fn(async () => undefined)
    Object.assign(store, { data, persist })
    return { store, data, persist }
  }
  it('saves and updates a config without adding duplicate records or credentials', async () => {
    const { store, persist } = fixture()
    const saved = await store.saveTunnel({ ...input, password: 'not-persisted' } as TunnelConfigInput)
    await store.saveTunnel({ ...input, id: saved.id, bindPort: 18888 })
    expect(store.listTunnels()).toHaveLength(1)
    expect(store.getTunnel(saved.id)).toMatchObject({ bindPort: 18888, createdAt: saved.createdAt })
    expect(store.getTunnel(saved.id)).not.toHaveProperty('password')
    expect(persist).toHaveBeenCalledTimes(2)
  })
  it('rejects deleted routes and demonstration servers without persisting', async () => {
    const { store, data, persist } = fixture()
    await expect(store.saveTunnel({ ...input, accessRouteId: 'gone' })).rejects.toThrow('连接路径不存在')
    data.servers[0].mode = 'demo'
    await expect(store.saveTunnel(input)).rejects.toThrow('真实服务器')
    expect(persist).not.toHaveBeenCalled()
  })
  it('removes the related tunnel configs when a server is deleted', async () => {
    const { store } = fixture()
    await store.saveTunnel(input)
    await store.removeServer(serverId)
    expect(store.listTunnels()).toEqual([])
  })
  it('migrates tunnel references when duplicate server routes are merged', async () => {
    const { store, data } = fixture()
    const sourceId = '33333333-3333-4333-8333-333333333333'
    data.servers.push({ ...server, id: sourceId, name: 'gpu-jump', jumpHost: { host: 'jump.test', port: 22, username: 'relay', authType: 'password' } })
    const saved = await store.saveTunnel({ ...input, serverId: sourceId, accessRouteId: 'jump' })
    const merged = await store.mergeAccessRoute(serverId, sourceId)
    const tunnel = store.getTunnel(saved.id)
    expect(tunnel.serverId).toBe(serverId)
    expect(merged.accessRoutes?.some(route => route.id === tunnel.accessRouteId && route.kind === 'jump')).toBe(true)
  })
})

describe('SSH import display-name repair', () => {
  it('changes only the name and timestamp, preserving credentials, routes and all references', async () => {
    const store = new AppStore()
    const server = {id:'11111111-1111-4111-8111-111111111111',name:'labdeck-gpu8-abcdef',host:'192.0.2.8',port:22,username:'user',authType:'password',hasSecret:true,hostFingerprint:'SHA256:retained',jumpHost:{host:'192.0.2.1',port:22,username:'relay',authType:'password',hasSecret:true},accessRoutes:[{id:'direct',name:'默认',kind:'direct',host:'192.0.2.8',port:22,username:'user',authType:'password'}],defaultAccessRouteId:'direct',tags:['custom'],group:'SSH Config',mode:'real',monitorPolicy:'background',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'} as ServerProfile
    const data={servers:[structuredClone(server)],secrets:{[server.id]:'opaque-encrypted-secret'},settings:{serverOrder:[server.id],gpuWatches:[{serverId:server.id,gpuUuid:'gpu0'}]},lastSnapshots:{[server.id]:{serverId:server.id}},gpuHistory:{[server.id+'::gpu0']:[{value:123}]},experimentTasks:[{serverId:server.id}],tunnels:[{serverId:server.id}]}
    const before=structuredClone(data)
    const persist=vi.fn(async()=>undefined)
    Object.assign(store,{data,persist})
    const renamed=await store.renameServer(server.id,'gpu8')
    expect(renamed).toEqual({...server,name:'gpu8',updatedAt:renamed.updatedAt})
    expect(data).toEqual({...before,servers:[renamed]})
    expect(persist).toHaveBeenCalledOnce()
    renamed.tags.push('outside')
    expect(store.getServer(server.id).tags).toEqual(['custom'])
    await expect(store.renameServer(server.id,'   ')).rejects.toThrow()
    await expect(store.renameServer('deleted','gpu8')).rejects.toThrow('不存在')
    expect(persist).toHaveBeenCalledOnce()
  })
})

describe('task project evidence persistence',()=>{
  it('saves an incomplete draft, edits it in place, and reloads its compact project evidence',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'labdeck-project-evidence-'))
    const resolved=await import('node:path').then(p=>p.resolve(directory)),parent=await import('node:path').then(p=>p.resolve(tmpdir()))
    const filePath=join(directory,'lab-server-manager.json'),store=new AppStore()
    Object.assign(store,{filePath})
    try{
      await store.initialize()
      const context={rootPath:'/repo',serverId:'22222222-2222-4222-8222-222222222222',generatedAt:new Date().toISOString(),summary:'尚需数据目录',configurationKey:'[]',warnings:[],questions:['数据目录在哪里？'],citations:[],checks:[],steps:[]}
      const saved=await store.saveExperimentTask((await import('../shared/schemas')).experimentTaskDraftSchema.parse({title:'项目草稿',projectPreparation:context}))
      expect(saved.status).toBe('planned');expect(saved.runs).toEqual([])
      await store.saveExperimentTask({...saved,title:'补充后的草稿',launchCommand:'python train.py'})
      const restarted=new AppStore();Object.assign(restarted,{filePath});await restarted.initialize()
      expect(restarted.listExperimentTasks()).toHaveLength(1)
      expect(restarted.listExperimentTasks()[0]).toMatchObject({id:saved.id,title:'补充后的草稿',projectPreparation:context,runs:[]})
    }finally{
      if(!resolved.startsWith(parent+'\\')&&!resolved.startsWith(parent+'/'))throw new Error('Unsafe temporary test path')
      await rm(resolved,{recursive:true,force:true})
    }
  })
})
