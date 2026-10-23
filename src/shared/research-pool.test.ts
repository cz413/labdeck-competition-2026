import { describe, expect, it } from 'vitest'
import { researchGroupStatus, researchGroupTitle, researchMemberTitle, researchPoolRows } from './research-pool'
import type { ExperimentTask } from './types'
import type { ResearchView } from './research'
const task=(id:string,status:ExperimentTask['status']='completed'):ExperimentTask=>({id,title:id,status,project:'project',objective:'',tags:[],priority:'normal',codePath:'/project',dataPath:'',launchCommand:'python main.py',artifactPath:'',resultSummary:'',notes:'',archived:false,createdAt:'2026-10-23T00:00:00Z',updatedAt:'2026-10-23T00:00:00Z',runs:[]})
const campaign=(id:string,ids:string[]):ResearchView=>({id,updatedAt:'2026-10-23T00:00:00Z',objective:'compare',maxRuns:3,useModel:false,stage:'analysis',expansionEngine:'typescript',warnings:[],observations:[],events:[],paused:false,pending:[],createdAt:'2026-10-23T00:00:00Z',sourceTaskId:'source',sourceRunNumber:10,baseline:{...task('source'),title:'SASRec',project:'SASRec.pytorch',launchCommand:'python main.py --batch_size=128'},axes:[{flag:'--batch_size',values:['128','64','256']}],members:ids.map((taskId,i)=>({taskId,parameters:{'--batch_size':String([128,64,256][i])},key:String(i),command:'',changes:[]}))})
describe('grouped research tasks',()=>{
  it('groups explicit child memberships once and keeps the source task as an ordinary task',()=>{
    const tasks=[task('b'),task('source'),task('a'),task('other')],group=campaign('batch',['a','b'])
    const rows=researchPoolRows(tasks,[group])
    expect(rows).toHaveLength(3);expect(rows[0].kind).toBe('campaign')
    if(rows[0].kind==='campaign')expect(rows[0].tasks.map(t=>t.id)).toEqual(['a','b'])
    expect(rows[1]).toEqual({kind:'task',task:tasks[1]});expect(tasks.map(t=>t.id)).toEqual(['b','source','a','other'])
  })
  it('does not restore hidden/deleted children and never groups a task merely because it is a source',()=>{
    const group=campaign('batch',['a','b','deleted'])
    const rows=researchPoolRows([task('b'),task('source')],[group])
    expect(rows[0].kind==='campaign'&&rows[0].tasks.map(t=>t.id)).toEqual(['b'])
    expect(rows[1].kind).toBe('task')
  })
  it('supports nested follow-up batches without duplicating the task that created them',()=>{
    const first=campaign('first',['a','b']),second={...campaign('second',['c']),sourceTaskId:'a'}
    expect(researchPoolRows([task('a'),task('b'),task('c')],[first,second])).toHaveLength(2)
  })
  it('uses baseline/parameter labels and limits long child names',()=>{
    const group=campaign('batch',['a','b'])
    expect(researchMemberTitle(group,group.members[0])).toBe('基线')
    expect(researchMemberTitle(group,group.members[1])).toBe('batch_size=64')
    expect(researchMemberTitle(group,{...group.members[1],parameters:{'--long_parameter':'x'.repeat(80)}}).length).toBeLessThanOrEqual(28)
    expect(researchGroupTitle(group)).toBe('SASRec · 批次大小对照')
  })
  it('shows active/failed states before completed and handles canceled groups',()=>{
    expect(researchGroupStatus([task('a'),task('b','running')])).toBe('running')
    expect(researchGroupStatus([task('a'),task('b','failed')])).toBe('failed')
    expect(researchGroupStatus([task('a')])).toBe('completed')
    expect(researchGroupStatus([task('a','cancelled')])).toBe('cancelled')
  })
})
