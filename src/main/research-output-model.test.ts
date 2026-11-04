import { describe,it,expect,vi } from 'vitest'
import { analyzeResearchOutput,validateOutputAnalysis } from './research-output-model'
import type { ExperimentTaskDraft } from '../shared/types'
const text="parser.add_argument('--destination', default='results')\nwriter.persist(config.destination)"
const files=[{path:'app.py',startLine:10,text,truncated:false}]
const source={path:'app.py',startLine:10,quote:text}
const target={flag:'--destination',kind:'directory',originalValue:'results',template:'{value}',source,evidence:[source]}
const answer={status:'verified',reason:'沿调用链确认参数控制保存位置',targets:[target]}
describe('model output source analysis',()=>{
  it('accepts source-grounded custom parameter names without a naming whitelist',()=>{
    expect(validateOutputAnalysis(answer,files)).toMatchObject({status:'verified',flag:'--destination'})
  })
  it('corrects unique quotes with inaccurate model line numbers',()=>{
    expect(validateOutputAnalysis({...answer,targets:[{...target,source:{...source,startLine:1}}]},files).source?.startLine).toBe(10)
  })
  it('rejects invented quotes',()=>{
    expect(()=>validateOutputAnalysis({...answer,targets:[{...target,evidence:[{...source,quote:'made up'}]}]},files)).toThrow('引用')
  })
  it('extracts exact original source using numbered ranges and a project-relative path',()=>{
    const range={path:'/repo/app.py',startLine:11,endLine:11}
    const result=validateOutputAnalysis({...answer,targets:[{...target,source:range,evidence:[range]}]},files,'/repo')
    expect(result.source).toEqual({path:'app.py',startLine:11,quote:'writer.persist(config.destination)'})
  })
  it('does not guess a line range outside the supplied source or an ambiguous quote',()=>{
    const range={path:'app.py',startLine:1,endLine:2}
    expect(()=>validateOutputAnalysis({...answer,targets:[{...target,source:range}]},files)).toThrow('引用')
    const repeated=[{...files[0],text:'save()\nsave()'}]
    expect(()=>validateOutputAnalysis({...answer,targets:[{...target,source:{path:'app.py',startLine:1,quote:'save()'}}]},repeated)).toThrow('引用')
  })
  it('asks AI to correct a failed reference once using numbered source',async()=>{
    const request=vi.fn().mockResolvedValue(answer).mockResolvedValueOnce({...answer,targets:[{...target,source:{...source,path:'wrong.py'}}]}).mockResolvedValueOnce({...answer,targets:[{...target,source:{path:'app.py',startLine:10,endLine:11}}]})
    const result=await analyzeResearchOutput({} as ExperimentTaskDraft,files,[],request)
    expect(result.status).toBe('verified')
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls[0][1].files[0].numberedText).toContain('10: parser.add_argument')
    expect(request.mock.calls[1][1].correction).toContain('wrong.py')
  })
  it('resolves TIGER argument and save-operation ranges independently without copying noncontiguous quotes',()=>{
    const lines=Array.from({length:300},()=> '# project source')
    lines[207]="parser.add_argument('--log_path', type=str, default='./logs/tiger.log')"
    lines[209]="parser.add_argument('--save_path', type=str, default='./ckpt/tiger.pth')"
    lines[216]="    filename=config['log_path'],"
    lines[290]="    torch.save(model.state_dict(), config['save_path'])"
    const file={path:'model/main.py',startLine:1,text:lines.join('\n'),truncated:false}
    const ref=(line:number)=>({path:file.path,startLine:line,endLine:line})
    const result=validateOutputAnalysis({status:'verified',reason:'保存参数传递到权重写入和日志配置',targets:[{flag:'--save_path',kind:'file',template:'{value}',originalValue:'./ckpt/tiger.pth',source:ref(210),evidence:[ref(210),ref(291)]},{flag:'--log_path',kind:'file',template:'{value}',originalValue:'./logs/tiger.log',source:ref(208),evidence:[ref(208),ref(217)]}]},[file])
    expect(result.targets?.[0].evidence?.[1]).toEqual({path:file.path,startLine:291,quote:lines[290]})
  })
  it('asks AI to verify actual path transformations and uses its corrected dataset prefix',async()=>{
    const sourceText="folder = args.dataset + '_' + args.train_dir\nf = open(folder + '/log.txt', 'w')",ref={path:'main.py',startLine:1,endLine:2}
    const proposal={status:'verified',reason:'目录由数据集和 train_dir 拼接',targets:[{flag:'--train_dir',kind:'directory',originalValue:'default',template:'{value}',source:ref,evidence:[ref]}]}
    const corrected={...proposal,targets:[{...proposal.targets[0],template:'ml-1m_{value}'}]}
    const request=vi.fn().mockResolvedValueOnce(proposal).mockResolvedValueOnce(corrected)
    const result=await analyzeResearchOutput({launchCommand:'python main.py --dataset=ml-1m --train_dir=default',codePath:'/repo'} as ExperimentTaskDraft,[{path:'main.py',startLine:1,text:sourceText,truncated:false}],[],request)
    expect(result.template).toBe('ml-1m_{value}')
    expect(request.mock.calls[1][1].phase).toBe('verify_output_mapping')
  })
  it('rejects ambiguous targets and unsafe templates',()=>{
    expect(()=>validateOutputAnalysis({...answer,targets:[target,target]},files)).toThrow()
    expect(()=>validateOutputAnalysis({...answer,targets:[{...target,template:'../{value}'}]},files)).toThrow()
    expect(()=>validateOutputAnalysis({...answer,targets:[{...target,template:'fixed'}]},files)).toThrow()
  })
  it('supports direct log files and keeps genuine missing output controls unresolved',()=>{
    expect(validateOutputAnalysis({...answer,targets:[{...target,flag:'--journal',kind:'file',originalValue:'logs/run.txt'}]},files).targets?.[0].kind).toBe('file')
    expect(validateOutputAnalysis({status:'unverified',reason:'writer.py 中写死共享文件'},files)).toEqual({status:'unverified',reason:'writer.py 中写死共享文件'})
  })
  it('distinguishes source citation failures from model connection failures',async()=>{
    const request=vi.fn().mockResolvedValue({...answer,targets:[{...target,source:{...source,quote:'invented'}}]})
    const result=await analyzeResearchOutput({} as ExperimentTaskDraft,files,[],request)
    expect(result.reason).toContain('源码引用无法核对')
    expect(result.reason).not.toContain('模型连接')
  })
  it('reports malformed output and missing source separately',async()=>{
    const request=vi.fn().mockResolvedValue({status:'verified'})
    expect((await analyzeResearchOutput({} as ExperimentTaskDraft,files,[],request)).reason).toContain('格式不正确')
    request.mockClear()
    expect((await analyzeResearchOutput({} as ExperimentTaskDraft,[],[],request)).reason).toContain('尚未读取')
    expect(request).not.toHaveBeenCalled()
  })
  it('does not silently replace failed model analysis with static matching',async()=>{
    const request=vi.fn().mockRejectedValue(new Error('offline'))
    expect(await analyzeResearchOutput({} as ExperimentTaskDraft,files,[],request)).toMatchObject({status:'unverified'})
    expect(request).toHaveBeenCalledTimes(1)
  })
})
