import { describe, expect, it, vi } from 'vitest'
import { applyModelRefinement, refinementIntent, refinementPayload, refineWithModel } from './plan-refinement'
import { experimentTaskDraftSchema } from '../shared/schemas'
import type { ExperimentPlan } from '../shared/experiment-plan'
const plan=()=>({draft:experimentTaskDraftSchema.parse({title:'training',codePath:'/repo',launchCommand:'python train.py'}),mode:'train',fields:{},guide:{snapshot:{input:{path:'/repo'}}}} as ExperimentPlan)
describe('model refinement response compatibility',()=>{
  it('puts model stage names on the next run and reserves task renaming for explicit requests',()=>{
    const value=plan();value.draft.title='TIGER'
    const next=applyModelRefinement(value,{patch:{title:'训练 T5',launchCommand:'python train_t5.py'},notes:[]},{},'接下来训练T5')
    expect(next.draft.title).toBe('TIGER')
    expect(next.draft.runTitle).toBe('训练 T5')
    const renamed=applyModelRefinement(value,{patch:{title:'推荐项目'},notes:[]},{},'把任务名称改成推荐项目')
    expect(renamed.draft.title).toBe('推荐项目')
  })
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

describe('actionable continuation requests',()=>{
  it.each(['接下来生成SID','接下来怎么生成 SID','用训练好的权重评估','继续训练'])('understands %s as an action requiring a command',instruction=>{
    expect(refinementIntent(instruction)).toEqual({intent:'action',needsCommand:true})
  })
  it.each(['SID 是什么意思','为什么要生成 SID','只解释流程，不用修改'])('keeps explicit explanation requests informational',instruction=>{
    expect(refinementIntent(instruction).intent).toBe('explanation')
  })
  it('supplies all previously read source without cutting off late checkpoint/CLI definitions',()=>{
    const value=plan()
    value.guide.snapshot.excerpts=Array.from({length:26},(_,index)=>({path:`src/${index}.py`,startLine:1,text:'x'.repeat(6500)+'checkpoint_default',truncated:false}))
    const payload=refinementPayload(value,'生成SID',{}) as {files:{text:string}[]}
    expect(payload.files).toHaveLength(26)
    expect(payload.files[25].text).toContain('checkpoint_default')
  })
  it('asks once more when an action was answered only with a workflow description',async()=>{
    const value=plan();value.guide.snapshot.excerpts=[{path:'rqvae/generate_code.py',startLine:1,text:'generate()',truncated:false}]
    const request=vi.fn().mockResolvedValueOnce({patch:{},notes:['下一步生成 SID。']}).mockResolvedValueOnce({outcome:'updated',patch:{title:'生成 SID',objective:'生成物品语义编码',codePath:'/repo/rqvae',launchCommand:'python generate_code.py'},notes:['请先将脚本中 ckpt_path 改为实际权重位置。']})
    const result=await refineWithModel(value,'接下来生成SID',{},request)
    expect(request).toHaveBeenCalledTimes(2)
    expect(result.draft).toMatchObject({codePath:'/repo/rqvae',launchCommand:'python generate_code.py',objective:'生成物品语义编码'})
    expect(result.matched).toBe(true)
    expect(value.draft.launchCommand).toBe('python train.py')
  })
  it('does not repeat an already satisfied request or retry a failed API call',async()=>{
    const value=plan();value.guide.snapshot.excerpts=[{path:'train.py',startLine:1,text:'train()',truncated:false}]
    const unchanged=vi.fn().mockResolvedValue({outcome:'unchanged',patch:{},notes:['当前已是所需命令。']})
    await refineWithModel(value,'继续训练',{},unchanged);expect(unchanged).toHaveBeenCalledOnce()
    const offline=vi.fn().mockRejectedValue(new Error('offline'))
    await expect(refineWithModel(value,'生成SID',{},offline)).rejects.toThrow('offline');expect(offline).toHaveBeenCalledOnce()
  })
  it('preserves explicit missing-input advice without appending a generic request for the goal',()=>{
    const result=applyModelRefinement(plan(),{patch:{},notes:['缺少实际权重位置。']},{})
    expect(result.notes).toEqual(['缺少实际权重位置。'])
  })
})
