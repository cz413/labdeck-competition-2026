const {app,BrowserWindow,ipcMain}=require('electron')
const fs=require('node:fs/promises'),path=require('node:path'),{pathToFileURL}=require('node:url'),{randomUUID}=require('node:crypto'),esbuild=require('esbuild')
const root=path.resolve(__dirname,'..'),testData=path.join(root,'artifacts','repository-optimization-'+Date.now())
const setPath=app.setPath.bind(app);app.getAppPath=()=>root;app.setPath=(name,value)=>setPath(name,name==='userData'?testData:value)
app.disableHardwareAcceleration();app.commandLine.appendSwitch('labdeck-headless-check','repository')
const delay=ms=>new Promise(r=>setTimeout(r,ms)),calls={analyze:0,recheck:0,save:0,start:0,cancel:0},errors=[]
app.on('browser-window-created',(_e,w)=>w.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)}))
async function main(){
 await fs.mkdir(testData,{recursive:true})
 const bundle=path.join(testData,'workflow.cjs')
 esbuild.buildSync({stdin:{contents:"export {RepositoryWorkflowService} from './src/main/repository-workflow';export {parseRepositoryGuide,applyRepositoryChecks} from './src/main/repository-analysis';export {reviewRepositoryGuide} from './src/main/repository-review';",resolveDir:root},outfile:bundle,bundle:true,platform:'node',format:'cjs',packages:'external',target:'node22'})
 const {RepositoryWorkflowService,parseRepositoryGuide,applyRepositoryChecks,reviewRepositoryGuide}=require(bundle)
 await import(pathToFileURL(path.join(root,'out/main/index.js')).href)
 let win
 for(let i=0;i<160;i++){win=BrowserWindow.getAllWindows()[0];if(win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript('!!document.querySelector(".intel-navigation")'))break;await delay(100)}
 if(!win||app.getPath('userData')!==testData)throw new Error('Isolated application unavailable')
 win.setSize(1728,1080)
 const run=code=>win.webContents.executeJavaScript(code)
 const waitFor=async code=>{for(let i=0;i<160;i++){if(await run(code))return;await delay(80)}throw new Error('Timed out: '+code)}
 const click=async(label,scope='body')=>{await waitFor(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.trim()===${JSON.stringify(label)});return !!b&&!b.matches(':disabled')})()`);const ok=await run(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.matches(':disabled'))return false;b.click();return true})()`);if(!ok)throw new Error('Unavailable button: '+label)}
 const set=async(selector,value)=>run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLSelectElement?HTMLSelectElement.prototype:e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}))})()`)
 const handle=(channel,fn)=>{ipcMain.removeHandler(channel);ipcMain.handle(channel,(_e,...args)=>fn(...args))}
 const serverId=randomUUID(),now=new Date().toISOString(),tasks=[]
 const server={id:serverId,name:'仓库流程验证',host:'192.0.2.8',port:22,username:'fixture',authType:'password',hostFingerprint:'SHA256:fixture',mode:'real',monitorPolicy:'manual',hasSecret:false,tags:[],group:'test',createdAt:now,updatedAt:now}
 const snapshot={input:{source:'remote',serverId,accessRouteId:'direct',path:'/workspace/repo'},files:['README.md','train.py','evaluate.py'].map(path=>({path,sizeBytes:100})),excerpts:[{path:'README.md',startLine:1,text:'# Training\npython train.py\npip install -r requirements.txt',truncated:false}],warnings:[],collectedAt:now}
 const raw={status:'needs_info',summary:'准备训练，检查数据后保存草稿。',steps:[],launchCommand:'python train.py',launchOrigin:'documented',launchCitations:[{path:'README.md',startLine:2,endLine:2}],workingDirectory:'',environmentName:'',dataPath:'',missingInputs:['实际数据集在哪里？','数据是否预处理完成？'],questions:[]}
 const checks=[{path:'.',expected:'directory',status:'confirmed',message:'exists'},{path:'train.py',expected:'file',status:'confirmed',message:'exists'}]
 const store={getServer:()=>server,listExperimentTasks:()=>structuredClone(tasks),saveExperimentTask:async draft=>{calls.save++;const task={...draft,id:randomUUID(),runs:[],archived:false,createdAt:now,updatedAt:now};tasks.push(task);win.webContents.send('experiments:changed');return structuredClone(task)}}
 const workflow=new RepositoryWorkflowService(store,{
  analyze:async(_input,_progress,signal)=>{calls.analyze++;if(calls.analyze===1)return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return applyRepositoryChecks(parseRepositoryGuide(raw,snapshot),checks)},
  recheck:async(guide,input)=>{calls.recheck++;return applyRepositoryChecks(reviewRepositoryGuide(guide,input),checks)}
 },()=>win.webContents.send('intelligence:changed'),path.join(testData,'workflows'))
 handle('intelligence:settings',()=>({enabled:true,endpoint:'http://127.0.0.1:1/v1',model:'fixture',hasApiKey:false}))
 handle('servers:list',()=>[server]);handle('experiments:list',()=>structuredClone(tasks));handle('monitor:cachedSnapshots',()=>({}));handle('monitor:snapshot',()=>({serverId,status:'offline',error:'fixture: no real SSH',gpus:[],fileSystems:[],sampledAt:now,latencyMs:null,uptimeSeconds:null,loadAverage:null,cpuUsagePercent:null,memoryUsedBytes:null,memoryTotalBytes:null}))
 handle('experiments:listCondaEnvironments',()=>({status:'success',value:{environments:[]}}))
 handle('intelligence:repository-workflows',()=>workflow.list())
 handle('intelligence:repository-inspect',()=>structuredClone({...snapshot,excerpts:[]}))
 handle('intelligence:repository-create',(input,id)=>workflow.create(input,id))
 handle('intelligence:repository-action',(id,action)=>workflow.act(id,action))
 handle('intelligence:repository-cancel',id=>{calls.cancel++;workflow.cancel(id)})
 handle('experiments:startRun',()=>{calls.start++;throw new Error('Unexpected experiment execution')})
 win.webContents.reload();await waitFor('!!document.querySelector(".intel-navigation")');await click('仓库启动','.intel-tabs')
 await set('.repository-input input','/workspace/repo');await set('.repository-input textarea','训练一次')
 await click('分析启动方式','.repository-input');await waitFor(`${calls.analyze}===1||!![...document.querySelectorAll('button')].find(b=>b.textContent==='取消分析')`)
 for(let i=0;i<100&&!calls.analyze;i++)await delay(30)
 await click('取消分析','.repository-input');await waitFor('document.querySelector(".repository-guide").textContent.includes("已取消本次仓库分析")')
 if(calls.analyze!==1||calls.save||calls.start||calls.cancel!==1)throw new Error('Cancellation mutated experiment state or retried')
 await click('重新分析（会请求模型）','.repository-guide');await waitFor('!!document.querySelector(".repository-task-draft")&&!document.querySelector(".repository-task-draft").disabled')
 await set('.repository-task-draft input[placeholder="服务器上的实际数据目录"]','/datasets/actual')
 await waitFor('document.querySelector(".repository-missing textarea").value.length>0'); await click('检查并保存配置','.repository-task-draft')
 await waitFor(`document.querySelector('.repository-status').textContent.includes('需要补充')&&document.querySelectorAll('.repository-missing textarea').length===1&&!document.querySelector('.repository-task-draft').disabled`)
 if(!await run(`[...document.querySelectorAll('.repository-missing label')].some(e=>e.textContent.includes('数据是否预处理完成')&&e.querySelector('textarea').value==='')`))throw new Error('Data directory falsely answered preparation question')
 if(calls.analyze!==2)throw new Error('Review called the model')
 const questionSelector=".repository-missing textarea"
 await set(questionSelector,'已按项目说明完成预处理，文件格式已核对')
 await waitFor('document.querySelector(".repository-missing textarea").value.length>0'); await click('检查并保存配置','.repository-task-draft');await waitFor('document.querySelector(".repository-status").textContent.includes("可以保存")')
 await run('document.fonts.ready');await fs.writeFile(path.join(testData,'review-dark.png'),(await win.webContents.capturePage()).toPNG())
 await run('document.documentElement.dataset.theme="instrument"');win.setSize(1280,840);await delay(200)
 if(await run('document.querySelector(".repository-guide").scrollWidth>document.querySelector(".repository-guide").clientWidth'))throw new Error('Compact repository layout overflows')
 await fs.writeFile(path.join(testData,'review-light-compact.png'),(await win.webContents.capturePage()).toPNG())
 await click('保存并选择 GPU','.repository-save');await waitFor('!!document.querySelector(".experiment-task-card")||!!document.querySelector(".experiment-start-dialog")||!!document.querySelector(".confirm-dialog")')
 if(calls.save!==1||calls.start||tasks[0].status!=='planned'||tasks[0].runs.length)throw new Error('Saving created an unexpected experiment run')
 if(errors.length)throw new Error(errors.join('\n'))
 const result={status:'passed',mockModel:true,mockSSH:true,realModel:false,calls,testData,checks:['cancel button remains enabled while fields are locked','cancellation does not retry or create tasks','explicit retry resumes workflow','data path does not answer preparation status','review uses no model requests','dark/light and compact layout','save creates one draft without execution']}
 await fs.writeFile(path.join(root,'artifacts/repository-ui-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));app.exit(0)
}
setTimeout(()=>{console.error('Repository UI verification timeout');app.exit(1)},85000).unref()
main().catch(async error=>{console.error(error);try{const win=BrowserWindow.getAllWindows()[0];if(win){console.error(await win.webContents.executeJavaScript('document.querySelector(".repository-guide")?.innerText'));await fs.writeFile(path.join(testData,'failure.png'),(await win.webContents.capturePage()).toPNG())}}catch{}app.exit(1)})
