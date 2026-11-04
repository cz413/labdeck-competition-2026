import {it,expect} from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ResearchOutputNames,outputBatchName} from './research-output-names'
it('allocates stable distinct names across restarts and continues after z',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'labdeck-output-names-'))
  try{
    const file=join(directory,'names.json'),names=new ResearchOutputNames(file)
    expect(await Promise.all([names.allocate('one'),names.allocate('two')])).toEqual(['labdecka','labdeckb'])
    expect(await new ResearchOutputNames(file).allocate('one')).toBe('labdecka')
    expect(await new ResearchOutputNames(file).allocate('three')).toBe('labdeckc')
    expect(outputBatchName(25)).toBe('labdeckz')
    expect(outputBatchName(26)).toBe('labdeckaa')
  }finally{await rm(directory,{recursive:true,force:true})}
})
