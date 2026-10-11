import {describe, it, expect} from 'vitest'
import {createDemoWorkflow, failDemoInitial, diagnoseDemoRun, retryDemoRun, startDemoRetry, finishDemoRetry} from './demo-workflow'
function repair(){
  const initial=failDemoInitial(createDemoWorkflow()), diagnosed=diagnoseDemoRun(initial,initial.task.runs[0].id)
  return {original:initial,report:diagnosed.report,state:retryDemoRun(diagnosed.state,diagnosed.report.id)}
}
describe('isolated demo workflow',()=>{
  it('has its own manual demo node and disjoint reset identities',()=>{
    const a=createDemoWorkflow(), b=createDemoWorkflow()
    expect(a.server.mode).toBe('demo');expect(a.server.monitorPolicy).toBe('manual')
    expect(a.task.id).not.toBe(b.task.id);expect(a.server.id).not.toBe(b.server.id)
    expect(a.task.status).toBe('planned');expect(a.reports).toEqual([])
  })
  it('rejects unknown or healthy run diagnosis',()=>{
    const state=createDemoWorkflow()
    expect(()=>diagnoseDemoRun(state,'unknown')).toThrow()
    const running=startDemoRetry(repair().state)
    expect(()=>diagnoseDemoRun(running,running.task.runs[1].id)).toThrow()
  })
  it('preserves original snapshots, requires a valid repair and deduplicates repeated clicks',()=>{
    const {original,state,report}=repair()
    expect(state.task.runs[0]).toEqual(original.task.runs[0])
    expect(original.task.runs).toHaveLength(1)
    expect(state.task.launchCommand).toBe('python train.py --batch-size 32')
    expect(state.task.runs[1].launchCommand).toBe('python train.py --batch-size 16')
    expect(retryDemoRun(state,report.id).task.runs).toHaveLength(2)
    expect(()=>retryDemoRun(state,'unknown')).toThrow()
    expect(failDemoInitial(state)).toBe(state)
    expect(diagnoseDemoRun(state,state.task.runs[0].id).state.reports).toHaveLength(1)
  })
  it('accepts simulated exit zero only after starting, without changing original runs',()=>{
    const {state,original}=repair()
    expect(finishDemoRetry(state,true)).toBe(state)
    const done=finishDemoRetry(startDemoRetry(state),true)
    expect(done.reports[0].closure).toMatchObject({status:'passed',exitCode:0,enabled:false})
    expect(done.task.runs[0]).toEqual(original.task.runs[0])
    expect(done.task.runs[1].status).toBe('completed')
    expect(done.reports).toHaveLength(1)
    expect(finishDemoRetry(done,false)).toBe(done)
  })
  it('links failed retry diagnosis and waits for another repair confirmation',()=>{
    const {state,report}=repair(), failed=finishDemoRetry(startDemoRetry(state),false)
    const origin=failed.reports.find(r=>r.id===report.id)!, followup=failed.reports.find(r=>r.id===origin.closure!.nextDiagnosisId)!
    expect(origin.closure).toMatchObject({status:'failed',exitCode:1,enabled:false})
    expect(followup.runId).toBe(origin.retryRunId)
    expect(followup.repair?.previousBatch).toBe(16);expect(followup.repair?.nextBatch).toBe(8)
    expect(followup.engine).toBe('rules');expect(followup.source).toBe('sample')
    expect(failed.task.runs).toHaveLength(2)
    expect(failed.reports.every(r=>r.warnings.some(w=>w.includes('模拟数据')))).toBe(true)
    expect(failed.reports[0].retryRunId).toBeUndefined()
  })
})
