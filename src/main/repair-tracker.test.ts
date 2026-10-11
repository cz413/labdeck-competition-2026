import { afterEach, describe, expect, it, vi } from 'vitest'
import { RepairTracker, initialClosure } from './repair-tracker'
import type { DiagnosisReport, RepairClosure, Verification } from '../shared/intelligence'
import type { ExperimentRunStatus } from '../shared/types'
const trackers:RepairTracker[]=[]
afterEach(()=>{trackers.forEach(t=>t.stop());trackers.length=0})
function setup(){
 const report:DiagnosisReport={id:'report',createdAt:new Date().toISOString(),title:'repair',source:'remote',engine:'rules',taskId:'task',runId:'old',retryRunId:'new',logExcerpt:'',evidence:[],findings:[],warnings:[],closure:initialClosure()}
 let status:ExperimentRunStatus|undefined='queued';let now=Date.now()
 const verify=vi.fn(async():Promise<Verification>=>({status:'completed',message:'remote exit 0',runId:'new',exitCode:0,checkedAt:new Date(now).toISOString()}))
 const patch=vi.fn(async(_id:string,update:(c:RepairClosure|undefined)=>RepairClosure)=>{report.closure=update(report.closure);return structuredClone(report)})
 const cancel=vi.fn()
 const tracker=new RepairTracker({list:async()=>[structuredClone(report)],patch,status:()=>status,verify,cancelDiagnosis:cancel,now:()=>now});trackers.push(tracker)
 return {report,tracker,verify,patch,cancel,setStatus:(v:ExperimentRunStatus|undefined)=>status=v,advance:(ms:number)=>now+=ms}
}
describe('persistent repair closure',()=>{
 it('follows waiting/running without remote verification, then verifies completion once',async()=>{
  const s=setup();await s.tracker.start();expect(s.verify).not.toHaveBeenCalled()
  s.setStatus('running');await s.tracker.sweep();expect(s.report.closure?.status).toBe('running');expect(s.verify).not.toHaveBeenCalled()
  s.setStatus('completed');await s.tracker.sweep();expect(s.report.closure).toMatchObject({status:'passed',enabled:false,exitCode:0})
  await s.tracker.sweep();expect(s.verify).toHaveBeenCalledOnce()
 })
 it('links a failed run to its new diagnosis and does not schedule another run',async()=>{
  const s=setup();s.setStatus('failed');s.verify.mockResolvedValue({status:'failed',message:'still failed',exitCode:1,diagnosis:{...s.report,id:'next'}})
  await s.tracker.start();expect(s.report.closure).toMatchObject({status:'failed',enabled:false,exitCode:1,nextDiagnosisId:'next'})
 })
 it('does not convert missing evidence to success and backs off before stopping after three checks',async()=>{
  const s=setup();s.setStatus('completed');s.verify.mockResolvedValue({status:'unknown',message:'exit-code missing'})
  await s.tracker.start();expect(s.report.closure).toMatchObject({status:'attention',enabled:true,attempts:1})
  await s.tracker.sweep();expect(s.verify).toHaveBeenCalledOnce()
  s.advance(30_000);await s.tracker.sweep();expect(s.report.closure?.attempts).toBe(2)
  s.advance(120_000);await s.tracker.sweep();expect(s.report.closure).toMatchObject({status:'attention',enabled:false,attempts:3})
  s.advance(500_000);await s.tracker.sweep();expect(s.verify).toHaveBeenCalledTimes(3)
 })
 it.each(['paused','cancelled',undefined] as const)('stops on interrupted or missing run state: %s',async status=>{
  const s=setup();s.setStatus(status);await s.tracker.start();expect(s.report.closure).toMatchObject({status:'attention',enabled:false});expect(s.verify).not.toHaveBeenCalled()
 })
 it('allows manual checking when automatic tracking is paused',async()=>{
  const s=setup();await s.tracker.setEnabled('report',false);await s.tracker.start();s.setStatus('completed')
  expect((await s.tracker.check('report')).status).toBe('completed');expect(s.report.closure?.status).toBe('passed')
 })
 it('coalesces simultaneous automatic and manual checks',async()=>{
  const s=setup();s.setStatus('completed');const results=await Promise.all([s.tracker.check('report'),s.tracker.check('report')])
  expect(s.verify).toHaveBeenCalledOnce();expect(results[0]).toEqual(results[1])
 })
 it('cancels in-progress inspection on pause and does not overwrite paused state with success',async()=>{
  const s=setup();s.setStatus('completed');let resolve:((v:Verification)=>void)|undefined
  s.verify.mockImplementation(async()=>new Promise(r=>resolve=r))
  const check=s.tracker.check('report');await vi.waitFor(()=>expect(s.verify).toHaveBeenCalledOnce())
  const rejected=expect(check).rejects.toThrow();const pause=s.tracker.setEnabled('report',false)
  await vi.waitFor(()=>expect(s.cancel).toHaveBeenCalledOnce());resolve!({status:'completed',message:'late success',exitCode:0})
  await rejected;await pause;expect(s.report.closure).toMatchObject({status:'paused',enabled:false})
 })
 it('keeps the attempt limit after a restart interrupted the last verification',async()=>{
  const s=setup();s.setStatus('completed');s.report.closure={...initialClosure(),status:'verifying',attempts:3}
  await s.tracker.start();expect(s.verify).not.toHaveBeenCalled();expect(s.report.closure).toMatchObject({enabled:false,status:'attention',attempts:3})
 })
 it('treats connection errors as pending evidence instead of declaring failure',async()=>{
  const s=setup();s.setStatus('failed');s.verify.mockRejectedValue(new Error('offline'));await s.tracker.start()
  expect(s.report.closure).toMatchObject({status:'attention',enabled:true});expect(s.report.closure?.exitCode).toBeUndefined()
 })
})
