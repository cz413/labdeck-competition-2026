import {it,expect} from 'vitest'
import {reviewResearchCommand} from './research-command'
it('normalizes the user evaluation command while preserving the requested GPU and every script argument',()=>{
  const suffix='main.py --dataset=Video --train_dir=eval_only_epoch1000 --device=cuda --inference_only=true --state_dict_path=runs/games/SASRec.epoch=1000.lr=0.001.pth'
  expect(reviewResearchCommand('CUDA_VISIBLE_DEVICES=1 python -u '+suffix)).toMatchObject({command:'python '+suffix,preferredGpuIndex:1})
})
it('does not silently strip unsupported environments, shell operations, or multiple GPU bindings',()=>{
  for(const command of ['FOO=bar python main.py','cd /repo && python main.py','python main.py | tee log.txt','CUDA_VISIBLE_DEVICES=1,2 python main.py'])expect(reviewResearchCommand(command).command).toBeUndefined()
  expect(reviewResearchCommand('','script').command).toBeUndefined()
})
