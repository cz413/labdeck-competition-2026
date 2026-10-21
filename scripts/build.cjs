const { spawnSync } = require('node:child_process')
const { mkdirSync } = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const temporary = path.join(root, '.tmp-build', 'build')
mkdirSync(temporary, { recursive: true })
const env = { ...process.env, TMP: temporary, TEMP: temporary }
delete env.ELECTRON_RUN_AS_NODE
const typescript = require.resolve('typescript/bin/tsc')
const vite = path.join(path.dirname(require.resolve('electron-vite')), '..', 'bin', 'electron-vite.js')
for (const args of [[typescript, '--noEmit', '-p', 'tsconfig.node.json'], [typescript, '--noEmit', '-p', 'tsconfig.web.json'], [vite, 'build']]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true })
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) process.exit(result.status || 1)
}
