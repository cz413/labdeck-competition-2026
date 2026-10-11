import { describe, expect, it, vi } from 'vitest'
import { DiagnosticTools, allowedDiagnosticPaths, allowedDiagnosticPackages } from './diagnostic-tools'
import type { DiagnosticToolCall, Evidence } from '../shared/intelligence'
import type { ExperimentTask, ExperimentRun } from '../shared/types'
import type { AppStore } from './store'
import type { SshService } from './ssh-service'
import type { MonitorService } from './monitor-service'
import type { CondaService } from './conda-service'
const signal=()=>new AbortController().signal
const call=(tool:DiagnosticToolCall['tool'],args:Record<string,string>={}):DiagnosticToolCall=>({tool,arguments:args,reason:'核对',evidenceIds:['log-1']})
function setup(remote=true){
 const evidence:Evidence[]=[{id:'log-1',source:'log',label:'log',line:1,text:`FileNotFoundError: '/datasets/flowers'`},{id:'log-2',source:'log',label:'log',line:2,text:`ModuleNotFoundError: No module named 'custompkg.layer'`}]
 const task={codePath:'/workspace/vision',dataPath:'/datasets',serverId:'server',accessRouteId:'direct',condaEnvironment:{environmentName:'vision',managerPath:'/opt/conda/bin/conda'}} as ExperimentTask
 const run={serverId:'server',accessRouteId:'direct',logPath:'/runs/log.txt'} as ExperimentRun
 const profile={id:'server',host:'192.0.2.1',port:22,username:'user',mode:'real',hostFingerprint:'SHA256:trusted'}
 const store={getServer:vi.fn(()=>profile),getSecrets:vi.fn(()=>({}))}
 const end=vi.fn();const ssh={connect:vi.fn(async()=>({client:{end}})),exec:vi.fn(async(_client:unknown,_command:string)=> 'exists=yes kind=directory readable=yes')}
 const monitor={snapshot:vi.fn(async()=>({status:'online',sampledAt:'2026-10-09T10:00:00Z',gpus:[{index:0,name:'GPU',memoryTotalMiB:24000,memoryUsedMiB:1000,utilizationPercent:1,temperatureC:40,processes:[]}]}))}
 const conda={checkEnvironment:vi.fn(async()=>({found:true,managerPath:'/opt/conda/bin/conda',pythonInterpreterPath:'/opt/conda/envs/vision/bin/python'})),buildEnvironmentRunCommand:vi.fn((_env,cmd:string)=>`conda run -n vision ${cmd}`)}
 const tools=new DiagnosticTools(evidence,remote?task:undefined,remote?run:undefined,store as unknown as AppStore,ssh as unknown as SshService,monitor as unknown as MonitorService,conda as unknown as CondaService)
 return {tools,evidence,task,run,profile,store,ssh,monitor,conda,end}
}
describe('scoped read-only diagnostic tools',()=>{
 it('allows only log search when no remote run is selected',async()=>{
  const s=setup(false);expect(s.tools.catalog.map(t=>t.name)).toEqual(['search_log'])
  const search=await s.tools.execute(call('search_log',{query:'CUSTOMPKG'}),signal());expect(search.text).toContain('log-2')
  expect((await s.tools.execute(call('inspect_gpu'),signal())).status).toBe('unavailable');expect(s.ssh.connect).not.toHaveBeenCalled()
 })
 it('restricts checks to exact recorded paths, not model-invented paths or commands',async()=>{
  const s=setup();expect(s.tools.context.allowedPaths).toContain('/datasets/flowers')
  for(const path of ['/etc/passwd','/datasets/../etc/passwd','/datasets; touch /tmp/x'])expect((await s.tools.execute(call('inspect_path',{path}),signal())).status).toBe('unavailable')
  expect(s.ssh.exec).not.toHaveBeenCalled()
  expect((await s.tools.execute(call('inspect_path',{path:'/datasets/flowers'}),signal())).status).toBe('success')
  const command=s.ssh.exec.mock.calls[0][1];expect(command).toContain("p='/datasets/flowers'");expect(command).toContain('[ -e')
  expect(s.end).toHaveBeenCalledOnce()
 })
 it('rejects traversal and root paths when constructing the permitted path scope',()=>{
  const s=setup();expect(allowedDiagnosticPaths(s.task,s.run,`'/etc/../passwd' '/' '/valid'`)).toContain('/valid')
  expect(allowedDiagnosticPaths(s.task,s.run,`'/etc/../passwd' '/'`)).not.toContain('/etc/../passwd')
 })
 it('only reads named dependency files and uses containment checks for symlinks',async()=>{
  const s=setup();expect((await s.tools.execute(call('read_project_file',{name:'../../secrets'}),signal())).status).toBe('unavailable')
  expect(s.ssh.exec).not.toHaveBeenCalled()
  await s.tools.execute(call('read_project_file',{name:'requirements.txt'}),signal())
  const command=s.ssh.exec.mock.calls[0][1];expect(command).toContain('realpath -e');expect(command).toContain('case "$file"');expect(command).toContain('"$root"/*');expect(command).toContain('head -c 12288')
 })
 it('checks package discovery in the recorded environment without importing or installing the package',async()=>{
  const s=setup();expect(allowedDiagnosticPackages(s.evidence[1].text)).toContain('custompkg')
  expect((await s.tools.execute(call('inspect_package',{name:'invented'}),signal())).status).toBe('unavailable')
  await s.tools.execute(call('inspect_package',{name:'custompkg'}),signal())
  expect(s.conda.checkEnvironment).toHaveBeenCalledOnce();const command=s.ssh.exec.mock.calls[0][1]
  expect(command).toContain('find_spec');expect(command).toContain('metadata');expect(command).not.toContain('pip install');expect(command).not.toContain('__import__')
 })
 it('does not guess a Conda environment that was not recorded',async()=>{
  const s=setup();delete s.task.condaEnvironment
  expect((await s.tools.execute(call('inspect_environment'),signal())).status).toBe('unavailable')
  await expect(s.tools.execute(call('inspect_package',{name:'torch'}),signal())).rejects.toThrow('没有记录 Conda')
  expect(s.conda.checkEnvironment).not.toHaveBeenCalled()
 })
 it('preserves GPU collection time and distinguishes offline checks',async()=>{
  const s=setup();const result=await s.tools.execute(call('inspect_gpu'),signal())
  expect(JSON.parse(result.text)).toMatchObject({sampledAt:'2026-10-09T10:00:00Z',gpus:[{freeMiB:23000,processCount:0}]})
  s.profile.mode='demo';await expect(s.tools.execute(call('inspect_gpu'),signal())).rejects.toThrow('演示节点')
 })
 it('requires a trusted SSH profile for every remote inspection',async()=>{
  const s=setup();s.profile.hostFingerprint=''
  await expect(s.tools.execute(call('inspect_path',{path:'/workspace/vision'}),signal())).rejects.toThrow('主机指纹')
  expect(s.ssh.connect).not.toHaveBeenCalled()
 })
 it('bounds and redacts remote evidence',async()=>{
  const s=setup();s.ssh.exec.mockResolvedValue('api_key=private-secret-value\n'+'x'.repeat(15000))
  const result=await s.tools.execute(call('inspect_path',{path:'/workspace/vision'}),signal())
  expect(result.text.length).toBeLessThanOrEqual(12000);expect(result.text).not.toContain('private-secret-value')
 })
 it('does no work after cancellation',async()=>{
  const s=setup();await expect(s.tools.execute(call('inspect_gpu'),AbortSignal.abort())).rejects.toThrow();expect(s.monitor.snapshot).not.toHaveBeenCalled()
 })
})
