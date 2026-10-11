const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
app.disableHardwareAcceleration()
app.setPath('userData', path.join(root, 'artifacts', 'script-task-preview-profile'))
setTimeout(() => { console.error('Script task verification timed out'); app.exit(1) }, 60_000).unref()
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
  const run = async code => { try { return await win.webContents.executeJavaScript(code) } catch (error) { console.error(code, errors); throw error } }
  const waitFor = async code => {
    for (let i = 0; i < 100; i++) { if (await run(code)) return; await delay(100) }
    throw new Error(`Timed out: ${code}`)
  }
  const check = async (code, label) => { if (!await run(code)) throw new Error(label); console.log(`Passed: ${label}`) }
  const click = async (selector, text) => {
    await run(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => ${text ? `el.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) throw new Error('Missing button'); el.click() })()`)
    await delay()
  }
  const fill = async (selector, value) => {
    await run(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await delay()
  }
  const select = async (selector, value) => {
    await run(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`)
    await delay()
  }
  const capture = async name => {
    win.setSize(1441, 1000); await delay(); win.setSize(1440, 1000); await delay(350)
    await fs.writeFile(path.join(root, 'docs', 'screenshots', name), (await win.webContents.capturePage()).toPNG())
  }
  await fs.mkdir(path.join(root, 'docs', 'screenshots'), { recursive: true })
  await win.loadURL(vite.resolvedUrls.local[0] + 'screenshot-harness.html')
  await waitFor('window.__captureReady && document.querySelector(".wb-gpu-inspector > button")')
  await click('.wb-gpu-inspector > button')
  await waitFor('document.querySelector(".experiment-editor")')
  await fill('.app-modal input', 'SH 脚本验证')
  await select('[aria-label="任务启动方式"]', 'script')
  await fill('[aria-label="任务脚本路径"]', '/home/researcher/my project/train.sh')
  await check('!document.querySelector(".experiment-command-input") && document.querySelector("input[placeholder=留空使用脚本所在目录]").value === ""', 'script mode needs no command or working directory')
  await run('document.querySelector("[aria-label=任务脚本路径]").scrollIntoView({ block: "center" })')
  await delay()
  await capture('task-sh-support.png')
  await click('.app-modal .secondary-button', '保存草稿')
  await waitFor('!document.querySelector(".app-modal")')
  await click('.experiment-pool-table .wb-text-button', 'SH 脚本验证')
  await click('.experiment-task-card button', '编辑')
  await waitFor('document.querySelector("[aria-label=任务脚本路径]")')
  await check('document.querySelector("[aria-label=任务启动方式]").value === "script" && document.querySelector("[aria-label=任务脚本路径]").value === "/home/researcher/my project/train.sh"', 'editing restores script mode and path')
  await click('.app-modal .secondary-button', '取消')
  await click('.experiment-task-card .primary-button', '加入队列')
  await waitFor('document.querySelector("[aria-label=本次脚本路径]")')
  await check('document.querySelector("[aria-label=本次启动方式]").value === "script" && !document.querySelector(".experiment-command-input")', 'run dialog restores script launch mode')
  await fill('[aria-label="本次脚本路径"]', '/home/researcher/my project/retry.sh')
  await click('.app-modal .primary-button')
  await waitFor('window.__labPreview.startedRuns.length === 1')
  await check('window.__labPreview.startedRuns[0].launchMode === "script" && window.__labPreview.startedRuns[0].scriptPath === "/home/researcher/my project/retry.sh" && window.__labPreview.startedRuns[0].launchCommand === "" && window.__labPreview.startedRuns[0].codePath === ""', 'queue receives script path without command or code directory')
  if (errors.length) throw new Error(errors.join('\n'))
  win.close(); await vite.close(); app.quit()
}
main().catch(error => { console.error(error); app.exit(1) })
