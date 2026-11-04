import { describe, expect, it } from 'vitest'
import { preparationTaskNames } from './experiment-names'
import { experimentTaskDraftSchema } from './schemas'
describe('project and run names',()=>{
  it('moves a legacy stage title into the run name while restoring the repository name',()=>{
    const old=experimentTaskDraftSchema.parse({title:'TIGER · 训练 T5',project:'TIGER'})
    expect(preparationTaskNames(old,'/repo/TIGER')).toMatchObject({title:'TIGER',runTitle:'TIGER · 训练 T5'})
  })
  it('keeps the task name stable across run stages and honors explicit project renames',()=>{
    const draft=experimentTaskDraftSchema.parse({title:'TIGER',project:'TIGER',runTitle:'生成 SID'})
    expect(preparationTaskNames({...draft,runTitle:'训练 T5'},'/repo/TIGER').title).toBe('TIGER')
    expect(preparationTaskNames({...draft,title:'推荐模型实验'},'/repo/TIGER',true).title).toBe('推荐模型实验')
  })
})
