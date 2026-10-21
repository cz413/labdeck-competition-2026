// Manual task creation remains the detailed editing path; smart creation has its own check.
const {app,BrowserWindow,ipcMain}=require('electron')
const fs=require('node:fs/promises'),path=require('node:path'),{pathToFileURL}=require('node:url'),{randomUUID}=require('node:crypto')
const root=path.resolve(__dirname,'..'),testData=path.join(root,'artifacts','task-creation-'+Date.now())
const setPath=app.setPath.bind(app);app.getAppPath=()=>root;app.setPath=(name,value)=>setPath(name,name==='userData'?testData:value)
app.disableHardwareAcceleration();app.commandLine.appendSwitch('labdeck-headless-check','task-creation')
const delay=ms=>new Promise(r=>setTimeout(r,ms)),calls={save:0,start:0},errors=[],tasks=[]
app.on('browser-window-created',(_e,w)=>w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)}))
async function main(){
  await fs.mkdir(testData,{recursive:true})
  await import(pathToFileURL(path.join(root,'out/main/index.js')).href)
  let win
  for(let i=0;i<150;i++){win=BrowserWindow.getAllWindows()[0];if(win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript('!!document.querySelector(".experiment-pool-page")'))break;await delay(100)}
  if(!win||app.getPath('userData')!==testData)throw new Error('Isolated application unavailable')
  win.setSize(1600,1000)
  const run=code=>win.webContents.executeJavaScript(code)
  const waitFor=async code=>{for(let i=0;i<160;i++){if(await run(code))return;await delay(60)}throw new Error('Timed out: '+code)}
  const click=async(label,scope='body')=>{await waitFor(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.trim()===${JSON.stringify(label)});return !!b&&!b.disabled})()`);await run(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.trim()===${JSON.stringify(label)});b.click()})()`)}
  const set=async(selector,value)=>run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLSelectElement?HTMLSelectElement.prototype:e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}))})()`)
  const setField=async(label,value)=>{const selector=await run(`(()=>{const labels=[...document.querySelectorAll('.experiment-editor label.field')];const e=labels.find(e=>e.querySelector(':scope>span')?.textContent===${JSON.stringify(label)})?.querySelector('input,textarea,select');if(!e)throw new Error('Missing field '+${JSON.stringify(label)});e.dataset.testField='active';return '[data-test-field=active]'})()`);await set(selector,value);await run('delete document.querySelector("[data-test-field=active]").dataset.testField')}
  const handle=(channel,fn)=>{ipcMain.removeHandler(channel);ipcMain.handle(channel,(_e,...args)=>fn(...args))}
  const serverId=randomUUID(),now=new Date().toISOString()
  const server={id:serverId,name:'手动任务验证节点',host:'192.0.2.8',port:22,username:'fixture',authType:'password',hostFingerprint:'SHA256:fixture',mode:'real',monitorPolicy:'manual',hasSecret:false,tags:[],group:'test',createdAt:now,updatedAt:now}
  handle('intelligence:settings',()=>({enabled:false,endpoint:'http://127.0.0.1:1/v1',model:'fixture',hasApiKey:false}))
  handle('servers:list',()=>[server]);handle('experiments:list',()=>structuredClone(tasks));handle('monitor:cachedSnapshots',()=>({}));handle('intelligence:history',()=>[])
  handle('research:list',()=>[]);handle('research:engine',()=>({available:false,message:'fixture'}))
  handle('monitor:snapshot',()=>({serverId,status:'online',gpus:[{index:0,uuid:'GPU-fixture',name:'NVIDIA Fixture',memoryTotalMiB:24576,memoryUsedMiB:1024,utilizationPercent:5,temperatureCelsius:40,processes:[]}],fileSystems:[],sampledAt:now,latencyMs:null,uptimeSeconds:null,loadAverage:null,cpuUsagePercent:null,memoryUsedBytes:null,memoryTotalBytes:null}))
  handle('experiments:listCondaEnvironments',()=>({status:'success',value:{environments:[]}}))
  handle('experiments:save',draft=>{calls.save++;const existing=tasks.find(t=>t.id===draft.id),task={...draft,id:draft.id||randomUUID(),runs:existing?.runs||[],archived:false,createdAt:existing?.createdAt||now,updatedAt:now};if(existing)tasks.splice(tasks.indexOf(existing),1,task);else tasks.push(task);win.webContents.send('experiments:changed');return structuredClone(task)})
  handle('experiments:startRun',()=>{calls.start++;throw new Error('Unexpected execution')})
  win.webContents.reload();await waitFor('!!document.querySelector(".experiment-pool-page")')
  if(await run('[...document.querySelectorAll(".workbench-modulebar button")].some(b=>b.textContent.includes("智能实验"))'))throw new Error('Standalone intelligence navigation remains')
  if(!await run('[...document.querySelectorAll(".experiment-task-toolbar button")].some(b=>b.textContent.trim()==="智能创建")'))throw new Error('Smart create entry missing')
  await click('手动创建');await waitFor('!!document.querySelector(".experiment-editor")')
  if(!await run('document.querySelector("#experiment-editor-title").textContent.includes("手动创建实验")'))throw new Error('Manual editor title missing')
  if(await run('!!document.querySelector(".project-task-assistant")'))throw new Error('Legacy project assistant still embedded in the manual editor')
  await setField('任务名称 *','尚未整理的实验');await click('保存草稿','.experiment-editor');await waitFor('!document.querySelector(".experiment-editor")')
  if(calls.save!==1||calls.start||tasks.length!==1||tasks[0].runs.length||tasks[0].status!=='planned'||tasks[0].launchCommand!=='')throw new Error('Incomplete manual draft was not saved as a draft')

  await waitFor('!!document.querySelector(".experiment-task-card")');await click('完善配置','.experiment-task-card');await waitFor('!!document.querySelector(".experiment-editor")')
  await setField('启动命令','python train.py --data /data/original');await click('创建并选择资源','.experiment-editor')
  await waitFor('!!document.querySelector("#experiment-run-start-title")')
  if(calls.start||tasks.length!==1||calls.save!==2)throw new Error('Resource handoff created a duplicate or started a run')
  await click('返回','.experiment-editor');await waitFor('!document.querySelector(".experiment-editor")')
  if(tasks[0].launchCommand!=='python train.py --data /data/original')throw new Error('Edited draft did not persist')
  await run('document.documentElement.dataset.theme="instrument"');win.setSize(1280,840);await delay(220)
  await click('手动创建');await delay(150)
  if(await run('document.querySelector(".experiment-editor").scrollWidth>document.querySelector(".experiment-editor").clientWidth'))throw new Error('Compact editor overflows')
  await fs.writeFile(path.join(testData,'manual-light-compact.png'),(await win.webContents.capturePage()).toPNG())
  await click('取消','.experiment-editor');await waitFor('!document.querySelector(".experiment-editor")')
  await run('document.documentElement.dataset.theme="ocean"');win.setSize(1600,1000);await delay(200)

  const originalId=tasks[0].id,originalCommand=tasks[0].launchCommand
  tasks[0].status='queued';tasks[0].runs=[{id:randomUUID(),number:1,status:'queued',serverId,accessRouteId:'direct',codePath:tasks[0].codePath,launchCommand:originalCommand,resultSummary:'',notes:''}]
  win.webContents.reload();await waitFor('!!document.querySelector(".experiment-pool-table")');await click('尚未整理的实验');await click('完善配置','.experiment-task-card');await click('保存草稿','.experiment-editor');await waitFor('!document.querySelector(".experiment-editor")')
  if(tasks.length!==2||tasks[0].id!==originalId||tasks[0].launchCommand!==originalCommand||tasks[0].runs[0].launchCommand!==originalCommand||tasks[1].status!=='planned'||tasks[1].runs.length||!tasks[1].title.includes('新配置'))throw new Error('Refining queued configuration mutated the current run')

  await click('尚未整理的实验');await click('创建对照组','.experiment-task-card');await waitFor('!!document.querySelector(".task-research-workspace .research-page")')
  if(await run('document.querySelector("[aria-label=对照来源任务]").value')!==originalId)throw new Error('Counterpart source task lost')
  await fs.writeFile(path.join(testData,'task-counterpart.png'),(await win.webContents.capturePage()).toPNG());await click('返回实验任务')
  if(errors.length)throw new Error(errors.join('\n'))
  const result={status:'passed',calls,testData,mockSSH:true,checks:['no standalone intelligent experiment navigation','smart create entry present without legacy assistant','incomplete manual draft allowed','manual edit and resource handoff do not start a run','light compact editor','queued task refinement preserves the original run','task scoped counterpart workflow']}
  await fs.writeFile(path.join(root,'artifacts/task-creation-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));app.exit(0)
}
setTimeout(()=>{console.error('Task creation UI timeout');app.exit(1)},130000).unref()
main().catch(async error=>{console.error(error);try{const win=BrowserWindow.getAllWindows()[0];if(win){console.error(await win.webContents.executeJavaScript('document.body.innerText.slice(-12000)'));await fs.writeFile(path.join(testData,'failure.png'),(await win.webContents.capturePage()).toPNG())}}catch{}app.exit(1)})
