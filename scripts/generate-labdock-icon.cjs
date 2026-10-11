const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const output = path.resolve(process.argv[2] || path.join(root, 'resources'))
app.disableHardwareAcceleration()
app.setPath('userData', path.join(root, 'artifacts', 'icon-profile'))
setTimeout(() => { console.error('Icon generation timed out'); app.exit(1) }, 30_000).unref()

async function main() {
  await app.whenReady()
  await fs.mkdir(output, { recursive: true })
  const svg = await fs.readFile(path.join(root, 'resources', 'labdock-icon.svg'), 'utf8')
  // Export transparent UI marks from the same geometry as the desktop icon.
  const mark = svg.replace('viewBox="0 0 256 256"', 'viewBox="32 16 200 232"')
    .replace(/  <rect[^\n]+fill="#F6F7F4"\/>\r?\n/, '')
    .replace(/<g transform="[^"]+">/, '<g>')
  await fs.writeFile(path.join(output, 'labdock-mark.svg'), mark)
  await fs.writeFile(path.join(output, 'labdock-mark-dark.svg'), mark
    .replaceAll('#252B30', '#E8EFED')
    .replaceAll('#238B80', '#50B9A7')
    .replaceAll('#54D6B4', '#238B80'))
  const win = new BrowserWindow({ width: 1024, height: 1024, useContentSize: true,
    show: false, offscreen: true, transparent: true, backgroundColor: '#00000000',
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  // Capture at 4x for small-size antialiasing.
  await win.loadFile(path.join(root, 'resources', 'labdock-icon.svg'))
  await win.webContents.executeJavaScript(`document.documentElement.setAttribute('width', '1024'); document.documentElement.setAttribute('height', '1024')`)
  await new Promise(resolve => setTimeout(resolve, 250))
  const source = await win.webContents.capturePage()
  if (source.isEmpty()) throw new Error('SVG capture returned an empty image')
  await fs.writeFile(path.join(output, 'labdock-icon.png'), source.toPNG())
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const entries = sizes.map(size => source.resize({ width: size, height: size, quality: 'best' }).toPNG())
  const header = Buffer.alloc(6 + 16 * entries.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach((png, i) => {
    const entry = 6 + 16 * i
    header[entry] = header[entry + 1] = sizes[i] === 256 ? 0 : sizes[i]
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  const icon = path.join(output, 'labdock-icon.ico')
  await fs.writeFile(icon, Buffer.concat([header, ...entries]))
  if (nativeImage.createFromPath(icon).isEmpty()) throw new Error('Generated ICO cannot be decoded')
  console.log(`Generated ${icon} (${sizes.join(', ')} px) and labdock-icon.png`)
  win.destroy()
  app.exit(0)
}
main().catch(error => { console.error(error); app.exit(1) })
