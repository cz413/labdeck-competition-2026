const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const output = path.join(root, 'docs', 'screenshots')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
app.disableHardwareAcceleration()
app.setPath('userData', path.join(root, 'artifacts', 'labdock-brand-preview'))
setTimeout(() => { console.error('Brand preview timed out'); app.exit(1) }, 60_000).unref()

async function main() {
  await app.whenReady()
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const vite = await createServer({ configFile: false, root: path.join(root, 'src/renderer'),
    plugins: [react()], resolve: { alias: { '@shared': path.join(root, 'src/shared') } },
    server: { host: '127.0.0.1', port: 0 } })
  await vite.listen()
  const win = new BrowserWindow({ width: 1440, height: 900, frame: false, show: false,
    offscreen: true, icon: path.join(root, 'resources', 'labdock-icon.ico'),
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const errors = []
  win.webContents.on('console-message', event => {
    if (event.level === 'error') errors.push(event.message)
  })
  const run = code => win.webContents.executeJavaScript(code)
  await fs.mkdir(output, { recursive: true })
  for (const [theme, name] of [['ocean', 'dark'], ['instrument', 'light']]) {
    await win.loadURL(vite.resolvedUrls.local[0] + 'screenshot-harness.html?theme=' + theme)
    let ready = false
    for (let i = 0; i < 120; i++) {
      ready = await run(`!!window.__captureReady && [...document.querySelectorAll('.workbench-wordmark img')].length === 2 && [...document.querySelectorAll('.workbench-wordmark img')].every(img => img.complete && img.naturalWidth > 0)`)
      if (ready) break
      await delay(100)
    }
    if (!ready) throw new Error('Preview did not render')
    await run('document.fonts.ready')
    await delay(300)
    win.setSize(1441, 900)
    await delay(100)
    win.setSize(1440, 900)
    await delay(250)
    const brand = await run(`(() => {
      const el = document.querySelector('.workbench-wordmark'); const imgs = [...el.querySelectorAll('img')];
      const visible = imgs.filter(img => getComputedStyle(img).display !== 'none'); const img = visible[0];
      return { title: document.title, name: el.textContent, width: img.naturalWidth,
        visibleMarks: visible.length, markTheme: img.classList.contains('dark') ? 'dark' : 'light',
        theme: document.documentElement.dataset.theme, overflow: el.scrollWidth > el.clientWidth,
        appOverflow: document.querySelector('.workbench-main').scrollWidth > document.querySelector('.workbench-main').clientWidth };
    })()`)
    if (brand.width === 0 || brand.visibleMarks !== 1 || brand.markTheme !== name || brand.overflow || brand.appOverflow || brand.title !== 'LabDock · 实验坞' || brand.theme !== theme) {
      throw new Error('Invalid brand preview: ' + JSON.stringify(brand))
    }
    await fs.writeFile(path.join(output, `labdock-preview-${name}.png`), (await win.webContents.capturePage()).toPNG())
    console.log('Captured ' + name + ': ' + JSON.stringify(brand))
  }
  // Check switching themes on an already-open window as well as initial hydration.
  for (const [theme, variant] of [['ocean', 'dark'], ['instrument', 'light']]) {
    await run(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
    const visible = await run(`(() => { const imgs = [...document.querySelectorAll('.workbench-wordmark img')].filter(img => getComputedStyle(img).display !== 'none'); return imgs.length === 1 && imgs[0].classList.contains(${JSON.stringify(variant)}); })()`)
    if (!visible) throw new Error('Brand mark did not follow live theme switch')
  }
  const imageUri = async file => 'data:image/svg+xml;base64,' + Buffer.from(await fs.readFile(path.join(root, file))).toString('base64')
  const icon = await imageUri('resources/labdock-icon.svg')
  const light = await imageUri('resources/labdock-mark.svg')
  const dark = await imageUri('resources/labdock-mark-dark.svg')
  const previous = await imageUri('docs/branding/labdock-v1-icon.svg')
  // Inspect desktop icons and transparent UI marks independently at tiny sizes.
  const sizeRow = (uri, bg, color, label) => `<div style="padding:22px 40px;background:${bg};color:${color}"><p style="margin:0 0 10px">${label}</p><div style="display:flex;gap:48px;align-items:center">${[16,24,32,48,64,128].map(size => `<div style="text-align:center"><img src="${uri}" width="${size}" height="${size}"><p>${size} px</p></div>`).join('')}</div></div>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;font:16px Segoe UI;background:#f4f6f7;color:#263238">${sizeRow(icon, '#f4f6f7', '#263238', '桌面与托盘图标')}${sizeRow(light, '#edf1f2', '#263238', '浅色主题标志')}${sizeRow(dark, '#25282b', '#edf1f5', '深色主题标志')}</body></html>`))
  await delay(300)
  await fs.writeFile(path.join(output, 'labdock-icon-sizes.png'), (await win.webContents.capturePage()).toPNG())
  win.setSize(1120, 720)
  const titlebar = (uri, bg, text, muted) => `<div style="height:42px;display:flex;align-items:center;gap:8px;padding:0 16px;background:${bg};color:${text}"><img src="${uri}" width="20" height="20"><strong style="font-size:11px;font-weight:600">LabDock</strong><span style="font-size:11px;color:${muted}">实验坞</span></div>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html lang="zh-CN"><body style="margin:0;font-family:Segoe UI,Microsoft YaHei UI,sans-serif;background:#f4f6f7;color:#263238"><main style="padding:40px 64px"><h1 style="font-size:25px;font-weight:600;margin:0">LabDock · 实验坞</h1><p style="color:#52636d;margin:10px 0 28px;font-size:14px">减轻底座，增加留白，让标志融入工作区。</p><div style="display:flex;gap:40px;text-align:center"><div style="flex:1;background:white;padding:20px"><img src="${previous}" width="200" height="200"><p style="margin:8px 0;color:#52636d;font-size:14px">之前</p></div><div style="flex:1;background:white;padding:20px"><img src="${icon}" width="200" height="200"><p style="margin:8px 0;color:#263238;font-size:14px">打磨后</p></div></div><div style="display:flex;gap:40px;margin-top:30px"><div style="flex:1"><p style="font-size:14px">深色标题栏</p>${titlebar(dark, '#25282b', '#edf1f5', '#b5bfc8')}<div style="background:#202225;padding:22px;text-align:center"><img src="${dark}" width="64" height="64"></div></div><div style="flex:1"><p style="font-size:14px">浅色标题栏</p>${titlebar(light, '#edf1f2', '#263238', '#52636d')}<div style="background:white;padding:22px;text-align:center"><img src="${light}" width="64" height="64"></div></div></div></main></body></html>`))
  await delay(300)
  await fs.writeFile(path.join(output, 'labdock-brand-refinement.png'), (await win.webContents.capturePage()).toPNG())
  if (errors.length) throw new Error('Renderer errors: ' + errors.join('\n'))
  win.destroy()
  await vite.close()
  app.exit(0)
}
main().catch(error => { console.error(error); app.exit(1) })
