import { describe, expect, it } from 'vitest'
import { actionableDiagnosisText, diagnosisPresentation } from './diagnosis-presentation'
import { diagnoseEvidence } from './diagnosis-engine'
import type { DiagnosisReport, Evidence, Finding } from './intelligence'
const evidence:Evidence[]=[{id:'log-1',source:'log',label:'错误日志',line:27,text:'FileNotFoundError: data/1111.txt not found.'},{id:'runtime',source:'runtime',label:'运行记录',text:'{"command":"python main.py --dataset=1111","codePath":"/repo/python"}'}]
const finding:Finding={origin:'model',category:'path',title:'找不到数据文件 data/1111.txt',confidence:'high',explanation:'日志确认缺少相对路径 data/1111.txt；本次启动目录为 /repo/python，尚未核验文件是否存在。',evidenceIds:['log-1','runtime'],steps:['核对 /repo/python/data/1111.txt 是否为预期的数据文件。','核对本次 --dataset=1111 是否对应实际数据集名称，未经验证不要替换为其他数据集。']}
function report():DiagnosisReport{return {id:'report',createdAt:'2026-10-22T00:00:00Z',title:'运行诊断',source:'remote',engine:'model+rules',evidence,findings:[...diagnoseEvidence(evidence).map(f=>({...f,origin:'rules' as const})),finding],logExcerpt:evidence[0].text,warnings:[],investigation:{status:'completed',rounds:1,inspections:0,trace:[]}}}
describe('specific evidence-backed diagnosis presentation',()=>{
  it('prefers a validated model explanation over the generic file-not-found template',()=>{
    const result=diagnosisPresentation(report())
    expect(result.primary?.title).toBe(finding.title)
    expect(result.steps).toEqual(finding.steps)
    expect(result.evidence[0].id).toBe('log-1')
  })
  it('retains the rule result without successful model analysis',()=>{
    for(const status of ['failed','cancelled'] as const){
      const value=report();value.investigation!.status=status
      expect(diagnosisPresentation(value).primary?.title).toBe('运行引用的文件或目录不可用')
    }
    expect(diagnosisPresentation({...report(),engine:'rules'}).primary?.origin).not.toBe('model')
  })
  it('falls back when a model finding is low confidence or cites fabricated evidence',()=>{
    for(const patch of [{confidence:'low' as const},{evidenceIds:['log-1','fabricated']},{evidenceIds:['runtime']}]){
      const value=report();value.findings=[{...finding,...patch}]
      expect(diagnosisPresentation(value).primary?.title).toBe('运行引用的文件或目录不可用')
    }
  })
  it('does not confuse the original untagged rule with a historical model finding',()=>{
    const value=report();value.findings=[...diagnoseEvidence(evidence),{...finding,origin:undefined}]
    expect(diagnosisPresentation(value).primary?.title).toBe(finding.title)
  })
  it('limits the displayed recommendations to three concrete steps',()=>{
    const value=report();value.findings=[{...finding,steps:['one','two','three','four']}]
    expect(diagnosisPresentation(value).steps).toEqual(['one','two','three'])
  })
})

describe('actionable advice without backend status codes',()=>{
  it('keeps the useful verification action and removes the exit-code suffix',()=>{
    expect(actionableDiagnosisText('重新运行修改后的命令，确认不再出现参数错误且退出码不为 2。')).toBe('重新运行修改后的命令，确认不再出现参数错误。')
    expect(actionableDiagnosisText('将 --epoch=1 改为 --num_epochs=1，并确认退出码为 0。')).toBe('将 --epoch=1 改为 --num_epochs=1。')
  })
  it('removes machine-only instructions while retaining concrete configuration changes',()=>{
    const value=report()
    value.findings=[{...finding,explanation:'找不到数据文件 data/1111.txt，退出码 1 与此一致。',steps:['确认退出码为 0。','在编辑配置中核对数据目录。','保存后重新运行，确认能进入训练流程。']}]
    const result=diagnosisPresentation(value)
    expect(result.primary?.explanation).toBe('找不到数据文件 data/1111.txt。')
    expect(result.steps).toEqual(['在编辑配置中核对数据目录。','保存后重新运行，确认能进入训练流程。'])
  })
  it('keeps raw log content available but excludes generic launcher failures from primary evidence',()=>{
    const value=report()
    value.evidence.push({id:'wrapper',source:'log',label:'启动器',text:'ERROR conda.cli.main_run:execute(125): command failed. See above for error.'})
    value.findings=[{...finding,evidenceIds:['log-1','wrapper']}]
    const result=diagnosisPresentation(value)
    expect(result.evidence.map(item=>item.id)).toEqual(['log-1'])
    expect(value.evidence.find(item=>item.id==='wrapper')?.text).toContain('execute(125)')
  })
})
