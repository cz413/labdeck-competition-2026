const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'src/main/parameter-bridge.test.ts'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, LABDECK_REQUIRE_CANGJIE: '1' }
})
if (result.error) console.error(result.error.message)
process.exitCode = result.status === 0 ? 0 : 1