import { describe, expect, it } from 'vitest'
import { parseRepositoryCandidates } from './repository-discovery'

describe('repository discovery',()=>{
  it('normalizes .git markers and root READMEs into repository directories',()=>{
    const output=['/data/proj/README.md','/data/proj','/home/u/work/mmseg/.git','/home/u/other/README.rst','relative/path','/','/home/u/other/README.md'].join('\n')
    expect(parseRepositoryCandidates(output)).toEqual([
      { path: '/data/proj', name: 'proj' },
      { path: '/home/u/other', name: 'other' },
      { path: '/home/u/work/mmseg', name: 'mmseg' }
    ])
  })
  it('drops duplicates and invalid lines',()=>{
    expect(parseRepositoryCandidates('/a/b/.git\n/a/b/.git\n\nbad\n/')).toEqual([{ path: '/a/b', name: 'b' }])
  })
})
