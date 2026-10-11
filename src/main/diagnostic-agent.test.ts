import { describe, expect, it, vi } from 'vitest'
import { investigate, modelEvidence, type InvestigationOptions } from './diagnostic-agent'
const inspect=(tool='search_log',args:Record<string,string>={query:'error'})=>({action:'inspect',toolCalls:[{tool,arguments:args,reason:'核对错误信号',evidenceIds:['log-1']}]})
const final=(id='check-1')=>({action:'final',summary:'证据需要核对',findings:[{category:'other',title:'检查结果',confidence:'medium',explanation:'基于实际返回',evidenceIds:[id],steps:['核对配置']}]})
function options():InvestigationOptions {
 return {evidence:[{id:'log-1',source:'log',label:'第 1 行',text:'error: missing path'}],warnings:[],tools:[{name:'search_log',description:'search',label:'搜索日志',arguments:{query:'keyword'}}],context:{},request:vi.fn(),execute:vi.fn().mockResolvedValue({status:'success',text:'matched error'}),signal:new AbortController().signal,progress:vi.fn()}
}
describe('bounded evidence-driven investigation',()=>{
 it('lets the model select checks then feeds actual results into the next decision',async()=>{
  const o=options();vi.mocked(o.request).mockResolvedValueOnce(inspect()).mockResolvedValueOnce(final())
  const result=await investigate(o)
  expect(o.execute).toHaveBeenCalledOnce();expect(o.request).toHaveBeenCalledTimes(2)
  const payload=vi.mocked(o.request).mock.calls[1][1] as {evidence:{id:string;text:string}[]}
  expect(payload.evidence.find(e=>e.id==='check-1')?.text).toContain('matched error')
  expect(result.investigation).toMatchObject({status:'completed',rounds:2,inspections:1})
  expect(result.investigation.trace.map(t=>t.kind)).toEqual(['model','tool','model'])
  expect(result.findings?.[0].evidenceIds).toEqual(['check-1'])
 })
 it('enforces four checks and requests a final answer when the budget is exhausted',async()=>{
  const o=options();let round=0
  vi.mocked(o.request).mockImplementation(async(_system,payload)=>{
   round++;if(round===3){expect((payload as {finalOnly:boolean}).finalOnly).toBe(true);return final('check-4')}
   return {action:'inspect',toolCalls:[1,2].map(n=>({...inspect().toolCalls[0],arguments:{query:`error-${round}-${n}`}}))}
  })
  const result=await investigate(o);expect(o.execute).toHaveBeenCalledTimes(4);expect(result.investigation.rounds).toBe(3)
 })
 it('stops after four model rounds even if the model keeps asking for checks',async()=>{
  const o=options();vi.mocked(o.request).mockImplementation(async()=>inspect('search_log',{query:`round-${vi.mocked(o.request).mock.calls.length}`}))
  const result=await investigate(o);expect(o.request).toHaveBeenCalledTimes(4);expect(o.execute).toHaveBeenCalledTimes(3)
  expect(result.investigation.status).toBe('partial');expect(result.findings).toBeUndefined()
 })
 it.each([
  {action:'inspect',toolCalls:[{...inspect().toolCalls[0],evidenceIds:['invented']}]},
  inspect('shell',{command:'rm -rf /'}),
  inspect('inspect_gpu',{}),
  {action:'inspect',toolCalls:[{...inspect().toolCalls[0],arguments:{query:'error',command:'id'}}]},
  final('invented')
 ])('rejects fabricated references, unavailable tools and unrecognized arguments',async response=>{
  const o=options();vi.mocked(o.request).mockResolvedValue(response);const result=await investigate(o)
  expect(o.execute).not.toHaveBeenCalled();expect(result.investigation.status).toBe('failed');expect(result.findings).toBeUndefined()
 })
 it('does not repeat the same check and records its unavailable status',async()=>{
  const o=options();vi.mocked(o.request).mockResolvedValueOnce(inspect()).mockResolvedValueOnce(inspect()).mockResolvedValueOnce(final('check-2'))
  const result=await investigate(o);expect(o.execute).toHaveBeenCalledOnce()
  expect(result.investigation.trace.filter(t=>t.kind==='tool').map(t=>t.status)).toEqual(['completed','unavailable'])
 })
 it('makes failed checks available as evidence without fabricating a successful result',async()=>{
  const o=options();vi.mocked(o.execute).mockRejectedValue(new Error('offline'));vi.mocked(o.request).mockResolvedValueOnce(inspect()).mockResolvedValueOnce(final())
  const result=await investigate(o);expect(result.evidence[1].text).toContain('failed');expect(result.investigation.trace[1].status).toBe('failed')
 })
 it('cancels during a check, retains previous evidence and makes no subsequent request',async()=>{
  const o=options();const controller=new AbortController();o.signal=controller.signal
  vi.mocked(o.request).mockResolvedValue(inspect());vi.mocked(o.execute).mockImplementation(async()=>{controller.abort();throw new Error('aborted')})
  const result=await investigate(o);expect(result.investigation.status).toBe('cancelled');expect(o.request).toHaveBeenCalledOnce();expect(result.evidence).toHaveLength(1)
 })
 it('does not contact the model when already cancelled',async()=>{
  const o=options();o.signal=AbortSignal.abort();expect((await investigate(o)).investigation.status).toBe('cancelled');expect(o.request).not.toHaveBeenCalled()
 })
 it('redacts secrets in returned results and findings',async()=>{
  const o=options();vi.mocked(o.execute).mockResolvedValue({status:'success',text:'api_key=private-secret-value'})
  vi.mocked(o.request).mockResolvedValueOnce(inspect()).mockResolvedValueOnce({...final(),summary:'api_key=private-secret-value'})
  const result=await investigate(o);expect(JSON.stringify(result)).not.toContain('private-secret-value')
 })
 it('keeps error context and caps the log payload while preserving check results',()=>{
  const evidence=Array.from({length:240},(_,i)=>({id:`log-${i+1}`,source:'log' as const,label:'log',text:i===2?'Traceback: error':'line '+i}))
  const selected=modelEvidence(evidence);expect(selected.length).toBeLessThanOrEqual(60);expect(selected.some(e=>e.id==='log-3')).toBe(true)
 })
})
