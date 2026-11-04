import { describe, expect, it, vi } from 'vitest'
import { runRepositoryAgent } from './repository-agent'
import type { RepositoryFile, RepositorySnapshot } from '../shared/repository-guide'
import type { RepositoryReadSession } from './repository-reader'

function session(): RepositoryReadSession {
  const files: RepositoryFile[] = [
    { path: 'README.md', sizeBytes: 100 },
    { path: 'finetune.py', sizeBytes: 100 },
    { path: 'scripts/train_common.sh', sizeBytes: 100 },
    { path: 'src/model.py', sizeBytes: 100 },
    { path: 'src/deep/config.yaml', sizeBytes: 100 },
    { path: 'src/deep/final.yaml', sizeBytes: 100 }
  ]
  const snapshot: RepositorySnapshot = {
    input: { source: 'remote', serverId: '22222222-2222-4222-8222-222222222222', path: '/repo' },
    files, excerpts: [], warnings: [], collectedAt: '2026-10-21T00:00:00.000Z'
  }
  const read = vi.fn(async (path: string) => {
    const excerpt = { path, text: path === 'README.md' ? '# Repo\nbash scripts/train_common.sh' : `contents of ${path}`, startLine: 1, truncated: false }
    if (!snapshot.excerpts.some(item => item.path === path)) snapshot.excerpts.push(excerpt)
    return excerpt
  })
  return {
    snapshot, maxChars: 300_000, read,
    list: () => ({ directories: ['scripts', 'src'], files: [] }),
    find: (pattern: string) => files.filter(file => file.path.includes(pattern)),
    close: () => {}
  }
}

describe('repository reconnaissance agent',()=>{
  it('reads a script requested after the seed files and then finishes',async()=>{
    const tools=session()
    const request=vi.fn()
      .mockResolvedValueOnce({ action: 'inspect', toolCalls: [{ tool: 'read_file', arguments: { path: 'src/deep/config.yaml' }, reason: 'README 引用了该配置' }], reason: 'need config' })
      .mockResolvedValueOnce({ action: 'done', reason: 'enough' })
    const progress=vi.fn()
    const result=await runRepositoryAgent({ goal: '训练', session: tools, request, onProgress: progress })
    expect(result).toEqual({ rounds: 2, toolCalls: 1 })
    expect(tools.read).toHaveBeenCalledWith('src/deep/config.yaml')
    expect(progress).toHaveBeenCalledWith('读取文件：src/deep/config.yaml', 1)
    expect(request.mock.calls[0][1]).toMatchObject({ goal: '训练', totalFiles: 6 })
    expect((request.mock.calls[0][1] as { files: unknown[] }).files.length).toBe(6)
  })
  it('provides every permitted file before asking the model to judge, including deep implementation files',async()=>{
    const tools=session()
    const request=vi.fn(async()=>{
      expect(tools.snapshot.excerpts.map(file=>file.path).sort()).toEqual(tools.snapshot.files.map(file=>file.path).sort())
      return {action:'done'}
    })
    await runRepositoryAgent({goal:'先跑一次基线',session:tools,request})
    expect(request).toHaveBeenCalledOnce()
  })
  it('continues autonomously with an explicit warning when a file cannot be read',async()=>{
    const tools=session(),original=tools.read
    tools.read=vi.fn(async path=>{if(path==='src/model.py')throw new Error('读取额度不足');return original(path)})
    const request=vi.fn().mockResolvedValue({action:'done'})
    await runRepositoryAgent({goal:'训练',session:tools,request})
    expect(request).toHaveBeenCalledOnce()
    expect(tools.snapshot.warnings.join()).toContain('src/model.py')
  })
  it('reads every common entry before model selection without preferring train.py',async()=>{
    const tools=session()
    tools.snapshot.files.push(...['main.py','run.py','train.py','launch.py','sub/main_stage.py'].map(path=>({path,sizeBytes:100})))
    const request=vi.fn(async()=>{
      const read=tools.snapshot.excerpts.map(file=>file.path)
      for(const path of ['main.py','run.py','train.py','launch.py','sub/main_stage.py'])expect(read).toContain(path)
      return {action:'done'}
    })
    await runRepositoryAgent({goal:'先跑一次基线',session:tools,request})
    expect(request).toHaveBeenCalledOnce()
  })
  it('does not execute tools on the final round',async()=>{
    const tools=session()
    const request=vi.fn()
      .mockResolvedValueOnce({ action: 'inspect', toolCalls: [{ tool: 'read_file', arguments: { path: 'src/deep/config.yaml' }, reason: 'x' }], reason: 'x' })
      .mockResolvedValueOnce({ action: 'inspect', toolCalls: [{ tool: 'read_file', arguments: { path: 'src/deep/final.yaml' }, reason: 'x' }], reason: 'x' })
    const result=await runRepositoryAgent({ goal: '训练', session: tools, request, maxRounds: 2 })
    expect(result).toEqual({ rounds: 2, toolCalls: 1 })
    expect(tools.read).toHaveBeenCalledWith('src/deep/config.yaml')
    expect(vi.mocked(tools.read).mock.calls.filter(([path])=>path==='src/deep/final.yaml')).toHaveLength(1)
  })
  it('surfaces an invalid agent response to the caller',async()=>{
    const tools=session()
    const request=vi.fn().mockResolvedValue({ action: 'inspect', toolCalls: [] })
    await expect(runRepositoryAgent({ goal: '训练', session: tools, request })).rejects.toThrow()
  })
})
