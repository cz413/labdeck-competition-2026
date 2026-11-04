import { describe, expect, it } from 'vitest'
import { appendPreparationHistory, freezePreparationHistory, preparationHistoryVersions, type PreparationPlanState } from './preparation-history'
import type { PreparationEdit } from './preparation'
const state=(command:string):PreparationPlanState=>({draft:{launchCommand:command},mode:'train',fields:{}} as PreparationPlanState)
describe('preparation version restoration',()=>{
  it('reads results of legacy before-only records without restoring the preceding edit',()=>{
    const a=state('python main.py'),b=state('python main.py --epochs 1'),c=state('python main.py --epochs 10')
    const history=[{id:1,label:'one',at:'14:01',before:a},{id:2,label:'ten',at:'14:02',before:b}]
    expect(preparationHistoryVersions(history,c).map(entry=>entry.state)).toEqual([b,c])
  })
  it('switches versions repeatedly without adding records or losing the latest result after reload',()=>{
    const a=state('a'),b=state('b'),c=state('c')
    const history=[{id:1,label:'b',at:'1',before:a},{id:2,label:'c',at:'2',before:b}]
    const saved=JSON.parse(JSON.stringify(freezePreparationHistory(history,c))) as PreparationEdit['history']
    expect(saved).toHaveLength(2)
    expect(preparationHistoryVersions(saved,b).map(entry=>entry.state)).toEqual([b,c])
    const again=freezePreparationHistory(saved,b)
    expect(again).toHaveLength(2)
    expect(preparationHistoryVersions(again,c).map(entry=>entry.state)).toEqual([b,c])
    const branch=appendPreparationHistory(again,{id:3,label:'d',at:'3'},b)
    expect(preparationHistoryVersions(branch,state('d')).map(entry=>entry.state)).toEqual([b,c,state('d')])
  })
  it('collapses historical restore duplicates and ignores field provenance when identifying a version',()=>{
    const a=state('a'),b=state('b'),c=state('c')
    const history=[{id:1,label:'b',at:'1',before:a},{id:2,label:'c',at:'2',before:b},{id:3,label:'恢复版本：b',at:'3',before:c}]
    expect(preparationHistoryVersions(history,b).map(entry=>entry.label)).toEqual(['b','c'])
    const provenance={...b,fields:{launchCommand:{source:'user' as const}}}
    const extra=appendPreparationHistory(history,{id:4,label:'same',at:'4'},b)
    expect(preparationHistoryVersions(extra,provenance)).toHaveLength(2)
  })
  it('bounds history while preserving the results of retained versions',()=>{
    let history:PreparationEdit['history']=[]
    for(let i=1;i<=25;i++)history=appendPreparationHistory(history,{id:i,label:String(i),at:''},state(String(i-1)))
    expect(history).toHaveLength(20)
    const versions=preparationHistoryVersions(history,state('25'))
    expect(versions[0].state.draft.launchCommand).toBe('6')
    expect(versions.at(-1)?.state.draft.launchCommand).toBe('25')
  })
})
