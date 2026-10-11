import { describe, expect, it } from 'vitest'
import { diagnosticSamples, diagnoseEvidence, logEvidence, proposeBatchRepair, redactSecrets } from './diagnosis-engine'

describe('evidence-grounded diagnosis',()=>{
  it.each([['oom','oom'],['dependency','dependency'],['path','path']] as const)('identifies %s using an actual log line',(sample,category)=>{
    const {evidence}=logEvidence(diagnosticSamples[sample]);const finding=diagnoseEvidence(evidence)[0]
    expect(finding.category).toBe(category)
    expect(finding.evidenceIds.length).toBeGreaterThan(0)
    expect(finding.evidenceIds.every(id=>evidence.some(e=>e.id===id))).toBe(true)
  })
  it('does not claim success or a diagnosis when logs are empty',()=>{
    expect(diagnoseEvidence([])[0]).toMatchObject({category:'unknown',confidence:'low',evidenceIds:[]})
  })
  it('keeps relative line numbers correct when bounding logs',()=>{
    const input=Array.from({length:300},(_,i)=>`line ${i}`).join('\n')
    const result=logEvidence(input)
    expect(result.clipped).toBe(true);expect(result.evidence).toHaveLength(240)
    expect(result.evidence[0]).toMatchObject({line:1,text:'line 60'})
    expect(result.evidence.at(-1)).toMatchObject({line:240,text:'line 299'})
  })
  it('redacts tokens, JSON secrets, bearer credentials, URL credentials and private keys',()=>{
    const raw='API_KEY=abc123\n{"password":"hidden-secret"}\nAuthorization: Bearer very-secret\nhttps://user:password@example.com\n-----BEGIN PRIVATE KEY-----\nkey-body\n-----END PRIVATE KEY-----'
    const clean=redactSecrets(raw)
    for(const value of ['abc123','hidden-secret','very-secret','user:password','key-body'])expect(clean).not.toContain(value)
    expect(clean).toContain('[已隐藏]')
  })
})
describe('bounded batch repair',()=>{
  it.each(['python train.py --batch-size 32','python3 train.py --batch_size=32'])('only halves an explicit batch parameter: %s',command=>{
    const repair=proposeBatchRepair(command,true)
    expect(repair?.previousBatch).toBe(32);expect(repair?.nextBatch).toBe(16)
    expect(repair?.after).toContain('16');expect(repair?.before).toBe(command)
  })
  it.each(['python train.py --batch-size 1','python train.py','bash run.sh --batch-size 32','python -c pass --batch-size 32','python -m train --batch-size 32','python train.py --batch-size 32; rm file','python train.py --batch-size 32 | cat','python train.py --batch-size 32 --batch_size 16','python train.py --label "something --batch-size 32 foo"','python train.py --batch-size 32 --token=secret'])('rejects unsupported or ambiguous repairs: %s',command=>{
    expect(proposeBatchRepair(command,true)).toBeUndefined()
  })
  it('does not enable a repair from a model opinion or script launch',()=>{
    expect(proposeBatchRepair('python train.py --batch-size 32',false)).toBeUndefined()
    expect(proposeBatchRepair('python train.py --batch-size 32',true,'script')).toBeUndefined()
  })
})
