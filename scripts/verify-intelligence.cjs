const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const root=path.resolve(__dirname,'..')
app.getAppPath=()=>root
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('labdeck-headless-check')
const errors=[]
app.on('browser-window-created',(_event,win)=>{
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)})
  win.webContents.on('render-process-gone',(_e,details)=>errors.push('Renderer exited: '+details.reason))
})
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function main(){
  await import(pathToFileURL(path.join(root,'out/main/index.js')).href)
  let win
  for(let i=0;i<150;i++){
    win=BrowserWindow.getAllWindows()[0]
    if(win&&!win.webContents.isLoading()&&await win.webContents.executeJavaScript('!!document.querySelector(".intel-page")'))break
    await delay(100)
  }
  if(!win)throw new Error('Main window did not open')
  const run=code=>win.webContents.executeJavaScript(code)
  const waitFor=async(code)=>{
    for(let i=0;i<180;i++){if(await run(code))return;await delay(100)}
    throw new Error('UI state timed out: '+code)
  }
  const click=async(label)=>{
    const found=await run(`(()=>{const b=[...document.querySelectorAll('.intel-page button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true})()`)
    if(!found)throw new Error('Button unavailable: '+label)
  }
  const capture=async(name)=>{
    await run('document.fonts.ready');await delay(250)
    const image=await win.webContents.capturePage()
    await fs.mkdir(path.join(root,'docs/screenshots'),{recursive:true})
    await fs.writeFile(path.join(root,'docs/screenshots',name+'.png'),image.toPNG())
  }
  await waitFor('!!document.querySelector(".intel-page")')
  if(!app.getPath('userData').startsWith(path.join(root,'artifacts')))throw new Error('Test data is not isolated')
  await click('收集证据并诊断')
  await waitFor('!!document.querySelector(".intel-report")')
  const report=await run('window.labApi.intelligence.history().then(a=>a[0])')
  if(report.source!=='sample'||report.engine!=='rules'||report.findings[0].category!=='oom'||report.repair)throw new Error('Sample diagnosis was not truthful')
  await run('document.querySelector(".intel-evidence-links button").click()')
  await waitFor('!!document.querySelector(".intel-highlight")')
  if(!await run('document.querySelector(".intel-highlight").textContent.includes("out of memory")'))throw new Error('Evidence link failed')
  await capture('intelligence-dark')
  const dims=await run(`(()=>{const p=document.querySelector('.workbench-main'),r=document.querySelector('.intel-report-column');return {pageOverflow:p.scrollWidth>p.clientWidth,reportOverflow:r.scrollWidth>r.clientWidth}})()`)
  if(dims.pageOverflow||dims.reportOverflow)throw new Error('Unexpected horizontal overflow: '+JSON.stringify(dims))
  await run('document.documentElement.dataset.theme="instrument"')
  await capture('intelligence-light')
  // Exercise real IPC settings, transport, JSON parsing and plan validation against a local mock HTTP service.
  const http=require('node:http')
  const requests=[]
  let holdResponse=false
  const server=http.createServer((req,res)=>{
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      const data=JSON.parse(body);requests.push(data)
      const isPlan=data.messages[0].content.includes('任务草稿')
      const payload=JSON.parse(data.messages[1].content)
      const result=isPlan?{title:'界面验证实验',launchCommand:'python train.py --batch-size 16',dataPath:'/datasets/flowers',minimumFreeVramGiB:20,assumptions:['请确认 train.py 支持 --batch-size 参数']}:payload.action==='connection-test'?{ok:true}:!payload.previousChecks?.length?{action:'inspect',toolCalls:[{tool:'search_log',arguments:{query:'out of memory'},reason:'核对显存错误的具体日志',evidenceIds:['log-5']}]}:{action:'final',summary:'日志包含明确 CUDA 显存不足信号。',findings:[{category:'oom',title:'核对 batch size 与显存',confidence:'medium',explanation:'应通过新的实验运行验证。',evidenceIds:['check-1','log-5'],steps:['检查 batch size']}]}
      const respond=()=>{if(!res.destroyed){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}))}}
      if(holdResponse)setTimeout(respond,600).unref();else respond()
    })
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const port=server.address().port
  try{
    await run(`window.labApi.intelligence.saveSettings({enabled:true,endpoint:'http://127.0.0.1:${port}/v1',model:'local-ui-test'})`)
    const response=await run('window.labApi.intelligence.testModel()')
    if(!response.includes('正常'))throw new Error('Model test failed')
    const servers=await run('window.labApi.servers.list()')
    const plan=await run(`window.labApi.intelligence.plan({intent:'训练图像分类模型，batch size 16',serverId:${JSON.stringify(servers[0].id)},codePath:'/workspace/vision',environmentName:'vision'})`)
    if(plan.engine!=='model'||plan.draft.status!=='planned'||plan.draft.launchCommand!=='python train.py --batch-size 16')throw new Error('Plan integration failed')
    const remount=async()=>{await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='资源').click()`);await waitFor('!document.querySelector(".intel-page")');await run(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='智能实验').click()`);await waitFor('!!document.querySelector(".intel-page")')}
    await remount();await waitFor('document.querySelector(".intel-model-status").textContent.includes("local-ui-test")')
    await run(`(()=>{const input=[...document.querySelectorAll('.intel-checkbox')].find(l=>l.textContent.includes('模型多轮诊断')).querySelector('input');input.click()})()`)
    await click('收集证据并诊断')
    await waitFor('!!document.querySelector(".intel-investigation")')
    const modeled=await run('window.labApi.intelligence.history().then(a=>a[0])')
    if(modeled.engine!=='agent+rules'||modeled.investigation.rounds!==2||modeled.investigation.inspections!==1)throw new Error('Multi-round diagnosis failed')
    if(!await run('document.querySelector(".intel-investigation").textContent.includes("搜索日志线索")'))throw new Error('Trace not displayed')
    await run('document.querySelector(".intel-trace-step:nth-child(2) .intel-evidence-links button").click()')
    await waitFor('!!document.querySelector(".intel-highlight")')
    if(!await run('document.querySelector(".intel-highlight").textContent.includes("check")||document.querySelector(".intel-highlight").textContent.includes("matches")'))throw new Error('Check result link failed')
    await run('document.documentElement.dataset.theme="dark"');await capture('intelligence-investigation-dark')
    await run('document.documentElement.dataset.theme="instrument"');await capture('intelligence-investigation-light')
    if(requests.length!==4)throw new Error('Unexpected number of model requests: '+requests.length)
    holdResponse=true
    await click('收集证据并诊断');await waitFor('!!document.querySelector(".intel-progress")')
    for(let i=0;i<60&&requests.length<5;i++)await delay(20)
    if(requests.length!==5)throw new Error('Cancellable model request did not start')
    await click('停止诊断');await waitFor('!document.querySelector(".intel-progress")')
    const cancelled=await run('window.labApi.intelligence.history().then(a=>a[0])')
    if(cancelled.investigation.status!=='cancelled'||cancelled.engine!=='rules'||cancelled.findings[0].category!=='oom')throw new Error('Cancellation did not retain rule evidence')
    await run('window.labApi.intelligence.saveSettings({enabled:false,endpoint:"http://127.0.0.1:11434/v1",model:"",clearApiKey:true})')
    await remount();await waitFor('document.querySelector(".intel-model-status").textContent.includes("未启用")')
  }finally{await new Promise(resolve=>server.close(resolve))}
  await click('实验计划')
  await waitFor('!!document.querySelector(".intel-plan-layout")')
  if(!await run('[...document.querySelectorAll(".intel-page button")].find(b=>b.textContent.includes("生成执行计划")).disabled'))throw new Error('Unconfigured model must disable generation')
  await capture('intelligence-plan-empty')
  await click('模型设置');await waitFor('!!document.querySelector(".intel-model-form")');await capture('intelligence-model-settings')
  if(errors.length)throw new Error('Renderer errors: '+errors.join('\n'))
  console.log(JSON.stringify({status:'passed',checks:['real preload and IPC','sample diagnosis truthfulness','evidence navigation','dark/light layout','isolated app data','model HTTP transport','model plan schema','model evidence validation','model-selected checks','visible investigation trace','check-result navigation','live progress and cancellation','unconfigured model state'],screenshots:6,testData:app.getPath('userData')},null,2))
  app.exit(0)
}
setTimeout(()=>{console.error('Intelligence UI check timed out');app.exit(1)},60_000).unref()
main().catch(error=>{console.error(error);app.exit(1)})
