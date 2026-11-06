import { describe, expect, it } from 'vitest'
import type { RunObservation } from '../shared/research'
import { preserveCollectedResults } from './research-recollection'
const observation=():RunObservation=>({key:'group',taskId:'task',runId:'run',status:'completed',evidenceId:'run-run',exitCode:0,metrics:{},excerpt:'',metricDetails:[],files:[{path:'/a.txt',role:'result',status:'available',text:'old A'},{path:'/b.txt',role:'result',status:'available',text:'old B'}],collectedAt:'2026-11-06T00:00:00Z'})
describe('recollection evidence preservation',()=>{
  it('keeps a successful new file while retaining only the unreadable file',()=>{
    const previous=observation(),current=observation()
    current.files=[{path:'/a.txt',role:'result',status:'available',text:'new A'},{path:'/b.txt',role:'result',status:'unreadable',message:'timeout'}]
    const result=preserveCollectedResults(current,previous)
    expect(result.files?.map(file=>file.text)).toEqual(['new A','old B'])
    expect(result.files?.[1].message).toContain('timeout')
    expect(result.warning).toContain('保留上次采集结果')
    expect(previous.files?.[1].message).toBeUndefined()
  })
  it('does not conceal a confirmed missing file or restore an unrequested path',()=>{
    const previous=observation(),current=observation()
    current.files=[{path:'/a.txt',role:'result',status:'missing'},{path:'/new.txt',role:'result',status:'unreadable'}]
    const result=preserveCollectedResults(current,previous)
    expect(result.files?.every(file=>!file.text)).toBe(true)
    expect(result.warning).toBeUndefined()
  })
  it('does not reuse another run or replace successfully refreshed content',()=>{
    const previous=observation(),current=observation()
    current.files![0].text='fresh'
    expect(preserveCollectedResults(current,previous).files?.[0].text).toBe('fresh')
    current.runId='another';current.files=[];current.warning='timeout'
    expect(preserveCollectedResults(current,previous).files).toEqual([])
  })
})
