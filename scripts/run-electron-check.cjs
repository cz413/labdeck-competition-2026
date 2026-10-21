const { spawnSync } = require('node:child_process')
const { mkdirSync } = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..'), temporary = path.join(root, '.tmp-build', 'validation')
mkdirSync(temporary, { recursive: true })
const env = { ...process.env, TMP: temporary, TEMP: temporary }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(require('electron'), process.argv.slice(2), { cwd: root, env, stdio: 'inherit', windowsHide: true })
if (result.error) console.error(result.error.message)
process.exitCode = result.status === 0 ? 0 : 1
