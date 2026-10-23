import { describe, expect, it } from 'vitest'
import { evidenceState, metricColumns, normalizeResultConfig, parseStructuredMetrics, processEvidenceState, resolveResultPath, resultConfigForRun, resultFileSelectionPath, resultConfigSchema } from './research-results'
import type { RunObservation } from './research'
const run={id:'run-1',remoteRunDir:'/runs/run-1',codePath:'/workspace/project'}
function observation():RunObservation{return {key:'seed=1',taskId:'task',runId:run.id,status:'completed',exitCode:0,evidenceId:'evidence',metrics:{},excerpt:''}}
describe('structured experiment result protocol',()=>{
  it('retains metadata, different train/validation values and explicit optimization direction',()=>{
    const parsed=parseStructuredMetrics(JSON.stringify({schemaVersion:1,runId:run.id,dataset:'vision-v1',epoch:10,metrics:[
      {name:'accuracy',value:0.7,split:'train',unit:'ratio',direction:'maximize'},
      {name:'accuracy',value:0.4,split:'validation',unit:'ratio',direction:'maximize'}]}),'/runs/run-1/metrics.json',run.id)
    expect(parsed.metrics.map(metric=>metric.split)).toEqual(['train','validation'])
    expect(parsed.metrics[1]).toMatchObject({value:0.4,dataset:'vision-v1',epoch:10,source:'metrics_json',sourcePath:'/runs/run-1/metrics.json'})
  })
  it('accepts simple numeric maps and explicitly provided rich map values',()=>{
    expect(parseStructuredMetrics('{"accuracy":0.42,"epoch":3}', '/result.json', run.id).metrics[0]).toMatchObject({name:'accuracy',value:0.42,epoch:3})
    expect(parseStructuredMetrics('{"metrics":{"loss":{"value":2.4,"direction":"minimize","unit":"dimensionless"}}}', '/result.json',run.id).metrics[0]).toMatchObject({name:'loss',value:2.4,direction:'minimize'})
  })
  it.each(['null','[]','{"metrics":{}}','{"metrics":{"loss":"0.4"}}','{"metrics":{"loss":1e999}}','{"schemaVersion":2,"metrics":{"loss":1}}'])('rejects malformed or nonfinite result data: %s',raw=>{
    expect(()=>parseStructuredMetrics(raw,'/results.json',run.id)).toThrow()
  })
  it('rejects another run and duplicate readings for the same declared context',()=>{
    expect(()=>parseStructuredMetrics('{"runId":"other","metrics":{"loss":1}}','/metrics.json',run.id)).toThrow('runId')
    expect(()=>parseStructuredMetrics('{"metrics":[{"name":"loss","value":1},{"name":"loss","value":2}]}','/metrics.json',run.id)).toThrow('重复')
  })
  it('never merges units, epochs, datasets, splits or sources into the same metric column',()=>{
    const base=parseStructuredMetrics('{"dataset":"v1","split":"validation","epoch":5,"unit":"ratio","metrics":{"accuracy":0.5}}','/metrics.json',run.id).metrics[0]
    const metrics=[base,{...base,unit:'percent'},{...base,epoch:6},{...base,dataset:'v2'},{...base,split:'train'},{...base,source:'log' as const}]
    expect(metricColumns([{...observation(),metricDetails:metrics}])).toHaveLength(6)
  })
  it('resolves only known placeholders and remote absolute or code-relative paths',()=>{
    expect(resolveResultPath('{runDir}/metrics.json',run)).toBe('/runs/run-1/metrics.json')
    expect(resolveResultPath('results/{runId}.json',run)).toBe('/workspace/project/results/run-1.json')
    expect(()=>resolveResultPath('{runDir}/metrics.json',{...run,remoteRunDir:undefined})).toThrow('运行目录')
    for(const path of ['../secrets.json','a/../b.json','/tmp/\nfile','{unknown}.json'])expect(()=>resolveResultPath(path,run)).toThrow()
    expect(()=>normalizeResultConfig({metricsFile:'',artifacts:['/x','/x']})).toThrow('重复')
  })
  it('treats poor metrics as observations, missing evidence independently and unknown exit codes honestly',()=>{
    const complete={...observation(),metricDetails:parseStructuredMetrics('{"metrics":{"accuracy":0.01}}','/metrics.json',run.id).metrics}
    expect(processEvidenceState(complete)).toBe('completed');expect(evidenceState(complete)).toBe('complete')
    expect(evidenceState({...complete,files:[{path:'/model.pt',role:'artifact',status:'missing'}]})).toBe('partial')
    expect(evidenceState({...complete,files:[{path:'/model.pt',role:'artifact',status:'available'}]})).toBe('partial')
    expect(processEvidenceState({...complete,exitCode:undefined})).toBe('unknown')
    expect(processEvidenceState({...complete,status:'failed'})).toBe('unknown')
    expect(processEvidenceState({...complete,exitCode:1})).toBe('failed')
  })
  it('supports old observations with only numeric metrics without claiming saved metadata',()=>{
    const old={...observation(),metrics:{val_loss:1.4}}
    expect(metricColumns([old])[0]).toMatchObject({name:'val_loss',value:1.4,source:'log',sourcePath:'历史日志（未保存文件来源）'})
  })
})

describe('per-run result file selection',()=>{
  it('uses relative paths from any isolated group without confusing directory prefixes',()=>{
    const roots=['/project/group-1','/project/group-2/']
    expect(resultFileSelectionPath('/project/group-2/log.txt',roots)).toBe('log.txt')
    expect(resultFileSelectionPath('/project/group-1/metrics/results.csv',roots)).toBe('metrics/results.csv')
    expect(resultFileSelectionPath('/project/group-20/log.txt',roots)).toBe('/project/group-20/log.txt')
    expect(resultFileSelectionPath('/external/log.txt',roots)).toBe('/external/log.txt')
    expect(resultFileSelectionPath('/project/group-2/log.txt',['/project/group-1'])).toBe('/project/group-2/log.txt')
  })
  it('applies an override to only its run, replacing rather than appending common files',()=>{
    const config={metricsFile:'',artifacts:[],resultFiles:['log.txt'],runResultFiles:{'run-2':['evaluation.csv','scores.json']}}
    expect(resultConfigForRun(config,'run-1').resultFiles).toEqual(['log.txt'])
    expect(resultConfigForRun(config,'run-2').resultFiles).toEqual(['evaluation.csv','scores.json'])
    expect(resultConfigForRun(config,'run-2')).not.toHaveProperty('runResultFiles')
    expect(config.resultFiles).toEqual(['log.txt'])
    expect(resolveResultPath(resultConfigForRun(config,'run-1').resultFiles![0],{id:'run-1',codePath:'/group-1'})).toBe('/group-1/log.txt')
    expect(resolveResultPath(resultConfigForRun(config,'run-2').resultFiles![0],{id:'run-2',codePath:'/group-2'})).toBe('/group-2/evaluation.csv')
  })
  it('allows independent selections without a common file, but rejects empty, duplicate and unsafe overrides',()=>{
    const config={metricsFile:'',artifacts:[],resultFiles:[],runResultFiles:{'run-1':['a.log'],'run-2':['b.csv']}}
    expect(resultConfigSchema.safeParse(config).success).toBe(true)
    for(const files of [[],['a.log','a.log'],['../other.log'],Array.from({length:9},(_,i)=>`${i}.log`)]){
      expect(resultConfigSchema.safeParse({...config,runResultFiles:{'run-1':files}}).success).toBe(false)
    }
  })
})
