const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
app.disableHardwareAcceleration()
app.setPath('userData', path.join(root, 'artifacts', 'gpu-memory-preview-profile'))
setTimeout(() => { console.error('GPU memory verification timed out'); app.exit(1) }, 60_000).unref()
const delay = (ms = 180) => new Promise(resolve => setTimeout(resolve, ms))
async function main() {
  await app.whenReady()
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const vite = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), plugins: [react()],
    resolve: { alias: { '@shared': path.join(root, 'src/shared') } }, server: { host: '127.0.0.1', port: 0 } })
  await vite.listen()
  const win = new BrowserWindow({ width: 1440, height: 1000, show: false, offscreen: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  const errors = []
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const run = async code => {
    try { return await win.webContents.executeJavaScript(code) }
    catch (error) { console.error(code, errors); throw error }
  }
  const waitFor = async code => {
    for (let i = 0; i < 100; i++) { if (await run(code)) return; await delay(100) }
    throw new Error(`Timed out: ${code}`)
  }
  const check = async (code, label) => { if (!await run(code)) throw new Error(label); console.log(`Passed: ${label}`) }
  const click = async (selector, text) => {
    await run(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => ${text ? `el.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) throw new Error('Missing button'); el.click() })()`)
    await delay()
  }
  await win.loadURL(vite.resolvedUrls.local[0] + 'screenshot-harness.html')
  await waitFor('window.__captureReady && document.querySelector(".wb-gpu-table")')
  await run(`(() => {
    const original = window.labApi.monitor.snapshot;
    window.__memoryMode = 'conflict';
    window.labApi.monitor.snapshot = async (...args) => {
      const sample = await original(...args);
      sample.gpus = sample.gpus.map(gpu => gpu.index !== 0 ? gpu : {
        ...gpu, memoryUsedMiB: 27034, memoryTotalMiB: 65536,
        processMemoryInconsistent: window.__memoryMode === 'conflict',
        processes: [
          { pid: 42, username: 'researcher', elapsedSeconds: 3600, processName: 'python train.py', memoryUsedMiB: 1365, memoryUsageUnavailable: window.__memoryMode === 'unknown' },
          { pid: 43, username: 'other', elapsedSeconds: 7200, processName: 'python inference.py', memoryUsedMiB: window.__memoryMode === 'conflict' ? 31846 : 25000 }
        ]
      });
      return sample;
    };
  })()`)
  await click('[aria-label="查看 GPU 0 详情"]')
  await click('.wb-device-header button', '刷新设备')
  await waitFor('document.querySelector(".gpu-process-panel [role=status]")')
  await check('[...document.querySelectorAll(".gpu-process-row strong")].every(el => el.textContent === "待确认")', 'conflicting process numbers are marked pending without changing card memory')
  await check('document.querySelector(".gpu-stat-grid").textContent.includes("26.4 / 64.0 GiB") && document.querySelectorAll(".gpu-process-row").length === 2', 'card measurement and both process records remain visible')
  win.setSize(1441, 1000); await delay(); win.setSize(1440, 1000); await delay(350)
  await fs.mkdir(path.join(root, 'docs', 'screenshots'), { recursive: true })
  await fs.writeFile(path.join(root, 'docs', 'screenshots', 'gpu-memory-consistency.png'), (await win.webContents.capturePage()).toPNG())
  await click('.workbench-modulebar .nav-button', '实验任务')
  await click('.experiment-pool-tabs button', 'GPU 实时进程')
  await check('document.querySelector(".my-task-row").textContent.includes("待确认") && document.querySelector(".my-task-summary").textContent.includes("待确认")', 'task row and memory total also preserve uncertainty')
  await click('.my-task-row')
  await run('window.__memoryMode = "normal"')
  await click('.wb-device-header button', '刷新设备')
  await waitFor('!document.querySelector(".gpu-process-panel [role=status]") && document.querySelector(".gpu-process-row strong")?.textContent === "1.3 GiB"')
  await check('document.querySelectorAll(".gpu-process-row")[1].textContent.includes("24.4 GiB")', 'normal refresh clears pending status and displays valid readings')
  await run('window.__memoryMode = "unknown"')
  await click('.wb-device-header button', '刷新设备')
  await waitFor('document.querySelector(".gpu-process-row strong")?.textContent === "—"')
  await check('!document.querySelector(".gpu-process-panel [role=status]")', 'unavailable process memory is distinct from a consistency conflict')
  if (errors.length) throw new Error(errors.join('\n'))
  win.close(); await vite.close(); app.quit()
}
main().catch(error => { console.error(error); app.exit(1) })
