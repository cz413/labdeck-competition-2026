import { describe, expect, it } from 'vitest'
import { appendPreparationHistory, preparationHistoryVersions, type PreparationPlanState } from './preparation-history'
import type { PreparationEdit } from './preparation'
const state=(command:string):PreparationPlanState=>({draft:{launchCommand:command},mode:'train',fields:{}} as PreparationPlanState)
describe('preparation version restoration',()=>{
  it('reads results of legacy before-only records without restoring the preceding edit',()=>{
    const a=state('python main.py'),b=state('python main.py --epochs 1'),c=state('python main.py --epochs 10')
    const history=[{id:1,label:'one',at:'14:01',before:a},{id:2,label:'ten',at:'14:02',before:b}]
    expect(preparationHistoryVersions(history,c).map(entry=>entry.state)).toEqual([b,c])
  })
  it('can restore any earlier version and return to the later version after persistence',()=>{
    const a=state('a'),b=state('b'),c=state('c')
    const history=[{id:1,label:'b',at:'1',before:a},{id:2,label:'c',at:'2',before:b}]
    const restore=preparationHistoryVersions(history,c)[0].state
    const saved=JSON.parse(JSON.stringify(appendPreparationHistory(history,{id:3,label:'restore b',at:'3'},c))) as PreparationEdit['history']
    const versions=preparationHistoryVersions(saved,restore)
    expect(versions.map(entry=>entry.state)).toEqual([b,c,b])
    const next=appendPreparationHistory(saved,{id:4,label:'restore c',at:'4'},restore)
    expect(preparationHistoryVersions(next,versions[1].state).map(entry=>entry.state)).toEqual([b,c,b,c])
    versions[1].state.draft.launchCommand='changed'
    expect(saved[2].before.draft.launchCommand).toBe('c')
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
