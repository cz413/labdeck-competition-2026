import { describe, expect, it } from 'vitest'
import { resolveStdoutLogPath } from './experiment-log-path'
describe('configured stdout log path',()=>{
  it('keeps defaults and substitutes only the run identifier',()=>{
    expect(resolveStdoutLogPath(undefined,'run')).toBeUndefined()
    expect(resolveStdoutLogPath('','run')).toBeUndefined()
    expect(resolveStdoutLogPath('/data/logs/{runId}/stdout.log','abc')).toBe('/data/logs/abc/stdout.log')
  })
  it.each(['relative.log','~/log.txt','/logs/','/log\nother','/log\0bad','/logs/{unknown}.txt'])('rejects invalid file locations %j',value=>{
    expect(()=>resolveStdoutLogPath(value,'run')).toThrow()
  })
})
