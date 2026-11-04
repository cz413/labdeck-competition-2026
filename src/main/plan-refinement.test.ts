import { describe, expect, it } from 'vitest'
import { applyModelRefinement } from './plan-refinement'
import { experimentTaskDraftSchema } from '../shared/schemas'
import type { ExperimentPlan } from '../shared/experiment-plan'
const plan=()=>({draft:experimentTaskDraftSchema.parse({title:'training',codePath:'/repo',launchCommand:'python train.py'}),mode:'train',fields:{},guide:{snapshot:{input:{path:'/repo'}}}} as ExperimentPlan)
describe('model refinement response compatibility',()=>{
  it('accepts mode nested in patch and never adds it to the task draft',()=>{
    const original=plan()
    const result=applyModelRefinement(original,{patch:{mode:'evaluate',launchCommand:'python evaluate.py'},notes:[]},{})
    expect(result.mode).toBe('evaluate')
    expect(result.draft.launchCommand).toBe('python evaluate.py')
    expect(result.draft).not.toHaveProperty('mode')
    expect(original.draft.launchCommand).toBe('python train.py')
  })
  it('keeps the documented top-level format and accepts matching nested values',()=>{
    const raw={patch:{launchCommand:'python evaluate.py'},mode:'evaluate'}
    expect(applyModelRefinement(plan(),raw,{}).mode).toBe('evaluate')
    expect(applyModelRefinement(plan(),{...raw,patch:{...raw.patch,mode:'evaluate'}},{}).mode).toBe('evaluate')
  })
  it('rejects conflicting or invalid modes, unknown fields and mode changes without a new command',()=>{
    expect(()=>applyModelRefinement(plan(),{patch:{mode:'train'},mode:'evaluate'},{})).toThrow('不一致')
    expect(()=>applyModelRefinement(plan(),{patch:{mode:'other'}},{})).toThrow()
    expect(()=>applyModelRefinement(plan(),{patch:{serverId:'another'}},{})).toThrow()
    expect(()=>applyModelRefinement(plan(),{patch:{mode:'evaluate'}},{})).toThrow('启动命令')
  })
  it('can answer a next-step question without changing the configuration',()=>{
    const original=plan(),result=applyModelRefinement(original,{patch:{},notes:['请先确认训练权重路径，再按项目文档进行评估。']},{})
    expect(result.matched).toBe(false)
    expect(result.draft).toEqual(original.draft)
    expect(result.mode).toBe('train')
    expect(result.notes).toContain('请先确认训练权重路径，再按项目文档进行评估。')
  })
})
