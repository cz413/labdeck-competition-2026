const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const delay = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms))
app.disableHardwareAcceleration()
app.setPath('userData', path.join(root, 'artifacts', 'theme-persistence-' + process.pid))
setTimeout(() => { console.error('Theme persistence verification timed out'); app.exit(1) }, 90_000).unref()

// Keep this fixture in the renderer so reloads exercise settings hydration.
function installFixture(api) {
  let stored = JSON.parse(localStorage.getItem('theme-test-settings') || 'null')
  const initialGet = api.settings.get
  const state = { calls: [], hold: false, fail: false, pending: [], requestClose: null }
  const persist = () => localStorage.setItem('theme-test-settings', JSON.stringify(stored))
  api.settings.get = async () => {
    if (!stored) { stored = await initialGet(); persist() }
    return structuredClone(stored)
  }
  api.settings.save = async patch => {
    state.calls.push(structuredClone(patch))
    if (state.fail) { state.fail = false; throw new Error('模拟保存失败') }
    stored = { ...stored, ...patch }
    persist()
    const response = structuredClone(stored)
    if (state.hold) { state.hold = false; return new Promise(resolve => state.pending.push(() => resolve(response))) }
    return response
  }
  api.windowControls.onCloseRequested = callback => { state.requestClose = callback; return () => { state.requestClose = null } }
  api.windowControls.resolveCloseAction = async (action, remember) => {
    if (remember && action !== 'cancel') { stored.closeBehavior = action; persist() }
    const response = structuredClone(stored)
    if (state.hold) { state.hold = false; return new Promise(resolve => state.pending.push(() => resolve(response))) }
    return response
  }
  state.release = () => state.pending.shift()()
  window.__themeTest = state
}

async function main() {
  await app.whenReady()
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const vite = await createServer({ configFile: false, root: path.join(root, 'src/renderer'), plugins: [
    { name: 'theme-persistence-fixture', enforce: 'pre', transform(source, id) {
      if (id.endsWith('/screenshot-init.ts')) return source.replace("Object.defineProperty(window, 'labApi'", `;(${installFixture.toString()})(api);\nObject.defineProperty(window, 'labApi'`)
    } }, react()], resolve: { alias: { '@shared': path.join(root, 'src/shared') } },
    server: { host: '127.0.0.1', port: 0 } })
  await vite.listen()
  const url = vite.resolvedUrls.local[0] + 'screenshot-harness.html'
  const win = new BrowserWindow({ width: 1440, height: 1000, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message) })
  const run = code => win.webContents.executeJavaScript(code)
  const waitFor = async code => {
    for (let i = 0; i < 100; i++) { if (await run(code)) return; await delay() }
    throw new Error(`Timed out: ${code}`)
  }
  const click = async (selector, text) => {
    await run(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => ${text ? `el.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (!el) throw new Error('Missing: ' + ${JSON.stringify(selector)}); el.click(); })()`)
    await delay()
  }
  const settings = () => click('.workbench-modulebar > button', '设置')
  const selectTheme = theme => click('.theme-option', theme === 'instrument' ? '浅色工作台' : '石墨灰')
  const checkTheme = async theme => {
    assert.equal(await run('document.documentElement.dataset.theme'), theme)
    assert.equal(await run("JSON.parse(localStorage.getItem('theme-test-settings')).theme"), theme)
  }
  const reload = async () => { await win.loadURL(url); await waitFor('window.__captureReady'); await settings() }
  try {
    await reload()
    await selectTheme('instrument')
    await checkTheme('instrument')
    assert.deepEqual(await run('window.__themeTest.calls[0]'), { theme: 'instrument' })
    await click('.workbench-browser-links button', '全部服务器')
    await checkTheme('instrument')
    await reload()
    await checkTheme('instrument')
    console.log('PASS: automatic theme save, navigation and reload')

    await run('window.__themeTest.hold = true')
    await click('.settings-footer button', '保存设置')
    await selectTheme('ocean')
    await run('window.__themeTest.release()')
    await delay()
    await checkTheme('ocean')
    console.log('PASS: delayed settings response preserves newer theme')

    await run('window.__themeTest.requestClose()')
    await delay()
    await run('window.__themeTest.hold = true')
    await click('.close-choice-footer button', '取消')
    await selectTheme('instrument')
    await run('window.__themeTest.release()')
    await delay()
    await checkTheme('instrument')
    console.log('PASS: delayed close response preserves newer theme')

    await click('.workbench-browser-links button', 'GPU 总览')
    await waitFor('document.querySelector(".wb-device-actions button")')
    await run('window.__themeTest.hold = true')
    await click('.wb-device-actions button')
    await settings()
    await selectTheme('ocean')
    await run('window.__themeTest.release()')
    await delay()
    await checkTheme('ocean')
    console.log('PASS: delayed GPU watch response preserves newer theme')

    await run('window.__themeTest.fail = true')
    await selectTheme('instrument')
    await checkTheme('ocean')
    assert.ok(await run('document.body.textContent.includes("模拟保存失败")'))
    await selectTheme('instrument')
    await checkTheme('instrument')
    console.log('PASS: failed theme save reports error, restores theme and allows retry')

    await run('window.__themeTest.hold = true')
    await selectTheme('ocean')
    await selectTheme('instrument')
    await run('window.__themeTest.release()')
    await delay()
    await checkTheme('instrument')
    await reload()
    await checkTheme('instrument')
    console.log('PASS: rapid theme changes and stale replies preserve latest selection')
  } finally {
    win.destroy()
    await vite.close()
  }
  app.exit(0)
}
main().catch(error => { console.error(error); app.exit(1) })
