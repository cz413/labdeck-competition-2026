import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshConfigService } from './ssh-config-service'
import type { AppStore } from './store'
import type { ServerProfile, ServerProfileInput } from '../shared/types'
import { renderManagedSshConfig, vscodeSshAlias } from './vscode-service'

const tempPaths: string[] = []
const service = new SshConfigService({} as AppStore)

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('SshConfigService', () => {
  it('parses resolved OpenSSH configuration', () => {
    const result = service.parseSshG(
      'gpu-prod',
      [
        'host gpu-prod',
        'hostname 10.20.0.21',
        'user researcher',
        'port 2202',
        'identityfile ~/.ssh/id_ed25519',
        'proxyjump lab-gateway'
      ].join('\n')
    )

    expect(result).toMatchObject({
      alias: 'gpu-prod',
      host: '10.20.0.21',
      port: 2202,
      username: 'researcher',
      proxyJump: 'lab-gateway'
    })
    expect(result.identityFile).toContain('id_ed25519')
  })

  it('collects concrete Host aliases and skips wildcard templates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labpilot-ssh-config-'))
    tempPaths.push(root)
    await mkdir(join(root, 'config.d'))
    await writeFile(
      join(root, 'config'),
      ['Host *', '  ServerAliveInterval 30', 'Host gpu-01 gpu-02', 'Include config.d/*'].join('\n')
    )
    await writeFile(
      join(root, 'config.d', 'storage.conf'),
      ['Host storage-*', '  User lab', 'Host storage-main', '  HostName 10.20.0.31'].join('\n')
    )

    await expect(service.collectAliases(join(root, 'config'))).resolves.toEqual([
      'gpu-01',
      'gpu-02',
      'storage-main'
    ])
  })
})

const profile = (overrides: Partial<ServerProfile> = {}): ServerProfile => ({
  id: '11111111-1111-4111-8111-111111111111', name: 'gpu8', host: '192.0.2.8', port: 22,
  username: 'researcher', authType: 'privateKey', privateKeyPath: 'C:/keys/gpu8',
  hostFingerprint: 'SHA256:trusted', tags: ['keep-tag'], group: 'SSH Config', mode: 'real',
  monitorPolicy: 'background', hasSecret: true, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  ...overrides
})

async function importFixture(existing: ServerProfile[] = [], aliases = ['gpu8']) {
  const root = await mkdtemp(join(tmpdir(), 'labdeck-ssh-import-'))
  tempPaths.push(root)
  const original = profile()
  const generatedName = vscodeSshAlias(original.id, original.name)
  await writeFile(join(root, 'config'), ['Include generated.conf', ...aliases.map(alias => 'Host ' + alias)].join('\n'))
  await writeFile(join(root, 'generated.conf'), renderManagedSshConfig([original]))
  const records = structuredClone(existing)
  const saveServer = vi.fn(async (input: ServerProfileInput) => {
    const saved = profile({ ...input, id: '33333333-3333-4333-8333-333333333333' })
    records.push(saved)
    return structuredClone(saved)
  })
  const renameServer = vi.fn(async (id: string, name: string) => {
    const record = records.find(item => item.id === id)!
    record.name = name
    return structuredClone(record)
  })
  const mergeSshConfigJumpHost = vi.fn(async (id: string) => structuredClone(records.find(item => item.id === id)!))
  const importer = new SshConfigService({listServers: () => structuredClone(records), saveServer, renameServer, mergeSshConfigJumpHost} as unknown as AppStore)
  Object.assign(importer, { configPath: join(root, 'config') })
  const resolver = vi.spyOn(importer as unknown as { resolveAlias(alias: string): Promise<ReturnType<SshConfigService['parseSshG']>> }, 'resolveAlias')
    .mockImplementation(async alias => ({alias,host:original.host,port:22,username:original.username,identityFile:original.privateKeyPath}))
  return {root,importer,records,saveServer,renameServer,resolver,generatedName,mergeSshConfigJumpHost}
}

describe('SSH config generated-target import regression', () => {
  it('skips app-generated files in wildcard Includes but keeps ordinary labdeck aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'labdeck-ssh-generated-'))
    tempPaths.push(root)
    await mkdir(join(root, 'config.d'))
    await writeFile(join(root, 'config'), 'Include config.d/*\nHost gpu8\n')
    await writeFile(join(root, 'config.d', 'copied-managed.conf'), renderManagedSshConfig([profile({jumpHost:{host:'192.0.2.1',port:22,username:'relay',authType:'password'}})]))
    await writeFile(join(root, 'config.d', 'user.conf'), 'Host labdeck-custom\n')
    const generated = new Set<string>()
    await expect(service.collectAliases(join(root, 'config'), generated)).resolves.toEqual(['labdeck-custom', 'gpu8'])
    expect(generated).toContain(vscodeSshAlias(profile().id, 'gpu8'))
    expect(generated).toContain(vscodeSshAlias(profile().id, 'gpu8') + '-jump')
  })

  it('imports original aliases even when generated Include is first and is idempotent', async () => {
    const f = await importFixture()
    const result = await f.importer.importAll()
    expect(result.imported.map(server => server.name)).toEqual(['gpu8'])
    expect(f.resolver.mock.calls.map(call => call[0])).toEqual(['gpu8'])
    expect(f.saveServer).toHaveBeenCalledOnce()
    const again = await f.importer.importAll()
    expect(again.imported).toEqual([])
    expect(again.skipped).toEqual(['gpu8'])
    expect(f.records).toHaveLength(1)
    expect(f.saveServer).toHaveBeenCalledOnce()
  })

  it('repairs an imported generated name without replacing the existing profile or connection settings', async () => {
    const generatedName = vscodeSshAlias(profile().id, 'gpu8')
    const existing = profile({id:'22222222-2222-4222-8222-222222222222',name:generatedName,
      defaultAccessRouteId:'direct',accessRoutes:[{id:'direct',name:'默认',kind:'direct',host:'192.0.2.8',port:22,username:'researcher',authType:'privateKey',privateKeyPath:'C:/keys/retained',hostFingerprint:'SHA256:retained'}]})
    const f = await importFixture([existing])
    const result = await f.importer.importAll()
    expect(result.imported).toEqual([{...existing,name:'gpu8'}])
    expect(f.renameServer).toHaveBeenCalledExactlyOnceWith(existing.id,'gpu8')
    expect(f.saveServer).not.toHaveBeenCalled()
    expect(f.mergeSshConfigJumpHost).not.toHaveBeenCalled()
    await f.importer.importAll()
    expect(f.renameServer).toHaveBeenCalledOnce()
  })

  it('preserves custom names that are not aliases from a generated file', async () => {
    const f = await importFixture([profile({name:'my-training-server'})])
    const result = await f.importer.importAll()
    expect(result.skipped).toEqual(['gpu8'])
    expect(f.records[0].name).toBe('my-training-server')
    expect(f.renameServer).not.toHaveBeenCalled()
    expect(f.saveServer).not.toHaveBeenCalled()
  })

  it('prefers an existing original name over an earlier generated duplicate at the same endpoint', async () => {
    const duplicate = profile({name:vscodeSshAlias(profile().id,'gpu8')})
    const original = profile({id:'22222222-2222-4222-8222-222222222222'})
    const f = await importFixture([duplicate, original])
    await f.importer.importAll()
    expect(f.renameServer).not.toHaveBeenCalled()
    expect(f.saveServer).not.toHaveBeenCalled()
    expect(f.records).toEqual([duplicate, original])
  })

  it('restores the direct name when the original jump alias appears first', async () => {
    const existing = profile({name:vscodeSshAlias(profile().id,'gpu8')})
    const f = await importFixture([existing], ['gpu8-jump','gpu8'])
    f.resolver.mockImplementation(async alias => ({alias,host:existing.host,port:22,username:existing.username,proxyJump:alias.endsWith('-jump')?'gateway':undefined}))
    vi.spyOn(f.importer as unknown as { resolveJumpHostForAlias(alias: string): Promise<ServerProfile['jumpHost']> }, 'resolveJumpHostForAlias')
      .mockResolvedValue({host:'192.0.2.1',port:22,username:'relay',authType:'password'})
    await f.importer.importAll()
    expect(f.renameServer).toHaveBeenCalledExactlyOnceWith(existing.id,'gpu8')
    expect(f.mergeSshConfigJumpHost).toHaveBeenCalledOnce()
    expect(f.records[0].name).toBe('gpu8')
  })

  it('does not rename a different SSH account at the same host', async () => {
    const existing = profile({name:vscodeSshAlias(profile().id,'gpu8'),username:'other-account'})
    const f = await importFixture([existing])
    const result = await f.importer.importAll()
    expect(f.renameServer).not.toHaveBeenCalled()
    expect(result.imported[0].name).toBe('gpu8')
    expect(f.records[0]).toEqual(existing)
  })
})
