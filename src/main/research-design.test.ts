import { describe, expect, it } from 'vitest'
import { researchImports, researchParameters, researchReadPaths, validateResearchDesign } from './research-design'
import type { RepositoryExcerpt } from '../shared/repository-guide'
const command='python main.py --lr 0.001'
const file=(text:string):RepositoryExcerpt=>({path:'main.py',startLine:1,text,truncated:false})
const files=[file("import argparse\np = argparse.ArgumentParser()\np.add_argument('--lr', type=float, default=0.01)\np.add_argument('--batch_size', type=int, default=32, choices=[16, 32, 64])")]
const answer=(flag='--lr',values=['0.01'])=>({axes:[{flag,values}],hypothesis:'比较训练效果',rationale:'保持其他条件一致',assumptions:[]})
describe('project grounded research design',()=>{
  it('uses explicit command values before project defaults and includes absent documented parameters',()=>{
    const parameters=researchParameters(command,files)
    expect(parameters.find(p=>p.flag==='--lr')).toMatchObject({baselineValue:'0.001',source:{path:'main.py',startLine:3}})
    expect(parameters.find(p=>p.flag==='--batch_size')).toMatchObject({baselineValue:'32',choices:['16','32','64']})
  })
  it('ignores comments, docstrings, dynamic defaults and unsupported converters',()=>{
    const parameters=researchParameters(command,[file(`# p.add_argument('--fake', type=int, default=1)\n"p.add_argument('--quoted', default=1)"\np.add_argument('--dynamic', type=int, default=settings.batch)\np.add_argument('--custom', type=bool, default=True)\np.add_argument('--data_path', default='data')` )])
    expect(parameters.map(p=>p.flag)).toEqual(['--dynamic']);expect(parameters[0].baselineValue).toBeUndefined()
  })
  it('handles multiline declarations and aliases without guessing ambiguous duplicates',()=>{
    const parameters=researchParameters(command,[file(`p.add_argument('-b', '--batch',\n type=int,\n default=32)\np.add_argument('--duplicate', type=int, default=1)\np.add_argument('--duplicate', type=int, default=2)` )])
    expect(parameters.map(p=>p.flag)).toEqual(['--batch']);expect(parameters[0].baselineValue).toBe('32')
  })
  it('resolves alias values and multiline comments without treating defaults as explicit values',()=>{
    const result=researchParameters('python main.py -b 16',[file(`p.add_argument('-b', '--batch', # batch option
 type=int, # integer values
 default=32)` )])
    expect(result[0]).toMatchObject({type:'int',baselineValue:'16'})
  })
  it('adds a baseline run and validates budget including it',()=>{
    const result=validateResearchDesign(answer(),command,researchParameters(command,files),2)
    expect(result.axes[0].values).toEqual(['0.001','0.01']);expect(result.status).toBe('ready')
    expect(()=>validateResearchDesign(answer(),command,researchParameters(command,files),1)).toThrow('预算')
  })
  it('rejects invented parameters, choices and integer type mismatches',()=>{
    const parameters=researchParameters(command,files)
    expect(()=>validateResearchDesign(answer('--invented'),command,parameters,4)).toThrow('项目定义')
    expect(()=>validateResearchDesign(answer('--batch_size',['128']),command,parameters,4)).toThrow('choices')
    expect(()=>validateResearchDesign(answer('--batch_size',['1.5']),command,parameters,4)).toThrow('整数')
  })
  it('rejects multiple changing variables and semantically identical candidates',()=>{
    const parameters=researchParameters(command,files)
    expect(()=>validateResearchDesign({...answer(),axes:[...answer().axes,{flag:'--batch_size',values:['16']}]},command,parameters,8)).toThrow()
    expect(()=>validateResearchDesign(answer('--lr',['1e-3']),command,parameters,4)).toThrow('只有基线')
  })
  it('returns missing information rather than inventing a design',()=>{
    expect(validateResearchDesign({axes:[],hypothesis:'',rationale:'',assumptions:['请说明比较指标']},command,[],4)).toMatchObject({axes:[],status:'needs_info'})
  })
  it('resolves entry/config paths inside the code directory',()=>{
    expect(researchReadPaths('python /repo/main.py --config=config/train.yaml','/repo')).toEqual({entry:'main.py',configs:['config/train.yaml']})
    expect(()=>researchReadPaths('python ../main.py','/repo')).toThrow('代码目录')
    expect(researchImports(file('from options import parser\nimport utils\n# import secret'))).toEqual(['options.py','utils.py'])
  })
})
