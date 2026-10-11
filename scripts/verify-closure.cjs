const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const esbuild = require('esbuild')
const root=path.resolve(__dirname,'..')
app.getAppPath=()=>root
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('labdeck-headless-check','closure')
const delay=ms=>new Promise(r=>setTimeout(r,ms))
const errors=[]
app.on('browser-window-created',(_e,win)=>win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)}))
const channels=['settings','saveSettings','testModel','diagnose','cancel','history','tracking','plan','retry','verify','export']
function clearHandlers(){channels.forEach(c=>ipcMain.removeHandler('intelligence:'+c))}
async function main(){
 const testData=path.resolve(root,'artifacts','closure-ui-check')
 if(!testData.startsWith(root+path.sep))throw new Error('Unsafe test path')
 await fs.rm(testData,{recursive:true,force:true})
 const bundle=path.join(root,'artifacts','closure-service-test.cjs')
 esbuild.buildSync({entryPoints:[path.join(root,'src/main/intelligence-service.ts')],outfile:bundle,bundle:true,platform:'node',format:'cjs',packages:'external',target:'node22'})
 await import(pathToFileURL(path.join(root,'out/main/index.js')).href)
 let win
 for(let i=0;i<150;i++){win=BrowserWindow.getAllWindows()[0];if(win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript('!!document.querySelector(".intel-page")'))break;await delay(100)}
 if(!win)throw new Error('Window missing')
 if(app.getPath('userData')!==testData)throw new Error('Test data isolation failed')
 const run=code=>win.webContents.executeJavaScript(code)
 const waitFor=async(code)=>{for(let i=0;i<180;i++){if(await run(code))return;await delay(100)}throw new Error('Timed out: '+code)}
 const click=async(label,scope='.intel-page')=>{
  const ok=await run(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`)
  if(!ok)throw new Error('Button unavailable: '+label)
 }
 const capture=async(name)=>{await delay(180);await fs.mkdir(path.join(root,'docs/screenshots'),{recursive:true});await fs.writeFile(path.join(root,'docs/screenshots',name+'.png'),(await win.webContents.capturePage()).toPNG())}
 const taskId=randomUUID(),serverId=randomUUID(),runId=randomUUID()
 const profile={id:serverId,name:'模拟 SSH 联调节点',host:'192.0.2.1',port:22,username:'user',authType:'password',hostFingerprint:'SHA256:trusted-test',mode:'real',tags:[],group:'联调',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}
 const task={id:taskId,title:'闭环联调实验',project:'UI 验证',objective:'',tags:[],priority:'normal',status:'failed',serverId,accessRouteId:'direct',codePath:'/workspace/vision',dataPath:'',launchCommand:'python train.py --batch-size 32',artifactPath:'',resultSummary:'',notes:'',archived:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),runs:[{id:runId,number:1,status:'failed',serverId,accessRouteId:'direct',codePath:'/workspace/vision',launchCommand:'python train.py --batch-size 32',launchMode:'command',logPath:'/workspace/original/log.txt',resultSummary:'',notes:''}]}
 let starts=0
 const store={listExperimentTasks:()=>[structuredClone(task)],getServer:()=>profile,getSecrets:()=>({}),startExperimentRun:async(_id,input)=>{starts++;task.runs.push({...input,id:randomUUID(),number:task.runs.length+1,status:'queued',resultSummary:''});return structuredClone(task)}}
 const ssh={connect:async()=>({client:{end(){}}}),exec:async(_client,command)=>{
  if(command.includes('__LABDECK_EXIT__')){const selected=task.runs.find(r=>r.remoteRunDir&&command.includes(r.remoteRunDir));return selected?.number===3?'__LABDECK_EXIT__1':'__LABDECK_EXIT__0'}
  return 'Epoch 1\nTraceback (most recent call last):\ntorch.OutOfMemoryError: CUDA out of memory.'
 }}
 const monitor={snapshot:async()=>({status:'online',sampledAt:new Date().toISOString(),gpus:[]})}
 const {IntelligenceService}=require(bundle)
 let service
 const install=async()=>{clearHandlers();service=new IntelligenceService(store,ssh,monitor,{},()=>{if(!win.isDestroyed())win.webContents.send('intelligence:changed')});service.registerIpc(()=>service.wakeTracking());await service.startTracking()}
 await install()
 const createDiagnosis=async()=>run(`window.labApi.intelligence.diagnose({taskId:${JSON.stringify(taskId)},runId:${JSON.stringify(runId)},useModel:false})`)
 const selectLatest=async()=>{await waitFor('!!document.querySelector(".intel-history button")');await run('document.querySelector(".intel-history button").click()');await waitFor('!!document.querySelector(".intel-repair")')}
 const first=await createDiagnosis();await selectLatest()
 const rejected=await run(`window.labApi.intelligence.retry(${JSON.stringify(first.id)},false).then(()=>false,e=>e.message.includes('明确确认'))`)
 if(!rejected||starts!==0)throw new Error('Repair approval was bypassed')
 await click('审查并创建修复运行');await waitFor('!!document.querySelector(".confirm-dialog")')
 await click('确认加入队列','.confirm-dialog');await waitFor('!!document.querySelector(".intel-closure")')
 await click('闭环跟踪');await waitFor('document.querySelector(".intel-closure-list").textContent.includes("等待资源")');await capture('closure-waiting')
 await click('查看验收');task.runs[1].status='running';service.wakeTracking()
 await waitFor('document.querySelector(".intel-closure-status").textContent.includes("修复运行中")')
 await click('暂停跟踪');await waitFor('document.querySelector(".intel-closure-status").textContent.includes("跟踪已暂停")')
 if(task.runs[1].status!=='running')throw new Error('Pausing tracking mutated the remote run')
 await click('继续跟踪');await waitFor('document.querySelector(".intel-closure-status").textContent.includes("修复运行中")')
 task.runs[1].status='completed';task.runs[1].remoteRunDir='/workspace/closure-run-2';service.wakeTracking()
 await waitFor('document.querySelector(".intel-closure-status").textContent.includes("进程验收通过")')
 await run('document.querySelector(".intel-closure").scrollIntoView({block:"center"})');await capture('closure-passed')
 const passed=(await service.history()).find(r=>r.id===first.id)
 if(passed.closure.exitCode!==0||passed.closure.enabled)throw new Error('Exit verification not persisted')
 const second=await createDiagnosis();await selectLatest();await click('审查并创建修复运行');await waitFor('!!document.querySelector(".confirm-dialog")');await click('确认加入队列','.confirm-dialog')
 await waitFor('!!document.querySelector(".intel-closure")')
 task.runs[2].status='failed';task.runs[2].remoteRunDir='/workspace/closure-run-3';task.runs[2].logPath='/workspace/retry/log.txt';service.wakeTracking()
 await waitFor('document.querySelector(".intel-closure-status").textContent.includes("修复后仍失败")')
 const failed=(await service.history()).find(r=>r.id===second.id)
 if(failed.closure.exitCode!==1||!failed.closure.nextDiagnosisId||starts!==2)throw new Error('Failure closure or retry boundary failed')
 await click('查看新诊断');await waitFor('document.querySelector(".intel-command-diff").textContent.includes("--batch-size 8")')
 if(starts!==2)throw new Error('Unexpected automatic repair')
 const third=await createDiagnosis();await run(`window.labApi.intelligence.retry(${JSON.stringify(third.id)},true)`)
 service.stopTracking();task.runs[3].status='running';await install()
 const restored=(await service.history()).find(r=>r.id===third.id)
 if(restored.closure.status!=='running'||!restored.closure.enabled)throw new Error('Restart did not resume the workflow')
 await click('闭环跟踪');await waitFor('document.querySelectorAll(".intel-closure-row").length===3')
 await run('document.querySelector(".workbench-main").scrollTop=0');await capture('closure-overview-dark')
 const overflow=await run('document.querySelector(".workbench-main").scrollWidth>document.querySelector(".workbench-main").clientWidth')
 if(overflow)throw new Error('Closure page overflows')
 await run('document.documentElement.dataset.theme="instrument"');await capture('closure-overview-light')
 service.stopTracking()
 if(errors.length)throw new Error(errors.join('\n'))
 const verification={status:'passed',mockSSH:true,realModel:false,checks:['real Electron and preload/IPC','explicit repair approval','automatic waiting/running tracking','pause does not stop the remote run','resume tracking','exit 0 acceptance','nonzero exit and linked diagnosis','no automatic extra repair','startup continuation','persisted exit evidence','dark/light closure layout'],screenshots:4,testData}
 await fs.writeFile(path.join(root,'artifacts/closure-ui-verification.json'),JSON.stringify(verification,null,2)+'\n')
 console.log(JSON.stringify(verification,null,2));app.exit(0)
}
setTimeout(()=>{console.error('Closure UI check timed out');app.exit(1)},60_000).unref()
main().catch(error=>{console.error(error);app.exit(1)})
