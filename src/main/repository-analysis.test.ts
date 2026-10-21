import { describe, expect, it } from 'vitest'
import { parseRepositoryGuide, applyRepositoryChecks, repositoryLaunchPaths, fillLaunchFromReadme, resolveAutoAnsweredInputs } from './repository-analysis'
import { investigate } from './diagnostic-agent'
import type { RepositorySnapshot } from '../shared/repository-guide'
const snapshot:RepositorySnapshot={input:{source:'remote',serverId:'22222222-2222-4222-8222-222222222222',path:'/repo'},files:[{path:'README.md',sizeBytes:100}],excerpts:[{path:'README.md',text:'# Repo\nUse the existing environment.\npython train.py --epochs 1',startLine:1,truncated:false}],warnings:[],collectedAt:'2026-10-20T00:00:00.000Z'}
const citation={path:'README.md',startLine:3,endLine:3}
function answer(){return {status:'ready_for_review',summary:'Run the documented baseline.',steps:[{title:'Train',explanation:'From the README.',workingDirectory:'',environment:'未确认',origin:'documented',commands:['python train.py --epochs 1'],citations:[citation]}],launchCommand:'python train.py --epochs 1',launchOrigin:'documented',launchCitations:[citation],workingDirectory:'',environmentName:'',dataPath:'',missingInputs:[],questions:[]}}
describe('repository guide evidence and launch readiness',()=>{
  it('derives the displayed original quote from real excerpt lines',()=>{
    const guide=parseRepositoryGuide(answer(),snapshot)
    expect(guide.launchCitations[0].quote).toBe('python train.py --epochs 1')
    expect(guide.launchOrigin).toBe('documented')
  })
  it('rejects citations outside the provided excerpt instead of fabricating evidence',()=>{
    const raw=answer();raw.launchCitations=[{...citation,startLine:99,endLine:99}]
    expect(()=>parseRepositoryGuide(raw,snapshot)).toThrow('未读取')
  })
  it('labels a changed command as a suggestion even when the model calls it documented',()=>{
    const raw=answer();raw.launchCommand='python train.py --epochs 2'
    const guide=parseRepositoryGuide(raw,snapshot)
    expect(guide.launchOrigin).toBe('suggested');expect(guide.warnings.length).toBeGreaterThan(0)
  })
  it('does not mark placeholders ready even when referenced paths exist',()=>{
    const raw=answer();raw.launchCommand='python train.py --data /path/to/data'
    const guide=applyRepositoryChecks(parseRepositoryGuide(raw,snapshot),[{path:'.',expected:'directory',status:'confirmed',message:'exists'},{path:'train.py',expected:'file',status:'confirmed',message:'exists'}])
    expect(guide.status).toBe('needs_info')
  })
  it('does not claim readiness after a failed path check',()=>{
    const guide=applyRepositoryChecks(parseRepositoryGuide(answer(),snapshot),[{path:'train.py',expected:'file',status:'unreadable',message:'connection unavailable'}])
    expect(guide.status).toBe('needs_info');expect(guide.missingInputs.join()).toContain('connection unavailable')
  })
  it('rejects traversal in a model-proposed working directory',()=>{
    expect(()=>parseRepositoryGuide({...answer(),workingDirectory:'../other'},snapshot)).toThrow()
  })
  it('checks the launcher entry rather than another Python-valued argument',()=>{
    const guide=parseRepositoryGuide({...answer(),launchCommand:'python train.py --plugin helper.py'},snapshot)
    expect(repositoryLaunchPaths(guide)).toContainEqual({path:'train.py',expected:'file'})
  })
  it('forces a final answer on the only permitted quick-analysis request',async()=>{
    let calls=0
    await investigate({evidence:[{id:'log-1',source:'log',label:'error',text:'RuntimeError'}],warnings:[],tools:[],context:{},signal:new AbortController().signal,maxModelRounds:1,
      request:async(_system,payload)=>{calls++;expect((payload as {finalOnly:boolean}).finalOnly).toBe(true);return {action:'final',summary:'Need more context',findings:[{category:'unknown',title:'Missing context',confidence:'low',explanation:'Only one error line is provided',evidenceIds:['log-1'],steps:['Provide full traceback']}] }},execute:async()=>{throw new Error('quick analysis must not execute tools')}})
    expect(calls).toBe(1)
  })
})

import { isRepositoryLaunchCommand, recommendRepositoryFiles, repositoryReviewQuestions } from '../shared/repository-guide'
import { reviewRepositoryGuide } from './repository-review'
import { repositoryReferenceCandidates, repositoryReferences, repositoryTextExcerpts } from './repository-reader'

describe('focused repository startup',()=>{
  it('reads the whole repository with documentation, dependencies and the relevant entry first',()=>{
    const files=['docs/README.md','README.md','environment.yml','requirements.txt','train.py','evaluate.py','package.json'].map(path=>({path,sizeBytes:100}))
    const training=recommendRepositoryFiles(files,'运行一次训练')
    expect(training.slice(0,4)).toEqual(['README.md','environment.yml','requirements.txt','train.py'])
    expect(training).toHaveLength(files.length)
    expect(training).toEqual(expect.arrayContaining(files.map(file=>file.path)))
    expect(recommendRepositoryFiles(files,'运行模型评估').slice(0,4)).toEqual(['README.md','environment.yml','requirements.txt','evaluate.py'])
  })
  it('sends the complete file text with real line numbers',()=>{
    const text=['# Repo',...Array.from({length:180},(_,i)=>`Background ${i} `+'context '.repeat(12)),'## Training','python train.py --epochs 1','## Installation','pip install -r requirements.txt'].join('\n')
    const excerpts=repositoryTextExcerpts('README.md',text)
    expect(excerpts).toHaveLength(1)
    expect(excerpts[0]).toEqual({startLine:1,text})
    expect(excerpts[0].text).toContain('python train.py --epochs 1')
    expect(excerpts[0].text).toContain('pip install -r requirements.txt')
  })
  it('pulls scripts referenced by README and accepts a wrapper as a minimal launch command',()=>{
    expect(repositoryReferences('bash scripts/train_common.sh --config configs/base.yaml')).toEqual(['scripts/train_common.sh','configs/base.yaml'])
    expect(repositoryReferenceCandidates('scripts/README.md','train_common.sh')).toEqual(['scripts/train_common.sh','train_common.sh'])
    expect(repositoryReferenceCandidates('README.md','scripts/train_common.sh')).toContain('scripts/train_common.sh')
    expect(isRepositoryLaunchCommand('bash scripts/train_common.sh')).toBe(true)
  })
  it('fills a documented wrapper when the model leaves the launch command empty',()=>{
    const raw=answer();raw.launchCommand='';raw.launchCitations=[];raw.status='needs_info';raw.missingInputs=[]
    const source:RepositorySnapshot={...snapshot,excerpts:[{path:'README.md',startLine:1,text:'# Repo\n\nbash scripts/train_common.sh --config configs/base.yaml',truncated:false}]}
    const guide=fillLaunchFromReadme(parseRepositoryGuide(raw,source),source)
    expect(guide.launchCommand).toBe('bash scripts/train_common.sh --config configs/base.yaml')
    expect(guide.launchOrigin).toBe('suggested')
    expect(guide.launchCitations[0]).toMatchObject({path:'README.md',startLine:3,endLine:3})
    expect(guide.missingInputs).not.toContain('尚未确定可审查的训练或评估启动命令。')
  })
  it('clears data and environment questions once those fields are auto-filled',()=>{
    const base=parseRepositoryGuide({...answer(),status:'needs_info',missingInputs:['实际数据集在哪里？','使用哪个 Conda 环境？']},snapshot)
    const resolved=resolveAutoAnsweredInputs({...base,dataPath:'/data/actual',environmentName:'vision'})
    expect(resolved.missingInputs).toEqual([])
    expect(resolved.status).toBe('ready_for_review')
    const partial=resolveAutoAnsweredInputs({...base,dataPath:'/data/actual',environmentName:''})
    expect(partial.missingInputs).toEqual(['使用哪个 Conda 环境？'])
    expect(partial.status).toBe('needs_info')
  })
  it('rechecks corrected fields instead of asking the user to answer machine-generated path errors',()=>{
    const checked=applyRepositoryChecks(parseRepositoryGuide(answer(),snapshot),[{path:'train.py',expected:'file',status:'missing',message:'本次未找到该路径'}])
    expect(repositoryReviewQuestions(checked)).toEqual([])
    const review=reviewRepositoryGuide(checked,{launchCommand:'python train.py --epochs 1',workingDirectory:'',environmentName:'',dataPath:'',resolutions:[]})
    const ready=applyRepositoryChecks(review,[{path:'.',expected:'directory',status:'confirmed',message:'exists'},{path:'train.py',expected:'file',status:'confirmed',message:'exists'}])
    expect(ready.status).toBe('ready_for_review')
    expect(ready.launchOrigin).toBe('documented')
    expect(ready.launchCitations).toEqual(checked.launchCitations)
  })
  it('keeps genuine data questions blocking until the user answers them',()=>{
    const base=parseRepositoryGuide({...answer(),status:'needs_info',missingInputs:['实际数据集在哪里？']},snapshot)
    const input={launchCommand:base.launchCommand,workingDirectory:'',environmentName:'',dataPath:'',resolutions:[]}
    expect(reviewRepositoryGuide(base,input).status).toBe('needs_info')
    expect(reviewRepositoryGuide(base,{...input,dataPath:'/data/actual',resolutions:[{question:'实际数据集在哪里？',answer:'/data/actual'}]}).status).toBe('ready_for_review')
    expect(reviewRepositoryGuide(base,{...input,dataPath:'/your/path',resolutions:[{question:'实际数据集在哪里？',answer:'later'}]}).status).toBe('needs_info')
  })
})

it('keeps a long README complete instead of trimming it to a fixed budget',()=>{
  const text=['# Repo','## Training',...Array.from({length:35},()=>('intro '.repeat(10))),'python train.py --epochs 1',...Array.from({length:120},()=>('background '.repeat(10)))].join('\n')
  const pieces=repositoryTextExcerpts('README.md',text)
  expect(pieces).toHaveLength(1)
  expect(pieces[0]).toEqual({startLine:1,text})
})

// Regression: a valid long citation used to reject the whole startup plan.
describe('repository citations from actual read ranges',()=>{
  const command='python train.py --epochs 1'
  const lines=Array.from({length:24},(_,index)=>index===20?command:`Documented line ${index+1}`)
  const longSnapshot:RepositorySnapshot={...snapshot,excerpts:[{path:'README.md',startLine:1,text:lines.join('\n'),truncated:false}]}
  function withRange(startLine:number,endLine:number){
    const ref={path:'README.md',startLine,endLine}
    const raw=answer()
    raw.steps.push({...raw.steps[0],title:'Second step',citations:[ref]})
    raw.launchCitations=[ref]
    return raw
  }
  it('accepts the reported steps[1] and launch citation ranges longer than eight lines',()=>{
    const guide=parseRepositoryGuide(withRange(1,24),longSnapshot)
    expect(guide.steps[1].citations[0]).toEqual({path:'README.md',startLine:1,endLine:24,quote:lines.join('\n')})
    expect(guide.launchCitations[0].quote).toBe(lines.join('\n'))
    expect(guide.launchOrigin).toBe('documented')
  })
  it('supports adjacent and overlapping read windows with original line numbers',()=>{
    const overlapping:RepositorySnapshot={...longSnapshot,excerpts:[
      {path:'README.md',startLine:1,text:lines.slice(0,12).join('\n'),truncated:true},
      {path:'README.md',startLine:12,text:lines.slice(11).join('\n'),truncated:true}
    ]}
    expect(parseRepositoryGuide(withRange(4,24),overlapping).launchCitations[0].quote).toBe(lines.slice(3).join('\n'))
    const adjacent={...overlapping,excerpts:[overlapping.excerpts[0],{...overlapping.excerpts[1],startLine:13,text:lines.slice(12).join('\n')}]}
    expect(parseRepositoryGuide(withRange(4,24),adjacent).launchOrigin).toBe('documented')
  })
  it('keeps a full line when an earlier read window ended mid-line',()=>{
    const partial:RepositorySnapshot={...longSnapshot,excerpts:[
      {path:'README.md',startLine:1,text:lines.slice(0,20).join('\n')+'\npython train',truncated:true},
      {path:'README.md',startLine:21,text:lines.slice(20).join('\n'),truncated:false}
    ]}
    expect(parseRepositoryGuide(withRange(1,24),partial).launchCitations[0].quote).toContain(command)
    expect(parseRepositoryGuide(withRange(1,24),partial).launchOrigin).toBe('documented')
  })
  it('rejects a citation spanning an unread gap',()=>{
    const gap:RepositorySnapshot={...longSnapshot,excerpts:[
      {path:'README.md',startLine:1,text:lines.slice(0,10).join('\n'),truncated:true},
      {path:'README.md',startLine:12,text:lines.slice(11).join('\n'),truncated:true}
    ]}
    expect(()=>parseRepositoryGuide(withRange(1,24),gap)).toThrow('未读取')
  })
  it('does not silently clamp out-of-range or enormous citations to available text',()=>{
    expect(()=>parseRepositoryGuide(withRange(1,25),longSnapshot)).toThrow('未读取')
    expect(()=>parseRepositoryGuide(withRange(1,1_000_000_000),longSnapshot)).toThrow('未读取')
  })
  it('still rejects unknown source files even when line numbers exist elsewhere',()=>{
    const raw=withRange(1,24)
    raw.launchCitations[0].path='unknown.md'
    expect(()=>parseRepositoryGuide(raw,longSnapshot)).toThrow('未读取')
  })
  it('gives a readable error for reversed ranges rather than a raw validation array',()=>{
    expect(()=>parseRepositoryGuide(withRange(24,1),longSnapshot)).toThrow('启动命令引用：引用结束行不能早于起始行')
  })
})

describe('repository review precision and goal-aware fallback',()=>{
  it('does not replace data preparation or dependency requirements with a directory/name',()=>{
    const questions=['数据是否预处理完成？','数据集的划分是否匹配论文？','环境中的 PyTorch/CUDA 版本是否兼容？','使用哪个 Conda 环境？','实际数据集在哪里？']
    const base=parseRepositoryGuide({...answer(),status:'needs_info',missingInputs:questions},snapshot)
    const resolved=resolveAutoAnsweredInputs({...base,dataPath:'/data/actual',environmentName:'vision'})
    expect(resolved.missingInputs).toEqual(questions.slice(0,3));expect(resolved.status).toBe('needs_info')
  })
  it('selects evaluation rather than the first setup/training command',()=>{
    const source:RepositorySnapshot={...snapshot,excerpts:[{path:'README.md',startLine:1,text:'# Install\npython setup.py install\n# Training\npython train.py\n# Evaluation\npython evaluate.py',truncated:false}]}
    const raw={...answer(),launchCommand:'',launchCitations:[]}
    expect(fillLaunchFromReadme(parseRepositoryGuide(raw,source),source,'评估已有模型').launchCommand).toBe('python evaluate.py')
    expect(fillLaunchFromReadme(parseRepositoryGuide(raw,source),source,'训练一次').launchCommand).toBe('python train.py')
  })
  it('keeps ambiguous README training alternatives for review',()=>{
    const source:RepositorySnapshot={...snapshot,excerpts:[{path:'README.md',startLine:1,text:'# Training\npython train.py --dataset a\npython train.py --dataset b',truncated:false}]}
    const guide=fillLaunchFromReadme(parseRepositoryGuide({...answer(),launchCommand:'',launchCitations:[]},source),source,'训练模型')
    expect(guide.launchCommand).toBe('');expect(guide.warnings.join()).toContain('多条候选')
  })
  it('does not turn a preparation-only command into a training entry',()=>{
    const source:RepositorySnapshot={...snapshot,excerpts:[{path:'README.md',startLine:1,text:'# Data preparation\npython prepare.py\n',truncated:false}]}
    expect(fillLaunchFromReadme(parseRepositoryGuide({...answer(),launchCommand:'',launchCitations:[]},source),source,'训练模型').launchCommand).toBe('')
  })
})
