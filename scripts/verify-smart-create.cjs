// Smart experiment creation: project + intent in, reviewed plan out, shared task save.
const {app,BrowserWindow,ipcMain}=require('electron')
const fs=require('node:fs/promises'),path=require('node:path'),{pathToFileURL}=require('node:url'),{randomUUID}=require('node:crypto')
const root=path.resolve(__dirname,'..'),testData=path.join(root,'artifacts','smart-create-'+Date.now())
const setPath=app.setPath.bind(app);app.getAppPath=()=>root;app.setPath=(name,value)=>setPath(name,name==='userData'?testData:value)
app.disableHardwareAcceleration();app.commandLine.appendSwitch('labdeck-headless-check','smart-create')
const delay=ms=>new Promise(r=>setTimeout(r,ms)),calls={inspect:0,prepare:0,save:0,start:0,cancel:0,browse:0},errors=[],tasks=[]
app.on('browser-window-created',(_e,w)=>w.webContents.on('console-message',e=>{if(e.level==='error'&&!e.message.includes('已取消项目分析'))errors.push(e.message)}))
async function main(){
  await fs.mkdir(testData,{recursive:true})
  await import(pathToFileURL(path.join(root,'out/main/index.js')).href)
  let win
  for(let i=0;i<150;i++){win=BrowserWindow.getAllWindows()[0];if(win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript('!!document.querySelector(".experiment-pool-page")'))break;await delay(100)}
  if(!win||app.getPath('userData')!==testData)throw new Error('Isolated application unavailable')
  win.setSize(1600,1000)
  const run=code=>win.webContents.executeJavaScript(code)
  const waitFor=async code=>{for(let i=0;i<180;i++){if(await run(code))return;await delay(60)}throw new Error('Timed out: '+code)}
  const click=async(label,scope='body')=>{await waitFor(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.trim()===${JSON.stringify(label)});return !!b&&!b.disabled})()`);await run(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.trim()===${JSON.stringify(label)});b.click()})()`)}
  const clickContaining=async(label,scope='body')=>{await waitFor(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.includes(${JSON.stringify(label)}));return !!b&&!b.disabled})()`);await run(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.includes(${JSON.stringify(label)}));b.click()})()`)}
  const set=async(selector,value)=>run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLSelectElement?HTMLSelectElement.prototype:e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}))})()`)
  const setField=async(label,value,scope='.experiment-editor')=>{const selector=await run(`(()=>{const labels=[...document.querySelectorAll(${JSON.stringify(scope+' label.field')})];const e=labels.find(e=>e.querySelector(':scope>span')?.textContent===${JSON.stringify(label)})?.querySelector('input,textarea,select');if(!e)throw new Error('Missing field '+${JSON.stringify(label)});e.dataset.testField='active';return '[data-test-field=active]'})()`);await set(selector,value);await run('delete document.querySelector("[data-test-field=active]").dataset.testField')}
  const handle=(channel,fn)=>{ipcMain.removeHandler(channel);ipcMain.handle(channel,(_e,...args)=>fn(...args))}
  const serverId=randomUUID(),now=new Date().toISOString()
  const server={id:serverId,name:'智能创建验证节点',host:'192.0.2.8',port:22,username:'fixture',authType:'password',hostFingerprint:'SHA256:fixture',mode:'real',monitorPolicy:'manual',hasSecret:false,tags:[],group:'test',createdAt:now,updatedAt:now}
  const files=['README.md','requirements.txt','environment.yml','configs/base.yaml','train.py','evaluate.py','utils/data.py']
  const readme=['# Demo','','## 训练','```bash','python train.py --config configs/base.yaml --data /data/original --epochs 100','```','','## 评估','```bash','python evaluate.py --checkpoint weights/model.pth --data /data/val','```','','评估指标包括 Accuracy、F1 和 Loss。'].join('\n')
  const snapshot=input=>({input:{source:'remote',serverId,accessRouteId:'direct',path:'/workspace/repo'},files:files.map(path=>({path,sizeBytes:120})),excerpts:[{path:'README.md',startLine:1,text:readme,truncated:false},{path:'environment.yml',startLine:1,text:'name: vision\ndependencies:\n  - python=3.10',truncated:false}],warnings:[],collectedAt:now})
  const guide=()=>({status:'ready_for_review',summary:'项目提供训练与评估两种方式，已找到默认配置和两个可用环境。',steps:[],launchCommand:'python train.py --config configs/base.yaml --data /data/original --epochs 100',launchOrigin:'documented',launchCitations:[{path:'README.md',startLine:5,endLine:5,quote:'python train.py --config configs/base.yaml --data /data/original --epochs 100'}],launchSources:['README.md'],workingDirectory:'',environmentName:'',dataPath:'',missingInputs:['数据集目录尚未确定'],questions:['是否已经准备好预训练权重？'],warnings:[],checks:[{path:'.',expected:'directory',status:'confirmed',message:'exists'},{path:'train.py',expected:'file',status:'confirmed',message:'exists'}],snapshot:snapshot()})
  handle('intelligence:settings',()=>({enabled:true,endpoint:'http://127.0.0.1:1/v1',model:'fixture',hasApiKey:false}))
  handle('servers:list',()=>[server]);handle('experiments:list',()=>structuredClone(tasks));handle('monitor:cachedSnapshots',()=>({}));handle('intelligence:history',()=>[])
  handle('research:list',()=>[]);handle('research:engine',()=>({available:false,message:'fixture'}))
  handle('monitor:snapshot',()=>({serverId,status:'online',gpus:[{index:0,uuid:'GPU-fixture',name:'NVIDIA Fixture',memoryTotalMiB:24576,memoryUsedMiB:1024,utilizationPercent:5,temperatureCelsius:40,processes:[]}],fileSystems:[],sampledAt:now,latencyMs:null,uptimeSeconds:null,loadAverage:null,cpuUsagePercent:null,memoryUsedBytes:null,memoryTotalBytes:null}))
  handle('experiments:listCondaEnvironments',()=>({status:'success',value:{environments:[{name:'vision',prefix:'/opt/conda/envs/vision'},{name:'torch24',prefix:'/opt/conda/envs/torch24'}]}}))
  handle('experiments:checkCondaEnvironment',(_serverId,_route,config)=>({found:true,name:config.environmentName||'',prefix:'/opt/conda/envs/'+config.environmentName,pythonInterpreterPath:'/opt/conda/envs/'+config.environmentName+'/bin/python',pythonVersion:'3.10.14'}))
  handle('intelligence:repository-inspect',input=>{calls.inspect++;return snapshot(input)})
  handle('intelligence:repository-discover',()=>[])
  handle('intelligence:repository-browse',input=>{calls.browse++;const target=input.path||'/workspace';if(target==='/workspace/repo')return{path:target,parent:'/workspace',home:'/workspace',entries:[{name:'data',path:'/workspace/repo/data'},{name:'datasets',path:'/workspace/repo/datasets'},{name:'runs',path:'/workspace/repo/runs'}]};if(target==='/workspace/repo/data')return{path:target,parent:'/workspace/repo',home:'/workspace',entries:[{name:'train',path:'/workspace/repo/data/train'}]};return{path:target,parent:'/',home:'/workspace',entries:[]}})
  handle('intelligence:project-prepare',async(_input,id)=>{calls.prepare++;win.webContents.send('intelligence:repository-progress',{id,stage:'read',message:'正在阅读 README 与训练入口'});await delay(80);win.webContents.send('intelligence:repository-progress',{id,stage:'verify',message:'正在核对入口文件与启动目录'});return guide()})
  handle('intelligence:project-cancel',()=>{calls.cancel++})
  handle('experiments:save',draft=>{calls.save++;const existing=tasks.find(t=>t.id===draft.id),task={...draft,id:draft.id||randomUUID(),runs:existing?.runs||[],archived:false,createdAt:existing?.createdAt||now,updatedAt:now};if(existing)tasks.splice(tasks.indexOf(existing),1,task);else tasks.push(task);win.webContents.send('experiments:changed');return structuredClone(task)})
  handle('experiments:startRun',()=>{calls.start++;throw new Error('Unexpected execution')})
  win.webContents.reload();await waitFor('!!document.querySelector(".experiment-pool-page")')
  await click('智能创建');await waitFor('!!document.querySelector(".smart-create")')
  if(await run('!!document.querySelector("[aria-label=任务名称]")||!!document.querySelector(".experiment-editor")'))throw new Error('Start screen shows the full form')
  if(!await run('!!document.querySelector("[aria-label=项目目录]")&&!!document.querySelector("[aria-label=实验目标]")'))throw new Error('Start screen lost project or intent input')
  await set('[aria-label=实验目标]','先跑一次基线');await set('[aria-label=项目目录]','/workspace/repo')
  await click('分析项目并准备实验');await waitFor('!!document.querySelector(".smart-plan")',)
  const progress=await run('document.querySelector(".smart-progress").innerText')
  for(const text of ['训练入口 train.py','评估入口 evaluate.py','已找到 2 个可用环境','正在核对入口文件'])if(!progress.includes(text))throw new Error('Progress did not explain: '+text)
  if(calls.inspect!==1||calls.prepare!==1||calls.save)throw new Error('Analysis created a task or skipped inspection')
  if(!await run('document.querySelector("[aria-label=任务名称]").value.includes("训练基线")'))throw new Error('Suggested task name missing')
  if(!await run(`[...document.querySelectorAll('.smart-plan code')].some(code=>code.textContent.includes('train.py'))`))throw new Error('Training command missing from plan')
  for(const text of ['本次实验','运行方式','环境与数据','输出与观察'])if(!await run(`document.querySelector('.smart-plan-grid').innerText.includes(${JSON.stringify(text)})`))throw new Error('Plan card missing: '+text)
  if(!await run(`document.querySelector('.smart-card').innerText.includes('Accuracy')||document.querySelector('.smart-plan-grid').innerText.includes('Accuracy')`))throw new Error('Project metrics missing')
  await fs.writeFile(path.join(testData,'smart-plan-dark.png'),(await win.webContents.capturePage()).toPNG())

  await clickContaining('/workspace/repo/data','.smart-gap-options');await waitFor(`document.querySelector('[aria-label=数据目录]').value==='/workspace/repo/data'`)
  if(!await run(`[...document.querySelectorAll('.smart-plan code')].some(code=>code.textContent.includes('--data /workspace/repo/data'))`))throw new Error('Data answer did not sync the command')
  await waitFor(`!!document.querySelector('.smart-gap-options')&&document.querySelector('.smart-gap h3').textContent.includes('环境')`)
  await clickContaining('vision','.smart-gap-options');await waitFor(`document.querySelector('[aria-label=推荐环境]').value==='vision'`)

  await set('#smart-refine-input','先跑少量数据验证流程');await click('修改方案')
  await waitFor(`[...document.querySelectorAll('.smart-plan code')].some(code=>code.textContent.includes('--epochs 1'))`)
  if(!await run(`document.querySelector('.smart-refine-note').textContent.includes('已更新')`))throw new Error('Refinement did not explain the change')
  await run('document.querySelector(".smart-history").open=true');await click('撤销上次修改')
  await waitFor(`[...document.querySelectorAll('.smart-plan code')].some(code=>code.textContent.includes('--epochs 100'))`)

  await set('#smart-refine-input','改成只评估已有权重');await click('修改方案')
  await waitFor(`[...document.querySelectorAll('.smart-plan code')].some(code=>code.textContent.includes('evaluate.py'))`)
  if(!await run('document.querySelector("[aria-label=任务名称]").value.includes("评估已有权重")'))throw new Error('Suggested task name did not follow the mode')

  await set('[aria-label=推荐环境]','');await waitFor(`document.querySelector('[aria-label=推荐环境]').value===''`)
  await set('#smart-refine-input','使用 vision 环境');await click('修改方案')
  await waitFor('!!document.querySelector(".smart-conflict")')
  await click('采用新值','.smart-conflict');await waitFor(`document.querySelector('[aria-label=推荐环境]').value==='vision'`)

  await click('编辑完整配置');await waitFor('!!document.querySelector(".experiment-editor")')
  if(!await run('document.querySelector("#experiment-editor-title").textContent.includes("编辑完整配置")'))throw new Error('Full config title missing')
  await setField('任务名称 *','完整配置名称');await click('完成编辑');await waitFor('!document.querySelector(".experiment-editor")')
  if(await run('document.querySelector("[aria-label=任务名称]").value')!=='完整配置名称')throw new Error('Full config did not flow back to the plan')
  if(calls.save)throw new Error('Full config created a task')

  await set('[aria-label=任务名称]','智能创建基线');await click('保存草稿')
  await waitFor('!!document.querySelector(".smart-saved")')
  if(calls.save!==1||tasks.length!==1||tasks[0].runs.length||tasks[0].status!=='planned'||tasks[0].launchCommand!=='python evaluate.py --checkpoint weights/model.pth --data /workspace/repo/data')throw new Error('Draft save did not keep the reviewed configuration')
  if(calls.start)throw new Error('Draft save started a run')
  await fs.writeFile(path.join(testData,'smart-plan-light.png'),(await win.webContents.capturePage()).toPNG())

  await click('创建并选择资源');await waitFor('!!document.querySelector("#experiment-run-start-title")')
  if(calls.save!==1||tasks.length!==1||calls.start)throw new Error('Resource handoff created a duplicate or started a run')
  await click('返回','.experiment-editor');await waitFor('!document.querySelector(".experiment-editor")')

  await click('智能创建');await waitFor('!!document.querySelector(".smart-create")')
  await set('[aria-label=实验目标]','评估已有权重');await set('[aria-label=项目目录]','/workspace/repo');await click('分析项目并准备实验')
  await waitFor('!!document.querySelector(".smart-plan")');await click('返回实验任务')
  await waitFor('!!document.querySelector(".confirm-dialog")');await click('离开','.confirm-dialog')
  await waitFor('!document.querySelector(".smart-create")')

  await click('手动创建');await waitFor('!!document.querySelector(".experiment-editor")');await setField('任务名称 *','手动草稿');await click('保存草稿');await waitFor('!document.querySelector(".experiment-editor")')
  if(tasks.length!==2||tasks[1].launchCommand!=='')throw new Error('Manual draft path broke')
  if(errors.length)throw new Error(errors.join('\n'))
  const result={status:'passed',calls,testData,mockSSH:true,mockModel:true,checks:['start asks only for project and intent','analysis reports entry, environment and file understanding','plan cards cover experiment, runtime, environment/data and output/metrics','documented evaluation entry switches without a model call','one focused data question syncs the command','server environment selection','deterministic smoke-run refinement with undo','manual environment edit conflicts and explicit choice','full config edits flow back without saving','save draft creates one planned task without a run','create-and-select-resources uses the existing GPU dialog','returning to the pool keeps the saved draft','manual creation still available']}
  await fs.writeFile(path.join(root,'artifacts/smart-create-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));app.exit(0)
}
setTimeout(()=>{console.error('Smart create UI timeout');app.exit(1)},140000).unref()
main().catch(async error=>{console.error(error);try{const win=BrowserWindow.getAllWindows()[0];if(win){console.error(await win.webContents.executeJavaScript('document.body.innerText.slice(-14000)'));await fs.writeFile(path.join(testData,'failure.png'),(await win.webContents.capturePage()).toPNG())}}catch{}app.exit(1)})
