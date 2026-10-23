import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { Client } from 'ssh2'
import type { SshService } from './ssh-service'
import type { ExperimentRun } from '../shared/types'
import type { RunObservation } from '../shared/research'
import { collectRunResults, RESULT_FILES_SCRIPT, researchModelEvidence } from './result-collector'
const run:ExperimentRun={id:'run-1',number:1,status:'completed',codePath:'/workspace',remoteRunDir:'/runs/run-1',logPath:'/runs/run-1/stdout.log',resultSummary:'',notes:''}
function observation():RunObservation{return {key:'seed=1',taskId:'task-1',runId:run.id,status:run.status,evidenceId:'run-run-1',metrics:{},excerpt:''}}
function metricFile(content=JSON.stringify({runId:run.id,dataset:'vision-v1',split:'validation',epoch:10,metrics:{accuracy:{value:0.01,unit:'ratio',direction:'maximize'}}})){
  return {path:'/runs/run-1/metrics.json',resolvedPath:'/runs/run-1/metrics.json',status:'available',kind:'file',sizeBytes:content.length,modifiedAt:'2026-10-15T01:00:00Z',content:Buffer.from(content).toString('base64')}
}
function mockSsh(files:unknown[]){return {exec:vi.fn(async(_client,command:string)=>command.includes('__LABDECK_RESULT_FILES__')?'__LABDECK_RESULT_FILES__'+JSON.stringify(files):command.includes('__LABDECK_EXIT__')?'__LABDECK_EXIT__0':'epoch=1 val_accuracy=0.99')} as unknown as SshService}
const config={metricsFile:'{runDir}/metrics.json',artifacts:[]}
describe('independent bounded result evidence collection',()=>{
  it('collects multiple arbitrary text result formats without imposing a JSON protocol',async()=>{
    const files=[{...metricFile(),path:'/runs/run-1/log.txt',resolvedPath:'/runs/run-1/log.txt',content:Buffer.from('epoch 5\nrecall=0.61').toString('base64')},{...metricFile(),path:'/runs/run-1/results.csv',resolvedPath:'/runs/run-1/results.csv',content:Buffer.from('metric,value\nndcg,0.42').toString('base64')}]
    const result=await collectRunResults(mockSsh(files),{} as Client,run,observation(),{metricsFile:'',artifacts:[],resultFiles:['{runDir}/log.txt','{runDir}/results.csv']})
    expect(result.files?.map(file=>file.role)).toEqual(['result','result'])
    expect(result.files?.[0].text).toContain('recall=0.61');expect(result.files?.[1].text).toContain('ndcg,0.42')
    expect(result.metricDetails).toEqual([]);expect(result.evidenceState).toBe('complete')
  })
  it('reports missing and binary files without substituting console metrics',async()=>{
    const files=[{path:'/runs/run-1/missing.log',status:'missing'},{...metricFile(),path:'/runs/run-1/model.bin',resolvedPath:'/runs/run-1/model.bin',content:Buffer.from([0,1,2,3]).toString('base64')}]
    const result=await collectRunResults(mockSsh(files),{} as Client,run,observation(),{metricsFile:'',artifacts:[],resultFiles:['{runDir}/missing.log','{runDir}/model.bin']})
    expect(result.files?.map(file=>file.status)).toEqual(['missing','invalid']);expect(result.metrics).toEqual({})
  })
  it('preserves truncation and strips terminal coloring from text files',async()=>{
    const text='\u001b[0;34mrecall=0.6\u001b[0m'
    const file={...metricFile(),path:'/runs/run-1/log.txt',resolvedPath:'/runs/run-1/log.txt',truncated:true,content:Buffer.from(text).toString('base64')}
    const result=await collectRunResults(mockSsh([file]),{} as Client,run,observation(),{metricsFile:'',artifacts:[],resultFiles:['{runDir}/log.txt']})
    expect(result.files?.[0]).toMatchObject({truncated:true,text:'recall=0.6',status:'available'})
  })
  it('budgets model text across all runs and all files rather than omitting later sources',()=>{
    const observations=Array.from({length:32},(_,i)=>({...observation(),runId:String(i),excerpt:'x'.repeat(16000),files:Array.from({length:8},(_,j)=>({path:String(j),role:'result' as const,status:'available' as const,text:'y'.repeat(20000)}))}))
    const bounded=researchModelEvidence(observations)
    const total=bounded.reduce((n,o)=>n+o.excerpt.length+(o.files??[]).reduce((sum,f)=>sum+(f.text?.length??0),0),0)
    expect(total).toBeLessThanOrEqual(100000);expect(bounded[31].files?.[7].text?.length).toBeGreaterThan(0);expect(bounded[0].files?.[0].truncated).toBe(true)
  })
  it('resolves a selected relative result path against this group output directory',async()=>{
    const outputDirectory='/repo/group-01'
    const file={...metricFile(),path:outputDirectory+'/log.txt',resolvedPath:outputDirectory+'/log.txt',content:Buffer.from('recall=0.6').toString('base64')}
    const ssh=mockSsh([file])
    const result=await collectRunResults(ssh,{} as Client,run,observation(),{metricsFile:'',artifacts:[],resultFiles:['log.txt']},outputDirectory)
    expect(result.files?.[0]).toMatchObject({path:outputDirectory+'/log.txt',association:'output_directory',text:'recall=0.6'})
    expect(result.evidenceState).toBe('complete')
  })
  it('uses the selected JSON file rather than a conflicting log reading',async()=>{
    const result=await collectRunResults(mockSsh([metricFile()]),{} as Client,run,observation(),config)
    expect(result.metrics.accuracy).toBe(0.01);expect(result.metrics.val_accuracy).toBeUndefined()
    expect(result.metricDetails?.[0]).toMatchObject({dataset:'vision-v1',split:'validation',epoch:10,unit:'ratio',direction:'maximize'})
    expect(result.files?.[0]).toMatchObject({association:'run_id',status:'available',sizeBytes:expect.any(Number)})
    expect(result.processState).toBe('completed');expect(result.evidenceState).toBe('complete')
  })
  it('reads JSON and exit code even when a log is missing or its read fails',async()=>{
    const ssh=mockSsh([metricFile()]);const original=ssh.exec
    ssh.exec=vi.fn(async(client,command,timeout)=>{if(command.includes('tail -n'))throw new Error('log unavailable');return original(client,command,timeout)})
    const result=await collectRunResults(ssh,{} as Client,run,observation(),config)
    expect(result.exitCode).toBe(0);expect(result.metrics.accuracy).toBe(0.01);expect(result.warning).toContain('log unavailable')
    const noLog=await collectRunResults(mockSsh([metricFile()]),{} as Client,{...run,logPath:undefined},observation(),config)
    expect(noLog.metrics.accuracy).toBe(0.01);expect(noLog.processState).toBe('completed')
  })
  it.each(['missing','too_large','unsupported','changed','unreadable'])('reports %s without falling back to log metrics or failing the process',async status=>{
    const result=await collectRunResults(mockSsh([{path:'/runs/run-1/metrics.json',status}]),{} as Client,run,observation(),config)
    expect(result.metricDetails).toEqual([]);expect(result.metrics).toEqual({});expect(result.processState).toBe('completed');expect(result.evidenceState).toBe('missing')
    expect(result.files?.[0].status).toBe(status)
  })
  it('does not display stale size or ownership metadata for a missing file',async()=>{
    const stale={...metricFile(),status:'missing'}
    const result=await collectRunResults(mockSsh([stale]),{} as Client,run,observation(),config)
    expect(result.files?.[0]).not.toHaveProperty('sizeBytes')
    expect(result.files?.[0]).not.toHaveProperty('modifiedAt')
    expect(result.files?.[0].association).toBeUndefined()
    expect(result.metrics).toEqual({})
  })
  it('rejects malformed JSON and another run ID while preserving process evidence',async()=>{
    for(const content of ['not-json',JSON.stringify({runId:'other-run',metrics:{accuracy:0.9}})]){
      const result=await collectRunResults(mockSsh([metricFile(content)]),{} as Client,run,observation(),config)
      expect(result.files?.[0].status).toBe('invalid');expect(result.metrics).toEqual({});expect(result.exitCode).toBe(0)
    }
  })
  it('checks artifact existence and metadata without requesting its content',async()=>{
    const ssh=mockSsh([metricFile(),{path:'/runs/run-1/model.pt',resolvedPath:'/runs/run-1/model.pt',status:'available',kind:'file',sizeBytes:12345,modifiedAt:'2026-10-15T01:00:00Z'}])
    const result=await collectRunResults(ssh,{} as Client,run,observation(),{...config,artifacts:['{runDir}/model.pt']})
    expect(result.files?.[1]).toMatchObject({role:'artifact',sizeBytes:12345,association:'run_directory'})
    expect(result.evidenceState).toBe('complete')
    expect(vi.mocked(ssh.exec).mock.calls.find(call=>call[1].includes('__LABDECK_RESULT_FILES__'))?.[1]).toContain('"metrics":false')
  })
  it('retains metrics with incomplete artifacts as partial evidence, not a failed experiment',async()=>{
    const result=await collectRunResults(mockSsh([metricFile(),{path:'/runs/run-1/model.pt',status:'missing'}]),{} as Client,run,observation(),{...config,artifacts:['{runDir}/model.pt']})
    expect(result.metrics.accuracy).toBe(0.01);expect(result.evidenceState).toBe('partial');expect(result.processState).toBe('completed')
  })
  it('does not conceal an unknown exit code behind valid metrics',async()=>{
    const ssh=mockSsh([metricFile()]);const original=ssh.exec
    ssh.exec=vi.fn(async(client,command,timeout)=>command.includes('__LABDECK_EXIT__')?'':original(client,command,timeout))
    const result=await collectRunResults(ssh,{} as Client,run,observation(),config)
    expect(result.processState).toBe('unknown');expect(result.evidenceState).toBe('partial');expect(result.metrics.accuracy).toBe(0.01)
  })
  it('records stale or unbound files without claiming they belong to this run',async()=>{
    const file=metricFile('{"metrics":{"accuracy":0.9}}');file.path=file.resolvedPath='/shared/metrics.json'
    const result=await collectRunResults(mockSsh([file]),{} as Client,{...run,startedAt:'2026-10-15T02:00:00Z'},observation(),{metricsFile:'/shared/metrics.json',artifacts:[]})
    expect(result.files?.[0].association).toBe('unverified');expect(result.evidenceState).toBe('partial');expect(result.warning).toContain('旧文件')
  })
  it('handles unavailable remote Python without losing exit-code and log evidence',async()=>{
    const ssh=mockSsh([]);const original=ssh.exec
    ssh.exec=vi.fn(async(client,command,timeout)=>{if(command.includes('__LABDECK_RESULT_FILES__'))throw new Error('python unavailable');return original(client,command,timeout)})
    const result=await collectRunResults(ssh,{} as Client,run,observation(),config)
    expect(result.files?.[0].status).toBe('unreadable');expect(result.processState).toBe('completed');expect(result.metrics).toEqual({})
  })
})
const python=process.env.LABDECK_TEST_PYTHON??'python'
const pythonAvailable=spawnSync(python,['--version'],{timeout:3000,windowsHide:true}).status===0
describe.skipIf(!pythonAvailable)('actual read-only Python file reader (optional local Python)',()=>{
  it('reads the tail of every large text file within the shared byte budget',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'labdeck-result-text-'))
    try{
      const requests=[]
      for(let i=0;i<8;i++){const path=join(directory,`result-${i}.txt`);await writeFile(path,'x'.repeat(150000)+`\nfinal_score=${i}`);requests.push({path,metrics:false,text:true})}
      const result=spawnSync(python,['-I','-c',RESULT_FILES_SCRIPT,JSON.stringify(requests)],{encoding:'utf8',timeout:10000,windowsHide:true,maxBuffer:500000})
      expect(result.status,result.stderr).toBe(0)
      const files=JSON.parse(result.stdout.slice('__LABDECK_RESULT_FILES__'.length)) as {status:string;content:string;truncated:boolean}[]
      expect(files).toHaveLength(8)
      expect(files.every(file=>file.status==='available'&&file.truncated)).toBe(true)
      expect(files.reduce((n,file)=>n+Buffer.from(file.content,'base64').length,0)).toBeLessThanOrEqual(262144)
      expect(Buffer.from(files[7].content,'base64').toString()).toContain('final_score=7')
    }finally{const target=resolve(directory),parent=resolve(tmpdir());if(!target.startsWith(parent+sep))throw new Error('Unsafe test cleanup path');await rm(target,{recursive:true,force:true})}
  })
  it('bounds JSON reads, handles missing paths and directories, and never opens a checkpoint for content',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'labdeck-result-reader-'))
    try{
      const good=join(directory,"metrics '测试'.json"),big=join(directory,'big.json'),artifact=join(directory,'model.pt'),folder=join(directory,'output')
      await writeFile(good,'{"metrics":{"accuracy":0.1}}');await writeFile(big,'x'.repeat(131073));await writeFile(artifact,Buffer.from([0,255,17]));await mkdir(folder)
      const before=await readFile(artifact)
      const requests=[{path:good,metrics:true},{path:big,metrics:true},{path:join(directory,'absent'),metrics:true},{path:artifact,metrics:false},{path:folder,metrics:false}]
      const result=spawnSync(python,['-I','-c',RESULT_FILES_SCRIPT,JSON.stringify(requests)],{encoding:'utf8',timeout:10000,windowsHide:true})
      expect(result.status,result.stderr).toBe(0)
      const files=JSON.parse(result.stdout.slice('__LABDECK_RESULT_FILES__'.length))
      expect(files.map((file:{status:string})=>file.status)).toEqual(['available','too_large','missing','available','available'])
      expect(Buffer.from(files[0].content,'base64').toString()).toContain('accuracy');expect(files[3].content).toBeUndefined()
      expect(await readFile(artifact)).toEqual(before);expect(files[4].kind).toBe('directory')
    }finally{
      const target=resolve(directory),parent=resolve(tmpdir())
      if(!target.startsWith(parent+sep))throw new Error('Unsafe test cleanup path')
      await rm(target,{recursive:true,force:true})
    }
  })
})