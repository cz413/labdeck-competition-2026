import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DiagnosisChanges } from './DiagnosisChanges'
describe('diagnosis change display',()=>{
  it('shows the exact file and line, red/green text and separate copy actions',()=>{
    const html=renderToStaticMarkup(<DiagnosisChanges changes={[{kind:'file',file:'main.py',startLine:42,before:'x = 32',after:'x = 16',evidenceId:'source'}]}/> )
    expect(html).toContain('第 42 行起')
    expect(html).toContain('diff-remove')
    expect(html).toContain('-x = 32')
    expect(html).toContain('diff-add')
    expect(html).toContain('+x = 16')
    expect(html).toContain('复制修改后内容')
    expect(html).toContain('复制 Diff')
    expect(renderToStaticMarkup(<DiagnosisChanges changes={[]}/>)).toBe('')
  })
})
