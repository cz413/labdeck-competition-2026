import { describe, expect, it } from 'vitest'
import { diagnosisDiffText, verifiedDiagnosisChanges, type DiagnosisChange } from './diagnosis-diff'
import type { Evidence, DiagnosticStep } from './intelligence'
const change:DiagnosisChange={kind:'file',file:'main.py',startLine:2,before:'batch = 32',after:'batch = 16',evidenceId:'check-1'}
const evidence:Evidence[]=[{id:'check-1',source:'runtime',label:'source',text:JSON.stringify({status:'success',result:JSON.stringify({name:'main.py',content:'import torch\nbatch = 32\ntrain()\n'})})}]
const trace:DiagnosticStep[]=[{kind:'tool',tool:'read_project_file',status:'completed',arguments:{name:'main.py'},evidenceIds:['check-1'],label:'read',round:1,elapsedMs:0}]
describe('evidence backed diagnosis diffs',()=>{
  it('accepts exact source text at its real line and formats Markdown compatible Diff',()=>{
    expect(verifiedDiagnosisChanges([change],evidence,trace)).toEqual([change])
    expect(diagnosisDiffText(change)).toBe('--- a/main.py\n+++ b/main.py\n@@ -2,1 +2,1 @@\n-batch = 32\n+batch = 16')
  })
  it('rejects invented source, line numbers, unread files and failed checks',()=>{
    for(const patch of [{before:'batch=32'},{startLine:1},{file:'../main.py'},{evidenceId:'missing'},{before:'batch = 16',after:'batch = 16'}])expect(verifiedDiagnosisChanges([{...change,...patch}],evidence,trace)).toEqual([])
    expect(verifiedDiagnosisChanges([change],evidence,[])).toEqual([])
    expect(verifiedDiagnosisChanges([change],evidence,[{...trace[0],status:'failed'}])).toEqual([])
    expect(verifiedDiagnosisChanges([change],[{...evidence[0],text:'truncated JSON'}],trace)).toEqual([])
  })
  it('only accepts a command diff matching the recorded command without a fabricated source line',()=>{
    const command:DiagnosisChange={kind:'command',file:'启动命令',before:'python main.py --epoch 1',after:'python main.py --num_epochs 1',evidenceId:'log-1'}
    const logs:Evidence[]=[{id:'log-1',source:'log',label:'error',text:'unrecognized arguments: --epoch'}]
    expect(verifiedDiagnosisChanges([command],logs,[],command.before)).toEqual([command])
    expect(verifiedDiagnosisChanges([command],logs,[],'python other.py')).toEqual([])
    expect(verifiedDiagnosisChanges([{...command,startLine:10}],logs,[],command.before)).toEqual([])
  })
})
