const {app, BrowserWindow, ipcMain}=require('electron')
const fs=require('node:fs/promises'), path=require('node:path'), {randomUUID}=require('node:crypto'), {pathToFileURL}=require('node:url'), esbuild=require('esbuild')
const root=path.resolve(__dirname,'..'), testData=path.resolve(root,'artifacts/workflow-ui-check')
app.getAppPath=()=>root
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('labdeck-headless-check','workflow')
const errors=[], calls={diagnose:0,retry:0,verify:0,tracking:0,plan:0,save:0,other:0,ssh:0}
const delay=ms=>new Promise(r=>setTimeout(r,ms))
app.on('browser-window-created',(_e,win)=>win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)}))
async function main(){
 if(!testData.startsWith(root+path.sep))throw new Error('Unsafe test path')
 await fs.rm(testData,{recursive:true,force:true})
 const bundle=path.join(root,'artifacts/workflow-service-test.cjs')
 esbuild.buildSync({entryPoints:[path.join(root,'src/main/intelligence-service.ts')],outfile:bundle,bundle:true,platform:'node',format:'cjs',packages:'external',target:'node22'})
 await import(pathToFileURL(path.join(root,'out/main/index.js')).href)
 let win
 for(let i=0;i<160;i++){win=BrowserWindow.getAllWindows()[0];if(win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript('!!document.querySelector(".experiment-pool-page")'))break;await delay(100)}
 if(!win||app.getPath('userData')!==testData)throw new Error('Isolated window missing')
 const run=code=>win.webContents.executeJavaScript(code)
 const waitFor=async code=>{for(let i=0;i<160;i++){if(await run(code))return;await delay(80)}throw new Error('Timed out: '+code)}
 const click=async(label,scope='body')=>{if(!await run(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`))throw new Error('Button unavailable: '+label)}
 const capture=async name=>{await delay(350);await fs.mkdir(path.join(root,'artifacts/task-diagnosis'),{recursive:true});await fs.writeFile(path.join(root,'artifacts/task-diagnosis',name+'.png'),(await win.webContents.capturePage()).toPNG())}
 const handle=(channel,fn)=>{ipcMain.removeHandler(channel);ipcMain.handle(channel,(_e,...args)=>fn(...args))}
 const now=new Date().toISOString(), serverId=randomUUID(), taskId=randomUUID(), originalRun=randomUUID(), secondRun=randomUUID()
 const server={id:serverId,name:'联动测试节点',host:'192.0.2.1',port:22,username:'user',authType:'password',hostFingerprint:'SHA256:fixture',mode:'real',monitorPolicy:'manual',hasSecret:false,tags:[],group:'测试',createdAt:now,updatedAt:now}
 const fixture={id:taskId,title:'SASRec · 失败实验',project:'测试',objective:'训练视觉模型',tags:[],priority:'normal',status:'failed',serverId,codePath:'/workspace/custom',dataPath:'/datasets/demo',launchCommand:'python train.py --batch-size 32',condaEnvironment:{manager:'conda',environmentName:'custom-env'},artifactPath:'',notes:'',resultSummary:'',archived:false,createdAt:now,updatedAt:now,runs:[{id:originalRun,number:1,status:'failed',serverId,accessRouteId:'direct',codePath:'/workspace/custom',launchCommand:'python train.py --batch-size 32',logPath:'/workspace/first/log.txt',resultSummary:'',notes:''},{id:secondRun,number:2,status:'failed',serverId,accessRouteId:'direct',codePath:'/workspace/custom',launchCommand:'python train.py --batch-size 16',logPath:'/workspace/second/log.txt',resultSummary:'',notes:''}]}
 const tasks=[fixture], store={startExperimentRun:async(id,input)=>{const task=tasks.find(item=>item.id===id);task.runs.push({...input,id:randomUUID(),number:task.runs.length+1,status:'queued',resultSummary:''});task.status='queued';win.webContents.send('experiments:changed');return structuredClone(task)},listExperimentTasks:()=>structuredClone(tasks),getServer:()=>server,getSecrets:()=>({})}
 const ssh={connect:async()=>{calls.ssh++;return {client:{end(){}}}},exec:async()=>{calls.ssh++;return 'torch.OutOfMemoryError: CUDA out of memory.'}}
 const monitor={snapshot:async()=>({status:'online',sampledAt:now,gpus:[]})}
 const {IntelligenceService}=require(bundle)
 const service=new IntelligenceService(store,ssh,monitor,{},()=>win.webContents.send('intelligence:changed'))
 for(const c of ['settings','saveSettings','testModel','diagnose','cancel','history','tracking','plan','retry','verify','export'])ipcMain.removeHandler('intelligence:'+c)
 ;['intelligence:settings', 'intelligence:saveSettings', 'intelligence:testModel', 'intelligence:task-diagnose', 'intelligence:preparation-create', 'intelligence:preparation-get', 'intelligence:preparation-list', 'intelligence:preparation-action', 'intelligence:preparation-cancel', 'intelligence:diagnose', 'intelligence:cancel', 'intelligence:history', 'intelligence:external-draft', 'intelligence:tracking', 'intelligence:detectReadme', 'intelligence:repository-workflows', 'intelligence:repository-create', 'intelligence:repository-cancel', 'intelligence:repository-action', 'intelligence:repository-inspect', 'intelligence:repository-discover', 'intelligence:repository-browse', 'intelligence:repository-analyze', 'intelligence:project-prepare', 'intelligence:project-cancel', 'intelligence:plan', 'intelligence:retry', 'intelligence:verify', 'intelligence:export'].forEach(channel=>ipcMain.removeHandler(channel))
 service.registerIpc(()=>{})
 handle('intelligence:settings',()=>({enabled:true,endpoint:'https://fixture.invalid',model:'UI fixture',hasApiKey:false}))
 handle('intelligence:diagnose',async input=>{calls.diagnose++;return service.diagnose(input)})
 handle('intelligence:retry',async(id,confirmed,useModel)=>{calls.retry++;return service.retry(id,confirmed,useModel)})
 handle('intelligence:task-diagnose',async input=>{calls.diagnose++;return service.diagnoseTask(input,progress=>win.webContents.send('intelligence:progress',progress))})
 handle('servers:list',()=>[server]);handle('experiments:list',()=>structuredClone(tasks))
 handle('monitor:snapshot',()=>({serverId,status:'offline',error:'mock node',gpus:[],fileSystems:[],sampledAt:now,latencyMs:null,uptimeSeconds:null,loadAverage:null,cpuUsagePercent:null,memoryUsedBytes:null,memoryTotalBytes:null}))

 handle('experiments:listCondaEnvironments',()=>({status:'success',value:{managerPath:'/opt/conda/bin/conda',environments:[{name:'custom-env',prefix:'/opt/conda/envs/custom-env'}]}}))
 win.webContents.reload();await waitFor('!!document.querySelector(".experiment-pool-page")')
 await click('实验任务','.workbench-modulebar');await waitFor('!!document.querySelector(".experiment-pool-table")')
 await click('详情','.experiment-pool-table')
 await click('分析失败原因','.experiment-task-actions')
 await waitFor('!!document.querySelector(".task-diagnosis-result")')
 if(calls.diagnose!==1)throw new Error('Analysis did not start exactly once')
 if(await run('document.querySelectorAll(".task-diagnosis input[type=checkbox]").length'))throw new Error('Old checkboxes remain')
 if(!await run('document.querySelector(".task-diagnosis-header").textContent.includes("第 2 次运行")'))throw new Error('Wrong run selected')
 if(!await run(`document.querySelector('.task-diagnosis-repair').textContent.includes('--batch-size 8')`))throw new Error('Wrong repair candidate')
 if(await run('document.querySelector(".task-diagnosis-details").open'))throw new Error('Details not collapsed')
 if(!await run(`document.querySelector('.workbench-modulebar .active').textContent.includes('实验任务')`))throw new Error('Navigated away')
 await click('收起','.task-diagnosis');await click('分析失败原因','.experiment-task-actions')
 await waitFor('!!document.querySelector(".task-diagnosis-result")')
 if(calls.diagnose!==1)throw new Error('Reopening existing result unexpectedly reanalyzed')
 await click('重新分析','.task-diagnosis');await waitFor('!!document.querySelector(".task-diagnosis-actions")&&'+ 'true')
 if(calls.diagnose!==2)throw new Error('Explicit reanalysis did not occur')
 await click('确认修改并重新运行','.task-diagnosis');await waitFor('!!document.querySelector(".confirm-dialog")');await click('取消','.confirm-dialog')
 if(calls.retry!==0)throw new Error('Cancel still triggered a run')
 await run(`document.querySelector('.task-diagnosis').scrollIntoView({block:'start'})`)
 await capture('task-diagnosis-dark');await run('document.documentElement.dataset.theme="instrument"');await capture('task-diagnosis-light')
 if(await run('document.querySelector(".workbench-page").scrollWidth>document.querySelector(".workbench-page").clientWidth'))throw new Error('Horizontal overflow')
 await click('编辑任务配置','.task-diagnosis');await waitFor('!!document.querySelector(".experiment-editor")');await run(`document.querySelector('.experiment-editor [aria-label="关闭"]').click()`)
 await click('确认修改并重新运行','.task-diagnosis');await waitFor('!!document.querySelector(".confirm-dialog")');await click('确认重新运行','.confirm-dialog')
 await waitFor('!!document.querySelector(".task-diagnosis .intel-closure")')
 if(calls.retry!==1||tasks[0].runs.length!==3)throw new Error('Repair did not create exactly one run')
 if(tasks[0].runs[2].launchCommand!=='python train.py --batch-size 8')throw new Error('Incorrect repair command')
 await click('查看运行记录','.experiment-task-card-footer')
 await click('分析第 1 次运行','.experiment-run-history')
 await waitFor('!!document.querySelector(".task-diagnosis-result")&&document.querySelector(".task-diagnosis-header").textContent.includes("第 1 次运行")')
 if(!await run(`document.querySelector('.task-diagnosis-repair').textContent.includes('--batch-size 16')`))throw new Error('Selecting earlier run reused a different report')
 service.stopTracking()
 if(errors.length)throw new Error(errors.join('\n'))
 console.log(JSON.stringify({status:'passed',mockSSH:true,realModel:false,checks:['startup','automatic analysis once','no engine checkboxes','exact-run results','collapsed details','reuse on reopen','explicit reanalysis','cancel repair','confirmed repair tracked','edit configuration','earlier run isolation','dark/light layout'],calls},null,2))
 app.exit(0)
}
setTimeout(()=>{console.error('Task diagnosis check timed out');app.exit(1)},60000).unref()
main().catch(error=>{console.error(error);app.exit(1)})
