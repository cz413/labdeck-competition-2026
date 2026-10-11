import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { ParameterBridge } from './parameter-bridge'
import { expandParameters } from '../shared/parameter-engine'
describe('compiled Cangjie engine integration',()=>{
  it('executes the real native binary and agrees on replacement, additions and deduplication',async()=>{
    const bridge=new ParameterBridge(resolve('resources/cangjie'))
    expect((await bridge.status()).available).toBe(true)
    for(const command of ['python train.py --lr=0.01 --batch-size 16','python train.py --lr 0.01','python train.py']){
      const axes=[{flag:'--lr',values:['0.001','0.001','0.0001']},{flag:'--seed',values:['42','43']}]
      const result=await bridge.expand(command,axes,4)
      expect(result.engine).toBe('cangjie');expect(result.variants).toEqual(expandParameters(command,axes,4).variants)
    }
  })
  it('labels a missing engine explicitly instead of claiming Cangjie execution',async()=>{
    const result=await new ParameterBridge(resolve('artifacts/no-cangjie')).expand('python train.py',[{flag:'--seed',values:['1']}],1)
    expect(result.engine).toBe('typescript');expect(result.warnings.join('')).toContain('不可用')
  })
})
