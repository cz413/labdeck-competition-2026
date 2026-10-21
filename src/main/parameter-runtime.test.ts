import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, sep } from 'node:path'
import { createHash } from 'node:crypto'
const script=resolve('scripts/patch-cangjie-runtime.cjs'),source=resolve('resources/cangjie/libcangjie-runtime.dll')
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
describe.skipIf(process.platform!=='win32')('pinned Windows runtime compatibility backport',()=>{
  it('verifies the shipped DLL hash and reports that the local build is unsigned',()=>{
    const result=spawnSync(process.execPath,[script,source,'--check'],{encoding:'utf8'})
    expect(result.status,result.stderr).toBe(0)
    const manifest=JSON.parse(result.stdout)
    expect(manifest.localUnsignedBackport).toBe(true)
    expect(manifest.patchedSha256).toBe(sha(readFileSync(source)))
  })
  it('is idempotent and refuses an altered runtime without modifying it',()=>{
    const directory=mkdtempSync(join(tmpdir(),'labdeck-runtime-')),target=join(directory,'runtime.dll')
    try {
      copyFileSync(source,target)
      const before=readFileSync(target)
      expect(spawnSync(process.execPath,[script,target]).status).toBe(0)
      expect(readFileSync(target).equals(before)).toBe(true)
      const altered=Buffer.from(before);altered[altered.length-1]^=1;writeFileSync(target,altered)
      const refused=spawnSync(process.execPath,[script,target],{encoding:'utf8'})
      expect(refused.status).toBe(1);expect(refused.stderr).toContain('Unsupported runtime SHA256')
      expect(readFileSync(target).equals(altered)).toBe(true)
    } finally {if(!resolve(directory).startsWith(resolve(tmpdir())+sep))throw new Error('Unexpected cleanup path');rmSync(directory,{recursive:true,force:true})}
  })
})
