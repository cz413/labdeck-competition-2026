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
  it('does not try executing a directory when no executable was found', async () => {
    const exec = vi.fn(async () => '')
    const ssh = {connect: vi.fn(async () => ({client: {end: vi.fn()}})), exec}
    await expect(new CondaService(ssh as never).listEnvironments(profile, secrets, 'conda', '/not-conda')).rejects.toThrow('未找到可执行的 conda')
    expect(exec).toHaveBeenCalledTimes(1)
  })
})
