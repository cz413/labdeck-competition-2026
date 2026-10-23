import { describe, expect, it } from 'vitest'
import { inspectResearchOutput, isolateResearchVariants } from './research-output'
import { expandParameters } from '../shared/parameter-engine'
import type { ExperimentTaskDraft } from '../shared/types'
import type { RepositoryExcerpt } from '../shared/repository-guide'
const baseline=(launchCommand:string):ExperimentTaskDraft=>({title:'SASRec',project:'SASRec',objective:'',tags:[],priority:'normal',status:'planned',codePath:'/repo/python',dataPath:'',launchCommand,artifactPath:'',resultSummary:'',notes:''})
const file=(text:string):RepositoryExcerpt=>({path:'main.py',startLine:1,text,truncated:false})
describe('verified per-group output directories',()=>{
  it('recognizes SASRec dataset + train_dir output and gives each group a unique directory',()=>{
    const task=baseline('python main.py --dataset=ml-1m --train_dir=default --batch_size=128')
    const files=[file(`parser.add_argument('--dataset', required=True)
parser.add_argument('--train_dir', required=True)
folder = args.dataset + '_' + args.train_dir
os.makedirs(folder)
f = open(os.path.join(folder, 'log.txt'), 'w')
torch.save(model.state_dict(), os.path.join(folder, 'model.pth'))`)]
    const plan=inspectResearchOutput(task,files)
    expect(plan).toMatchObject({status:'verified',flag:'--train_dir',template:'ml-1m_{value}'})
    const variants=expandParameters(task.launchCommand,[{flag:'--batch_size',values:['128','64']}],2).variants
    const members=isolateResearchVariants('11111111-2222-3333-4444-555555555555',task,variants,plan)
    expect(members[0].outputDirectory).toBe('/repo/python/ml-1m_labdeck_11111111222233334444555555555555_g01')
    expect(members[1].outputDirectory).not.toBe(members[0].outputDirectory)
    expect(members[0].command).not.toContain('--train_dir=default');expect(members[1].command).toContain('--batch_size=64')
    expect(task.launchCommand).toContain('--train_dir=default');expect(members[0].parameters).toEqual({'--batch_size':'128'})
  })
  it('recognizes a declared output directory used by actual write operations',()=>{
    const task=baseline('python main.py --lr 0.01')
    const plan=inspectResearchOutput(task,[file(`p.add_argument('--output_dir', default='/results/base')
os.makedirs(args.output_dir, exist_ok=True)
f=open(os.path.join(args.output_dir, 'metrics.csv'), 'w')`)])
    expect(plan.status).toBe('verified')
    const members=isolateResearchVariants('batch-a',task,expandParameters(task.launchCommand,[{flag:'--lr',values:['0.01','0.001']}],2).variants,plan)
    expect(members[0].command).toContain('--output_dir /results/labdeck_batcha_g01')
    expect(members[0].outputDirectory).toBe('/results/labdeck_batcha_g01')
  })
  it('does not infer output isolation from an argument name or a read-only file',()=>{
    const task=baseline('python main.py --output_dir outputs')
    expect(inspectResearchOutput(task,[file("p.add_argument('--output_dir', default='outputs')")]).status).toBe('unverified')
    expect(inspectResearchOutput(task,[file("p.add_argument('--output_dir', default='outputs')\nos.makedirs(args.output_dir)\nf=open(os.path.join(args.output_dir, 'input.txt'), 'r')")]).status).toBe('unverified')
  })
  it('rejects ambiguous independent save locations',()=>{
    const task=baseline('python main.py --output_dir logs --model_dir models')
    const code=['output_dir','model_dir'].map(name=>`p.add_argument('--${name}', default='out')\nos.makedirs(args.${name})\nf=open(os.path.join(args.${name}, 'out.txt'), 'w')`).join('\n')
    expect(inspectResearchOutput(task,[file(code)]).status).toBe('unverified')
  })
})
