const {app,BrowserWindow,ipcMain}=require('electron')
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),{pathToFileURL}=require('node:url'),esbuild=require('esbuild')
const root=path.resolve(__dirname,'..'),testData=path.resolve(root,'artifacts/research-ui-check')
app.getAppPath=()=>root;app.disableHardwareAcceleration();app.commandLine.appendSwitch('labdeck-headless-check','research')
const errors=[],calls={model:0,ssh:0,save:0,start:0,diagnose:0,preview:0}
const delay=ms=>new Promise(r=>setTimeout(r,ms))
app.on('browser-window-created',(_e,win)=>win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)}))
async function main(){
 if(!testData.startsWith(root+path.sep))throw new Error('Unsafe verification path')
 await fs.rm(testData,{recursive:true,force:true})
 const bundle=path.join(root,'artifacts/research-service-test.cjs')
 esbuild.buildSync({entryPoints:[path.join(root,'src/main/research-service.ts')],outfile:bundle,bundle:true,platform:'node',format:'cjs',packages:'external',target:'node22'})
 await import(pathToFileURL(path.join(root,'out/main/index.js')).href)
 let win
 for(let i=0;i<160;i++){win=BrowserWindow.getAllWindows()[0];if(win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript('!!document.querySelector(".intel-page")'))break;await delay(100)}
 if(!win||app.getPath('userData')!==testData)throw new Error('Isolated window unavailable')
 win.setSize(1728,1080)
 const run=async code=>{try{return await win.webContents.executeJavaScript(code)}catch(error){throw new Error('Renderer operation failed: '+code+'\n'+errors.join('\n'),{cause:error})}}
 const waitFor=async code=>{for(let i=0;i<200;i++){if(await run(code))return;await delay(80)}throw new Error('Timed out: '+code)}
 const click=async(label,scope='body')=>{await waitFor(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.trim()===${JSON.stringify(label)});return !!b&&!b.disabled})()`);if(!await run(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`))throw new Error('Button unavailable: '+label)}
 const capture=async name=>{await delay(300);await fs.mkdir(path.join(root,'docs/screenshots'),{recursive:true});await fs.writeFile(path.join(root,'docs/screenshots',name+'.png'),(await win.webContents.capturePage()).toPNG())}
 const handle=(channel,fn)=>{ipcMain.removeHandler(channel);ipcMain.handle(channel,(_e,...args)=>fn(...args))}
 const timestamp=new Date().toISOString(),serverId=randomUUID()
 const server={id:serverId,name:'研究流程测试节点',host:'192.0.2.1',port:22,username:'user',authType:'password',hostFingerprint:'SHA256:fixture',mode:'real',monitorPolicy:'manual',hasSecret:false,tags:[],group:'测试',createdAt:timestamp,updatedAt:timestamp}
 const base={id:randomUUID(),title:'研究流程 · 基准任务',project:'vision',objective:'比较学习率',tags:[],priority:'normal',status:'planned',serverId,accessRouteId:'direct',codePath:'/workspace/vision',dataPath:'/datasets/vision',launchCommand:'python train.py --lr 0.01 --batch-size 16',launchMode:'command',scriptPath:'',artifactPath:'',resultSummary:'',notes:'base fixture',archived:false,createdAt:timestamp,updatedAt:timestamp,runs:[]}
 const tasks=[base]
 const store={listExperimentTasks:()=>structuredClone(tasks),getServer:()=>server,getSecrets:()=>({}),saveExperimentTask:async draft=>{calls.save++;const task={...draft,id:randomUUID(),archived:false,createdAt:timestamp,updatedAt:timestamp,runs:[]};tasks.push(task);return structuredClone(task)},startExperimentRun:async(id,input)=>{calls.start++;const task=tasks.find(t=>t.id===id);task.runs.push({...input,id:randomUUID(),number:1,status:'queued',resultSummary:''});task.status='queued';return structuredClone(task)}}
 const intelligence={history:async()=>[],diagnose:async()=>{calls.diagnose++;return {id:randomUUID()}},requestResearchModel:async(_system,input)=>{calls.model++;if(!input.runs)return {axes:[{flag:'--lr',values:['0.001','0.0001']},{flag:'--seed',values:['42','43']}],hypothesis:'仅学习率和 seed 变化，其余变量固定。',assumptions:['模型接口在此验证中返回固定结构，不代表实际模型调用。']};return {summary:'两种学习率均正常运行；较小学习率的验证损失更高，科学结果仍有效。',observations:['四项运行均记录 val_loss。'],limitations:['仅有两个 seed，尚不足以确认统计显著性。'],evidenceIds:input.runs.map(r=>r.evidenceId),nextSuggestion:{objective:'增加随机种子复现观察',axes:[{flag:'--lr',values:['0.001']},{flag:'--seed',values:['44','45']}]}}}}
 const ssh={connect:async()=>{calls.ssh++;return {client:{end(){}}}},exec:async(_client,command)=>{calls.ssh++;return command.includes('__LABDECK_EXIT__')?'__LABDECK_EXIT__0':'epoch=2 val_loss=1.8 val_accuracy=0.51'}}
 const {ResearchService}=require(bundle)
 let service=new ResearchService(store,intelligence,ssh,()=>win.webContents.send('research:changed'),()=>win.webContents.send('experiments:changed'))
 for(const name of ['preview','list','engine','suggest','create','approve','refresh','analyze','paused','export'])ipcMain.removeHandler('research:'+name)
 service.registerIpc()
 const previewChannel=async(command,axes,max)=>{calls.preview++;const {ParameterBridge}=require(path.join(root,'artifacts/parameter-bridge-test.cjs'));return new ParameterBridge(path.join(root,'resources/cangjie')).expand(command,axes,max)}
 esbuild.buildSync({entryPoints:[path.join(root,'src/main/parameter-bridge.ts')],outfile:path.join(root,'artifacts/parameter-bridge-test.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external',target:'node22'})
 handle('research:preview',previewChannel)
 handle('servers:list',()=>[server]);handle('experiments:list',()=>structuredClone(tasks));handle('intelligence:settings',()=>({enabled:true,endpoint:'https://fixture.invalid',model:'UI fixture',hasApiKey:false}))
 handle('monitor:snapshot',()=>({serverId,status:'offline',error:'UI fixture',gpus:[],fileSystems:[],sampledAt:timestamp,latencyMs:null,uptimeSeconds:null,loadAverage:null,cpuUsagePercent:null,memoryUsedBytes:null,memoryTotalBytes:null}))
 win.webContents.reload();await waitFor('!!document.querySelector(".intel-page")')
 await click('实验任务','.workbench-modulebar');await waitFor('!!document.querySelector(".experiment-pool-table")')
 await click('研究流程 · 基准任务');await waitFor('!!document.querySelector(".experiment-task-card")');await click('设计对照实验')
 await waitFor('!!document.querySelector(".research-page")')
 if(await run('document.querySelector("[aria-label=对照来源任务]").value')!==base.id)throw new Error('Source task not carried into research')
 await click('AI 设计范围');await waitFor('document.querySelector(".intel-assumptions")?.textContent.includes("其余变量固定")')
 await run('document.querySelector(".research-form .intel-checkbox input").click()')
 await click('生成待审查方案');await waitFor('document.querySelectorAll(".research-output .research-table tbody tr").length===4')
 if(calls.start!==0||calls.save!==0)throw new Error('Tasks started before approval')
 await capture('research-review-dark')
 const campaignId=(await service.list())[0].id
 await click('审查并确认本批入队');await waitFor('!!document.querySelector(".confirm-dialog")');await click('取消','.confirm-dialog')
 if(calls.start!==0)throw new Error('Cancelled approval created tasks')
 await click('审查并确认本批入队');await waitFor('!!document.querySelector(".confirm-dialog")');await click('确认本批加入队列','.confirm-dialog')
 await waitFor('document.querySelector(".research-campaign-heading")?.textContent.includes("等待本批运行结束")')
 if(calls.save!==4||calls.start!==4||base.runs.length)throw new Error('Queue linkage or baseline isolation failed')
 await click('检查进度');await delay(200);if(calls.model!==1||calls.ssh!==0)throw new Error('Waiting polled model or SSH logs')
 service.stop();service=new ResearchService(store,intelligence,ssh,()=>win.webContents.send('research:changed'),()=>win.webContents.send('experiments:changed'))
 for(const name of ['preview','list','engine','suggest','create','approve','refresh','analyze','paused','export'])ipcMain.removeHandler('research:'+name)
 service.registerIpc();handle('research:preview',previewChannel)
 win.webContents.reload();await waitFor('!!document.querySelector(".intel-page")');await click('对照实验');await waitFor('document.querySelector(".research-campaign-heading")?.textContent.includes("等待本批运行结束")')
 if((await service.list())[0].id!==campaignId||calls.start!==4)throw new Error('Restart duplicated batch')
 tasks.slice(1).forEach((task,i)=>{task.status='completed';Object.assign(task.runs[0],{status:'completed',logPath:`/workspace/run${i}/log`,remoteRunDir:`/workspace/run${i}`})});win.webContents.send('experiments:changed')
 await click('检查进度');await waitFor('!!document.querySelector(".research-analysis")')
 if(calls.diagnose!==0||calls.start!==4)throw new Error('Poor metrics triggered repair')
 if(!await run('document.querySelector(".research-analysis")?.textContent.includes("科学结果仍有效")'))throw new Error('Model analysis absent')
 await run('document.querySelector(".research-observations").scrollIntoView({block:"start"})');await capture('research-analysis-dark')
 await run('document.documentElement.dataset.theme="instrument"');await capture('research-analysis-light')
 await click('载入下一批建议');if(await run('document.querySelectorAll(".research-axis input")[3].value')!=='44, 45'||calls.start!==4)throw new Error('Next proposal submitted automatically')
 const baselineCalls={...calls},bookBefore=JSON.stringify(await service.list()),tasksBefore=JSON.stringify(tasks)
 await click('载入对照演示');await waitFor('document.querySelector(".research-campaign-heading")?.textContent.includes("【模拟】")')
 await click('审查并确认本批入队');await waitFor('!!document.querySelector(".confirm-dialog")');await click('确认模拟入队','.confirm-dialog')
 await click('模拟正常结束（含指标变差）');await waitFor('document.querySelector(".research-analysis")?.textContent.includes("指标变差仍属于正常")')
 await capture('research-demo-results')
 await click('重置对照演示');await waitFor('!document.querySelector(".research-analysis")');await click('审查并确认本批入队');await waitFor('!!document.querySelector(".confirm-dialog")');await click('确认模拟入队','.confirm-dialog');await click('模拟一项运行故障');await waitFor('document.querySelector(".research-analysis")?.textContent.includes("一项运行显存不足")')
 await click('退出对照演示');if(JSON.stringify(await service.list())!==bookBefore||JSON.stringify(tasks)!==tasksBefore)throw new Error('Demo modified persistent data')
 for(const key of ['save','start','model','ssh','diagnose'])if(calls[key]!==baselineCalls[key])throw new Error('Demo invoked production operation: '+key)
 win.setSize(1280,840);await delay(200);if(await run('document.querySelector(".workbench-page").scrollWidth>document.querySelector(".workbench-page").clientWidth'))throw new Error('Compact page overflow');await capture('research-compact')
 service.stop();if(errors.length)throw new Error(errors.join('\n'))
 const result={status:'passed',realLangGraph:true,realCangjie:true,mockSSH:true,mockModel:true,calls,checks:['task source navigation','native parameter expansion','approval cancel without mutations','approved batch queue','waiting without model polling','disk checkpoint restart','no duplicate submission','poor metrics remain observations','next proposal review required','demo isolation','dark/light/compact UI']}
 await fs.writeFile(path.join(root,'artifacts/research-ui-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));app.exit(0)
}
app.whenReady().then(main).catch(error=>{console.error(error);console.error(errors.join('\n'));app.exit(1)})




