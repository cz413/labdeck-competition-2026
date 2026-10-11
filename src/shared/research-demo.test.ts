import { describe, expect, it } from 'vitest'
import { expandParameters } from './parameter-engine'
import { createResearchDemo,finishResearchDemo,queueResearchDemo,researchDemoAxes,researchDemoCommand } from './research-demo'
describe('temporary research demo',()=>{
  it('uses real expansion output but holds all simulated runtime data locally',()=>{
    const demo=createResearchDemo(expandParameters(researchDemoCommand,researchDemoAxes,4))
    expect(demo.members).toHaveLength(4);expect(demo.members.every(m=>!m.taskId&&!m.runId)).toBe(true)
    const done=finishResearchDemo(queueResearchDemo(demo),false)
    expect(done.observations.every(o=>o.status==='completed')).toBe(true);expect(done.analysis?.summary).toContain('指标变差仍属于正常');expect(demo.stage).toBe('review')
  })
  it('separates a simulated process failure from normal metric outcomes',()=>{
    const done=finishResearchDemo(queueResearchDemo(createResearchDemo(expandParameters(researchDemoCommand,researchDemoAxes,4))),true)
    expect(done.observations.filter(o=>o.status==='failed')).toHaveLength(1);expect(done.observations.filter(o=>o.status==='completed')).toHaveLength(3)
    expect(done.events.some(e=>e.node==='diagnose')).toBe(true)
  })
})
