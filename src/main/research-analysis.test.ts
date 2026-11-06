import { describe, expect, it } from 'vitest'
import { displayResultAnalysis } from './research-analysis'
describe('model analysis display without content validation',()=>{
  it('accepts missing evidence references and long content',()=>{
    const summary='比较结果'.repeat(2000)
    expect(displayResultAnalysis({summary}).summary).toBe(summary)
    expect(displayResultAnalysis({summary}).evidenceIds).toEqual([])
  })
  it('accepts prose, fenced JSON and nonstandard observation types',()=>{
    expect(displayResultAnalysis('直接分析正文').summary).toBe('直接分析正文')
    expect(displayResultAnalysis('```json\n{"summary":"比较"}\n```').summary).toBe('比较')
    expect(displayResultAnalysis({summary:'比较',observations:[{text:'观察'}]}).observations).toEqual(['{"text":"观察"}'])
  })
  it('keeps model content and references without filtering',()=>{
    expect(displayResultAnalysis({summary:'exitCode=0',evidenceIds:['custom']}).summary).toBe('exitCode=0')
    expect(displayResultAnalysis({evidenceIds:['custom']}).evidenceIds).toEqual(['custom'])
  })
})
