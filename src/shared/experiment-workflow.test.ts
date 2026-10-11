import {describe, it, expect} from 'vitest'
import {reportForRun} from './experiment-workflow'
import type {DiagnosisReport} from './intelligence'
const report = (id: string, runId: string, retryRunId?: string): DiagnosisReport => ({id, taskId: 'task', runId, retryRunId, createdAt: '2026-10-10T00:00:00Z', title: 'test', source: 'remote', engine: 'rules', evidence: [], findings: [], logExcerpt: '', warnings: []})
describe('exact run associations',()=>{
  it('does not attach another task or run diagnosis',()=>{
    const history=[report('first','one','two'), {...report('other','one'),taskId:'other'}]
    expect(reportForRun(history,'task','three')).toBeUndefined()
    expect(reportForRun(history,'task','one')?.id).toBe('first')
    expect(reportForRun(history,'task','two')?.id).toBe('first')
  })
  it('prefers the retry run own diagnosis to its parent closure; latest direct report wins',()=>{
    const history=[report('origin','one','two'),report('followup','two'),{...report('new','two'),createdAt:'2026-10-10T01:00:00Z'}]
    expect(reportForRun(history,'task','two')?.id).toBe('new')
    expect(reportForRun(history,'task','one')?.id).toBe('origin')
  })
})
