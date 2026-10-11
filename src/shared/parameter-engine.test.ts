import { describe, expect, it } from 'vitest'
import { expandParameters, parseMetricLog } from './parameter-engine'
describe('controlled parameter expansion',()=>{
  it('expands a cartesian grid, deduplicates seeds and preserves fixed arguments',()=>{
    const result=expandParameters('python train.py --lr=0.01 --batch-size 16',[{flag:'--lr',values:['0.001','0.0001']},{flag:'--seed',values:['42','42','43']}],4)
    expect(result.variants.map(v=>v.command)).toEqual(['python train.py --lr=0.001 --batch-size 16 --seed 42','python train.py --lr=0.001 --batch-size 16 --seed 43','python train.py --lr=0.0001 --batch-size 16 --seed 42','python train.py --lr=0.0001 --batch-size 16 --seed 43'])
    expect(result.warnings).toEqual([])
  })
  it('blocks excess runs before expansion and flags ambiguous source arguments',()=>{
    expect(()=>expandParameters('python train.py',[{flag:'--seed',values:['1','2','3']}],2)).toThrow('超过')
    expect(()=>expandParameters('python train.py --seed 1 --seed=2',[{flag:'--seed',values:['3']}],1)).toThrow('重复')
    expect(()=>expandParameters('python train.py --seed --lr 0.1',[{flag:'--seed',values:['3']}],1)).toThrow('没有参数值')
  })
  it('rejects shell execution in both baseline and model-controlled values',()=>{
    expect(()=>expandParameters('python train.py; rm -rf /',[{flag:'--seed',values:['1']}],1)).toThrow()
    expect(()=>expandParameters('python train.py',[{flag:'--seed',values:['1 $(whoami)']}],1)).toThrow()
    expect(()=>expandParameters('python train.py',[{flag:'--seed',values:['1']},{flag:'--seed',values:['2']}],1)).toThrow()
  })
  it('warns that multi-variable search does not isolate causal effects',()=>{
    expect(expandParameters('python train.py',[{flag:'--lr',values:['1','2']},{flag:'--batch',values:['4','8']}],4).warnings.length).toBe(1)
  })
  it('keeps metric keys and units distinct and reads the latest observed value',()=>{
    expect(parseMetricLog('epoch=1 train_loss=0.8 val_acc: 80%\nepoch=2 train_loss=0.9 val_acc: 78%\n{"metrics":{"test_accuracy":0.77,"tokens":10}}')).toEqual({train_loss:0.9,val_acc_percent:78,test_accuracy:0.77})
  })
})
