import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CondaService } from './conda-service'
import type { ServerProfile } from '../shared/types'
import type { ServerSecrets } from './store'

const profile = {mode: 'real'} as ServerProfile
const secrets = {} as ServerSecrets

describe('Conda manager path resolution', () => {
  it.each(['/opt/anaconda3', '/opt/anaconda3/bin/conda'])('resolves %s before reading environments', async path => {
    const end = vi.fn()
    const exec = vi.fn().mockResolvedValueOnce('login banner\n__LABDECK_MANAGER_PATH__/opt/anaconda3/bin/conda\n').mockResolvedValueOnce(JSON.stringify({envs: ['/opt/anaconda3', '/opt/anaconda3/envs/myenv']}))
    const ssh = {connect: vi.fn(async () => ({client: {end}})), exec}
    const result = await new CondaService(ssh as never).listEnvironments(profile, secrets, 'conda', path)
    expect(result.managerPath).toBe('/opt/anaconda3/bin/conda')
    expect(result.environments).toContainEqual({name: 'myenv', prefix: '/opt/anaconda3/envs/myenv'})
    expect(exec.mock.calls[1][1]).toBe("'/opt/anaconda3/bin/conda' env list --json")
    expect(end).toHaveBeenCalledTimes(2)
  })
  it.each(['conda','mamba','micromamba'] as const)('reads environments using an automatically discovered DataLACP %s installation',async manager=>{
    const location=`/data/DataLACP/zhaogenghua/miniconda3/bin/${manager}`
    const exec=vi.fn().mockResolvedValueOnce(`__LABDECK_MANAGER_PATH__${location}\n`).mockResolvedValueOnce(JSON.stringify({envs:['/data/DataLACP/zhaogenghua/miniconda3/envs/research']}))
    const ssh={connect:vi.fn(async()=>({client:{end:vi.fn()}})),exec}
    const result=await new CondaService(ssh as never).listEnvironments(profile,secrets,manager)
    expect(result.managerPath).toBe(location)
    expect(result.environments).toContainEqual({name:'research',prefix:'/data/DataLACP/zhaogenghua/miniconda3/envs/research'})
    const probe=exec.mock.calls[0][1] as string
    expect(probe).toContain('id -un')
    expect(probe).toContain('/data/DataLACP/$labdeck_conda_user')
    expect(probe).not.toContain('find /data')
    expect(exec.mock.calls[1][1]).toBe(`'${location}' env list --json`)
  })
  it('does not try executing a directory when no executable was found', async () => {
    const exec = vi.fn(async () => '')
    const ssh = {connect: vi.fn(async () => ({client: {end: vi.fn()}})), exec}
    await expect(new CondaService(ssh as never).listEnvironments(profile, secrets, 'conda', '/not-conda')).rejects.toThrow('未找到可执行的 conda')
    expect(exec).toHaveBeenCalledTimes(1)
  })
})

describe('persistent Conda environment cache',()=>{
  const fake=()=>{
    const exec=vi.fn().mockImplementation(async(_client,command:string)=>command.includes('env list --json')?JSON.stringify({envs:['/opt/anaconda3/envs/myenv']}):command.includes('python -c')?JSON.stringify({executable:'/opt/anaconda3/envs/myenv/bin/python',version:'3.10.1'}):'__LABDECK_MANAGER_PATH__/opt/anaconda3/bin/conda\n')
    return {exec,ssh:{connect:vi.fn(async()=>({client:{end:vi.fn()}})),exec}}
  }
  it('restores cached locations and environment lists after restart without SSH or rescanning',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'labdeck-conda-cache-'))
    try{
      const file=join(directory,'cache.json'),first=fake()
      const value=await new CondaService(first.ssh as never,file).listEnvironments(profile,{password:'not-for-cache'} as ServerSecrets,'conda','/opt/anaconda3')
      expect(first.exec).toHaveBeenCalledTimes(2)
      const second=fake(),service=new CondaService(second.ssh as never,file)
      value.environments[0].name='mutated'
      expect((await service.listEnvironments(profile,secrets,'conda')).environments[0].name).toBe('myenv')
      expect((await service.listEnvironments(profile,secrets,'conda','/opt/anaconda3/bin/conda')).managerPath).toBe('/opt/anaconda3/bin/conda')
      expect(second.ssh.connect).not.toHaveBeenCalled()
      expect(await readFile(file,'utf8')).not.toContain('not-for-cache')
    }finally{await rm(directory,{recursive:true,force:true})}
  })
  it('refreshes explicitly and keeps environment validation live',async()=>{
    const {ssh,exec}=fake(),service=new CondaService(ssh as never)
    await service.listEnvironments(profile,secrets,'conda')
    exec.mockClear()
    await service.listEnvironments(profile,secrets,'conda')
    expect(exec).not.toHaveBeenCalled()
    await service.listEnvironments(profile,secrets,'conda',undefined,true)
    expect(exec).toHaveBeenCalledTimes(2)
    exec.mockClear()
    const check=await service.checkEnvironment(profile,secrets,{manager:'conda',environmentName:'myenv'})
    expect(check.found).toBe(true)
    expect(check.pythonVersion).toBe('3.10.1')
    expect(exec).toHaveBeenCalledTimes(3)
  })
  it('does not share cache across users, target endpoints, jump hosts, managers or explicit locations',async()=>{
    const {ssh,exec}=fake(),service=new CondaService(ssh as never)
    await service.listEnvironments(profile,secrets,'conda')
    for(const target of [{...profile,username:'another'},{...profile,host:'another'},{...profile,jumpHost:{host:'jump',port:22,username:'via'}}]){
      exec.mockClear()
      await service.listEnvironments(target as ServerProfile,secrets,'conda')
      expect(exec).toHaveBeenCalledTimes(2)
    }
    exec.mockClear();await service.listEnvironments(profile,secrets,'mamba');expect(exec).toHaveBeenCalledTimes(2)
    exec.mockClear();await service.listEnvironments(profile,secrets,'conda','/different');expect(exec).toHaveBeenCalledTimes(2)
  })
  it('coalesces simultaneous reads for the same target',async()=>{
    const {ssh,exec}=fake(),service=new CondaService(ssh as never)
    const values=await Promise.all([service.listEnvironments(profile,secrets,'conda'),service.listEnvironments(profile,secrets,'conda')])
    expect(exec).toHaveBeenCalledTimes(2)
    expect(values[0]).toEqual(values[1])
  })
})
