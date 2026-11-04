import { describe, expect, it } from 'vitest'
import { isolateResearchVariants, reuseResearchOutput } from './research-output'
import { expandParameters } from '../shared/parameter-engine'
import type { ExperimentTaskDraft } from '../shared/types'
import type { ResearchOutputIsolation } from '../shared/research'
const baseline:ExperimentTaskDraft={title:'project',project:'project',objective:'',tags:[],priority:'normal',status:'planned',codePath:'/repo/python',dataPath:'',launchCommand:'python main.py --lr 0.001',artifactPath:'',resultSummary:'',notes:''}
const variants=()=>expandParameters(baseline.launchCommand,[{flag:'--lr',values:['0.001','0.002']}],2).variants
const plan=(targets:NonNullable<ResearchOutputIsolation['targets']>):ResearchOutputIsolation=>({status:'verified',engine:'model',targets,...targets[0]})
describe('apply AI output plans to each group',()=>{
  it('applies dataset-prefixed directory templates without inferring source semantics',()=>{
    const members=isolateResearchVariants('batch-a',baseline,variants(),plan([{flag:'--experiment',kind:'directory',template:'ml-1m_{value}',originalValue:'default'}]))
    expect(members[0].outputDirectory).toBe('/repo/python/ml-1m_exp_batcha_01')
    expect(members[1].outputDirectory).not.toBe(members[0].outputDirectory)
    expect(members[0].command).toContain('--experiment exp_batcha_01')
    expect(members[0].parameters).toEqual({'--lr':'0.001'})
  })
  it('preserves the parent of an explicit directory',()=>{
    const members=isolateResearchVariants('batch-a',baseline,variants(),plan([{flag:'--destination',kind:'directory',template:'{value}',originalValue:'/results/base'}]))
    expect(members[0].command).toContain('--destination /results/exp_batcha_01')
    expect(members[0].outputDirectory).toBe('/results/exp_batcha_01')
  })
  it('isolates model and log files and does not modify the baseline',()=>{
    const members=isolateResearchVariants('batch-tiger',baseline,variants(),plan([{flag:'--save_path',kind:'file',template:'{value}',originalValue:'./ckpt/tiger.pth'},{flag:'--log_path',kind:'file',template:'{value}',originalValue:'./logs/tiger.log'}]))
    expect(members[0].command).toContain('--save_path /repo/python/ckpt/exp_batchtiger_01/tiger.pth')
    expect(members[0].command).toContain('--log_path /repo/python/ckpt/exp_batchtiger_01/tiger.log')
    expect(members[0].outputDirectories).toEqual(['/repo/python/ckpt/exp_batchtiger_01'])
    expect(baseline.launchCommand).toBe('python main.py --lr 0.001')
  })
  it('does not replace missing AI conclusions with parameter-name guesses',()=>{
    const original=variants()
    expect(isolateResearchVariants('batch',baseline,original,{status:'unverified'})).toEqual(original)
  })
  it('supports real absolute output paths longer than parameter candidate limits',()=>{
    const task={...baseline,codePath:'/data/DataLACP/zhaogenghua/projects/competition/reproduction/TIGER/model'}
    const members=isolateResearchVariants('11111111-2222-4333-8444-555555555555',task,variants(),plan([{flag:'--save_path',kind:'file',template:'{value}',originalValue:'./ckpt/tiger.pth'},{flag:'--log_path',kind:'file',template:'{value}',originalValue:'./logs/tiger.log'}]))
    expect(members[0].outputDirectory!.length).toBeGreaterThan(80)
    expect(members[0].command).toContain(members[0].outputDirectory!+'/tiger.pth')
    expect(members[0].command).toContain(members[0].outputDirectory!+'/tiger.log')
  })
  it('uses a readable batch name and group index supplied by the persistent allocator',()=>{
    const members=isolateResearchVariants('batch',baseline,variants(),plan([{flag:'--train_dir',kind:'directory',template:'{value}',originalValue:'default'}]),'labdecka')
    expect(members[0].command).toContain('--train_dir labdecka_g01')
    expect(members[1].command).toContain('--train_dir labdecka_g02')
  })
  it('reuses the previous output flags while keeping other configuration fixes',()=>{
    const result=reuseResearchOutput('python main.py --lr 0.01 --save_path /old/model.pth --log_path /old/log.txt --epochs 10','python main.py --lr 0.01 --save_path /original/model.pth --log_path /original/log.txt',plan([{flag:'--save_path',kind:'file',template:'{value}',originalValue:'model.pth'},{flag:'--log_path',kind:'file',template:'{value}',originalValue:'log.txt'}]))
    expect(result).toContain('--save_path /original/model.pth')
    expect(result).toContain('--log_path /original/log.txt')
    expect(result).toContain('--epochs 10')
  })
  it('avoids filename collisions across separate file parameters',()=>{
    const members=isolateResearchVariants('batch',baseline,variants(),plan([{flag:'--model',kind:'file',template:'{value}',originalValue:'models/out.txt'},{flag:'--journal',kind:'file',template:'{value}',originalValue:'logs/out.txt'}]))
    expect(members[0].command).toContain('journal_out.txt')
  })
})
