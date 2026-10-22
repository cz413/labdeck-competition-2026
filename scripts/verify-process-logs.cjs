const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { randomUUID } = require('node:crypto')
const root = path.resolve(__dirname, '..')
const testData = path.join(root, 'artifacts', 'realtime-log-ui-' + Date.now())
const originalSetPath = app.setPath.bind(app)
app.getAppPath = () => root
app.setPath = (name, value) => originalSetPath(name, name === 'userData' ? testData : value)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('labdeck-headless-check', 'realtime-logs')
const delay = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
const state = { inspections: [], reads: [], taskReads: 0, manual: false, running: true, reused: false }
const errors = []
app.on('browser-window-created', (_event, win) => win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) }))
setTimeout(() => { console.error('Competition log check timed out'); app.exit(1) }, 90_000).unref()

async function main() {
  await fs.mkdir(testData, { recursive: true })
  await import(pathToFileURL(path.join(root, 'out/main/index.js')).href)
  let win
  for (let index = 0; index < 180; index++) {
    win = BrowserWindow.getAllWindows()[0]
    if (win && !win.webContents.isLoading() && await win.webContents.executeJavaScript('!!document.querySelector(".experiment-pool-page")')) break
    await delay()
  }
  if (!win || app.getPath('userData') !== testData) throw new Error('Isolated competition application unavailable')
  win.setSize(1440, 1100)
  const run = code => win.webContents.executeJavaScript(code)
  const waitFor = async code => {
    for (let index = 0; index < 150; index++) { if (await run(`Boolean(${code})`)) return; await delay() }
    throw new Error('Timed out: ' + code)
  }
  const click = async (selector, text) => {
    await waitFor(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>${text ? `el.textContent.includes(${JSON.stringify(text)})` : 'true'});return el&&!el.disabled})()`)
    await run(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>${text ? `el.textContent.includes(${JSON.stringify(text)})` : 'true'});el.click()})()`)
    await delay()
  }
  const setPath = async value => {
    await run(`(()=>{const el=document.querySelector('[aria-label="进程日志文件路径"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await delay(); await click('.process-log-path button', '查看日志')
  }
  const handle = (channel, callback) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, (_event, ...args) => callback(...args)) }
  const serverId = randomUUID(), taskId = randomUUID(), runId = randomUUID(), now = new Date().toISOString()
  const server = { id: serverId, name: '参赛版日志验证节点', host: '192.0.2.8', port: 22, username: 'fixture', authType: 'password', hostFingerprint: 'SHA256:fixture', mode: 'real', monitorPolicy: 'manual', hasSecret: false, tags: [], group: '验证', createdAt: now, updatedAt: now }
  const task = { id: taskId, title: '参赛版运行日志验证', project: '', objective: '', tags: [], priority: 'normal', status: 'running', serverId, accessRouteId: 'direct', codePath: '/workspace', dataPath: '', launchCommand: 'python train.py', artifactPath: '', resultSummary: '', notes: '', archived: false, createdAt: now, updatedAt: now,
    runs: [{ id: runId, number: 1, status: 'running', serverId, accessRouteId: 'direct', codePath: '/workspace', logPath: '/runs/fixture/stdout.log', startedAt: now, queuedAt: now, resultSummary: '', notes: '' }] }
  const gpu = { index: 0, uuid: 'GPU-fixture', name: 'NVIDIA RTX 4090', memoryTotalMiB: 24576, memoryUsedMiB: 1024, utilizationPercent: 20, temperatureC: 40, powerW: 100, powerLimitW: 450, fanPercent: 20, performanceState: 'P0', processes: [{ pid: 42, username: 'fixture', processName: 'python train.py', memoryUsedMiB: 1024, elapsedSeconds: 120 }] }
  const snapshot = { serverId, status: 'online', cached: false, gpus: [gpu], fileSystems: [], sampledAt: now, latencyMs: 1, uptimeSeconds: 1000, loadAverage: null, cpuUsagePercent: 1, memoryUsedBytes: null, memoryTotalBytes: null }
  const settings = await run('window.labApi.settings.get()')
  handle('settings:get', () => ({ ...settings, monitoringEnabled: false }))
  handle('servers:list', () => [server]); handle('experiments:list', () => [task])
  handle('monitor:cachedSnapshots', () => ({ [serverId]: snapshot })); handle('monitor:snapshot', () => snapshot); handle('monitor:gpuHistory', () => [])
  handle('intelligence:settings', () => ({ enabled: false, endpoint: 'http://127.0.0.1:1/v1', model: 'fixture', hasApiKey: false }))
  handle('intelligence:history', () => []); handle('research:list', () => []); handle('research:engine', () => ({ available: false, message: 'fixture' }))
  handle('experiments:readRunLog', () => { state.taskReads++; return { text: '任务池输出\nEpoch 1 loss=0.42\n', missing: false, truncated: false, fetchedAt: now } })
  handle('processLogs:inspect', target => {
    state.inspections.push(target)
    return { bootId: 'boot-fixture', startTicks: '12345', cwd: '/workspace', stdoutTarget: state.manual ? '/dev/pts/3' : '/logs/train.log', stderrTarget: state.manual ? 'pipe:[123]' : '/logs/error.log', sources: state.manual ? [] : [{ path: '/logs/train.log', label: '标准输出' }, { path: '/logs/error.log', label: '错误输出' }] }
  })
  handle('processLogs:read', input => {
    state.reads.push(input)
    return { text: state.reused ? 'WRONG-PROCESS' : `PID ${input.pid}\n${input.logPath}\n` + Array.from({ length: 60 }, (_, index) => `Epoch ${index + 1} loss=${(1 / (index + 1)).toFixed(4)}`).join('\n'), missing: false, truncated: false, fetchedAt: now, processRunning: state.running && !state.reused, processIdentityChanged: state.reused }
  })
  win.webContents.reload()
  await waitFor('document.querySelector(".experiment-pool-table")')
  await click('.experiment-pool-table .wb-text-button', task.title)
  await waitFor('document.querySelector(".experiment-log-output")?.textContent.includes("任务池输出")')
  console.log('PASS: competition experiment task pool log panel with actual preload IPC')
  await click('[role="tab"]', 'GPU 实时进程')
  await click('.my-task-log-actions button', '实时日志')
  await waitFor('document.querySelector(".process-log-view .experiment-log-output")?.textContent.includes("/logs/train.log")')
  assert.equal(state.inspections[0].serverId, serverId)
  assert.equal(state.inspections[0].accessRouteId, 'direct')
  assert.equal(state.reads[0].startTicks, '12345')
  await delay(2200); assert.ok(state.reads.length >= 2)
  await click('.process-log-sources button', '错误输出')
  await waitFor('document.querySelector(".process-log-view .experiment-log-output")?.textContent.includes("/logs/error.log")')
  console.log('PASS: competition GPU live process entry, stdout/stderr sources and automatic refresh')
  await click('.process-log-view .experiment-log-controls button', '暂停刷新')
  const pausedReads = state.reads.length; await delay(2200); assert.equal(state.reads.length, pausedReads)
  await click('.process-log-view .experiment-log-controls button', '继续刷新')
  await setPath('/workspace/custom train.log')
  await waitFor('document.querySelector(".process-log-view .experiment-log-output")?.textContent.includes("custom train.log")')
  await run('document.querySelector(".process-log-view").scrollIntoView({block:"center"})'); await delay(250)
  await fs.writeFile(path.join(testData, 'competition-gpu-process-logs.png'), (await win.webContents.capturePage()).toPNG())
  console.log('PASS: pause/resume and manual log file')
  state.reused = true
  await waitFor('document.querySelector(".process-log-view .experiment-log-state")?.textContent.includes("运行已结束")')
  assert.equal(await run('document.querySelector(".process-log-view .experiment-log-output").textContent.includes("WRONG-PROCESS")'), false)
  const endedReads = state.reads.length; await delay(2200); assert.equal(state.reads.length, endedReads)
  state.reused = false
  await click('[aria-label="关闭进程日志"]')
  state.manual = true
  await click('.my-task-log-actions button', '实时日志')
  await waitFor('document.querySelector(".process-log-help")?.textContent.includes("无法补读")')
  await setPath('/workspace/self-written.log')
  await waitFor('document.querySelector(".process-log-view .experiment-log-output")?.textContent.includes("self-written.log")')
  await click('.workbench-modulebar button', '资源')
  const hiddenReads = state.reads.length; await delay(2200); assert.equal(state.reads.length, hiddenReads)
  await click('.workbench-modulebar button', '实验任务')
  await click('.my-task-log-actions .icon-button')
  state.manual = false
  await click('.gpu-process-actions .gpu-log-action')
  await waitFor('document.querySelector(".wb-device-page .process-log-view .experiment-log-output")?.textContent.includes("/logs/train.log")')
  console.log('PASS: PID reuse protection, terminal/pipe manual fallback, hidden page stops polling and GPU detail entry')
  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(root, 'artifacts', 'realtime-log-verification.json'), JSON.stringify({ status: 'passed', root, testData, fixtureSSH: true, taskReads: state.taskReads, processReads: state.reads.length }, null, 2))
  console.log(JSON.stringify({ status: 'passed', root, testData }))
  app.exit(0)
}
main().catch(async error => {
  console.error(error)
  const win = BrowserWindow.getAllWindows()[0]
  if (win) { console.error(await win.webContents.executeJavaScript('document.body.innerText.slice(-8000)')); await fs.writeFile(path.join(testData, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  app.exit(1)
})
