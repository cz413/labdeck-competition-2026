import { describe, expect, it, vi } from 'vitest'
import { diagnosisCacheKey, runDiagnosis, type CollectedDiagnosis, type DiagnosisDependencies } from './diagnosis-workflow'
import { diagnosticSamples, logEvidence } from '../shared/diagnosis-engine'

function setup(log=diagnosticSamples.oom){
  const logs=logEvidence(log)
  const evidence:CollectedDiagnosis={source:'remote',title:'失败运行',taskId:'task',runId:'run',logExcerpt:logs.logExcerpt,evidence:logs.evidence,warnings:[]}
  const save=vi.fn(async report=>structuredClone(report))
  const analyze=vi.fn<DiagnosisDependencies['analyze']>().mockRejectedValue(new Error('credential unavailable'))
  const findRun=vi.fn(()=>({id:'run',number:1,status:'failed' as const,launchCommand:'python main.py --batch_size 32',resultSummary:'',notes:''}))
  const deps:DiagnosisDependencies={collect:vi.fn(async()=>evidence),history:()=>[],model:{enabled:true,model:'mock',endpoint:'https://example.invalid'},analyze,findRun,save}
  return {deps,evidence,save,analyze,findRun}
}

describe('diagnosis workflow',()=>{
  it('persists rule evidence when model initialization fails',async()=>{
    const {deps,save}=setup()
    const report=await runDiagnosis({taskId:'task',runId:'run',useModel:true},new AbortController().signal,vi.fn(),deps)
    expect(report.engine).toBe('rules')
    expect(report.findings.some(f=>f.category==='oom')).toBe(true)
    expect(report.investigation?.status).toBe('failed')
    expect(report.warnings.join('')).toContain('已保留证据与规则结果')
    expect(save).toHaveBeenCalledOnce()
  })
  it('keeps cancelled evidence without model calls or executable repairs',async()=>{
    const {deps,analyze,findRun}=setup(),controller=new AbortController()
    controller.abort()
    const report=await runDiagnosis({taskId:'task',useModel:true},controller.signal,vi.fn(),deps)
    expect(report.investigation?.status).toBe('cancelled')
    expect(report.repair).toBeUndefined()
    expect(analyze).not.toHaveBeenCalled();expect(findRun).not.toHaveBeenCalled()
  })
  it('never authorizes OOM repair from model findings or added tool evidence',async()=>{
    const {deps,analyze}=setup('ordinary failure')
    analyze.mockImplementation(async report=>({evidence:[...report.evidence,...logEvidence(diagnosticSamples.oom).evidence],investigation:{status:'completed',rounds:1,inspections:1,trace:[]},warnings:[],findings:[{category:'oom',title:'Guess',confidence:'low',explanation:'Guess',evidenceIds:[],steps:[]}]}))
    const report=await runDiagnosis({taskId:'task',useModel:true},new AbortController().signal,vi.fn(),deps)
    expect(report.repair).toBeUndefined()
    expect(report.engine).toBe('agent+rules')
  })
  it('tags rule and model findings separately after direct evidence validation',async()=>{
    const {deps,evidence,analyze}=setup()
    const id=evidence.evidence.find(item=>item.source==='log'&&/out of memory/i.test(item.text))!.id
    analyze.mockResolvedValue({evidence:evidence.evidence,investigation:{status:'completed',rounds:1,inspections:0,trace:[]},warnings:[],summary:'本次显存不足',findings:[{category:'oom',title:'当前训练触发显存不足',confidence:'medium',explanation:'日志记录分配失败，失败时的其他进程占用尚未核对。',evidenceIds:[id],steps:['核对本次 batch size 参数。']}]})
    const result=await runDiagnosis({taskId:'task',runId:'run',useModel:true},new AbortController().signal,vi.fn(),deps)
    expect(result.findings.some(item=>item.origin==='rules')).toBe(true)
    expect(result.findings.some(item=>item.origin==='model'&&item.title==='当前训练触发显存不足')).toBe(true)
  })
  it('retains report if its original run disappears during analysis',async()=>{
    const {deps,findRun,save}=setup()
    findRun.mockImplementation(()=>{throw new Error('removed')})
    const report=await runDiagnosis({taskId:'task',useModel:false},new AbortController().signal,vi.fn(),deps)
    expect(report.repair).toBeUndefined();expect(save).toHaveBeenCalledOnce()
    expect(report.warnings.join('')).toContain('原运行记录已变化')
  })
  it('reuses exact-run reports but honors explicit reanalysis',async()=>{
    const {deps,evidence,analyze,save}=setup(),input={taskId:'task',runId:'run',useModel:false}
    const first=await runDiagnosis(input,new AbortController().signal,vi.fn(),deps)
    deps.history=()=>[first];save.mockClear()
    const reused=await runDiagnosis(input,new AbortController().signal,vi.fn(),deps)
    expect(reused.cacheHit).toBe(true);expect(save).not.toHaveBeenCalled();expect(analyze).not.toHaveBeenCalled()
    expect(diagnosisCacheKey(input,{...evidence,runId:'other'},deps.model)).not.toBe(first.cacheKey)
    await runDiagnosis({...input,force:true},new AbortController().signal,vi.fn(),deps)
    expect(save).toHaveBeenCalledOnce()
  })
})
