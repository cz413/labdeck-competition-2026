const { app, BrowserWindow, Notification } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const delay = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
app.disableHardwareAcceleration()
app.setPath('userData', path.join(root, 'artifacts', 'task-notifications-preview'))
setTimeout(() => { console.error('Task notification verification timed out'); app.exit(1) }, 60_000).unref()

function installFixture(api) {
  let watches = []
  const changed = new Set()
  let clicked = () => undefined
  const state = { watched: [], testCount: 0, click: event => clicked(event), saved: null }
  const get = api.settings.get
  api.settings.get = async () => ({ ...await get(), notifyOnTaskEnd: true, processWatches: [] })
  api.settings.save = async patch => { state.saved = patch; return { ...await api.settings.get(), ...patch } }
  api.notifications.onTaskFinished = listener => { clicked = listener; return () => { clicked = () => undefined } }
  api.notifications.onProcessWatchesChanged = listener => { changed.add(listener); return () => changed.delete(listener) }
  api.notifications.listProcessWatches = async () => structuredClone(watches)
  api.notifications.watchProcess = async input => {
    state.watched.push(input)
    watches.push({ ...input, id: 'watch-1', serverName: 'Demo GPU', status: 'watching', createdAt: new Date().toISOString(), checkedAt: new Date().toISOString(), message: '进程仍在运行' })
    changed.forEach(listener => listener())
    return structuredClone(watches)
  }
  api.notifications.unwatchProcess = async id => {
    watches = watches.filter(item => item.id !== id)
    changed.forEach(listener => listener())
    return structuredClone(watches)
  }
  api.notifications.test = async () => { state.testCount++ }
  window.__notificationTest = state
}

async function main() {
  await app.whenReady()
  app.setAppUserModelId('cn.lab.server-manager')
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const vite = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), plugins: [
    { name: 'task-notification-fixture', enforce: 'pre', transform(source, id) {
      if (id.endsWith('/screenshot-init.ts')) return source.replace("Object.defineProperty(window, 'labApi'", `;(${installFixture.toString()})(api);\nObject.defineProperty(window, 'labApi'`)
    } }, react()], resolve: { alias: { '@shared': path.join(root, 'src/shared') } }, server: { host: '127.0.0.1', port: 0 } })
  await vite.listen()
  const win = new BrowserWindow({ width: 1440, height: 1000, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } })
  const errors = []
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const run = code => win.webContents.executeJavaScript(code)
  const waitFor = async code => {
    for (let i = 0; i < 250; i++) { if (await run(code)) return; await delay() }
    throw new Error(`Timed out: ${code}; ${errors.join('\n')}; DOM: ${await run('document.body.innerText.slice(0, 2000)')}`)
  }
  const click = async (selector, text) => {
    await run(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => ${text ? `el.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) throw new Error('Missing button: ' + ${JSON.stringify(selector)}); el.click(); })()`)
    await delay()
  }
  try {
    await win.loadURL(vite.resolvedUrls.local[0] + 'screenshot-harness.html')
    await waitFor('window.__captureReady')
    await click('[aria-label="查看 GPU 0 详情"]')
    await waitFor('document.querySelector(".gpu-process-row .gpu-watch-action")')
    await click('.gpu-process-row .gpu-watch-action', '结束时提醒')
    await waitFor('document.querySelector(".gpu-process-row .gpu-watch-action").textContent.includes("已订阅")')
    assert.equal(await run('window.__notificationTest.watched.length'), 1)
    assert.equal(await run('window.__notificationTest.watched[0].accessRouteId'), 'direct')
    console.log('PASS: subscribe to an existing GPU process')
    win.setSize(1441, 1000); await delay(); win.setSize(1440, 1000); await delay(350)
    await fs.mkdir(path.join(root, 'docs/screenshots'), { recursive: true })
    await fs.writeFile(path.join(root, 'docs/screenshots/task-end-notifications.png'), (await win.webContents.capturePage()).toPNG())
    await click('.workbench-modulebar > button', '设置')
    await waitFor('document.querySelector(".process-watch-item")')
    await click('.task-notification-actions button', '发送测试通知')
    assert.equal(await run('window.__notificationTest.testCount'), 1)
    await click('[aria-label="任务结束 Windows 通知"]')
    await click('.settings-footer button', '保存设置')
    assert.equal(await run('window.__notificationTest.saved.notifyOnTaskEnd'), false)
    await click('.process-watch-item button', '取消提醒')
    await waitFor('!document.querySelector(".process-watch-item")')
    console.log('PASS: manage subscriptions, test notifications and save the notification switch')
    const target = await run('window.__notificationTest.watched[0]')
    await run(`window.__notificationTest.click(${JSON.stringify({ ...target, outcome: 'unknown', title: '进程已结束', serverName: 'Demo GPU', message: '结果未知' })})`)
    await waitFor('document.querySelector(".gpu-process-panel")')
    console.log('PASS: notification click navigates to the GPU detail')
    if (!Notification.isSupported()) throw new Error('Windows native notifications are unavailable')
    const nativeResult = await new Promise(resolve => {
      const notification = new Notification({ title: 'LabDock · 通知测试', body: '任务结束的本地 Windows 通知已接入。', icon: path.join(root, 'resources/labdock-icon.ico') })
      const timer = setTimeout(() => { notification.close(); resolve('no-show-event') }, 6000)
      notification.once('show', () => { clearTimeout(timer); setTimeout(() => notification.close(), 1000); resolve('shown') })
      notification.once('failed', (_event, error) => { clearTimeout(timer); resolve(`failed: ${error}`) })
      notification.show()
    })
    console.log(`Windows notification result: ${nativeResult}`)
    assert.equal(nativeResult, 'shown')
    assert.deepEqual(errors, [])
    console.log('PASS: native Windows notification show event')
  } finally {
    win.destroy()
    await vite.close()
  }
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1) })
