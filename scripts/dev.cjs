#!/usr/bin/env node
// Start electron-vite dev with a clean Electron environment.
// - Clears ELECTRON_RUN_AS_NODE inherited from some integrated terminals.
// - Retries once with --noSandbox when Chromium's sandbox cannot start.
// Data-directory fallback is handled by the main process itself, so it also
// works when the app is started from a packaged build or another launcher.
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const root = resolve(__dirname, '..')

if (process.env.ELECTRON_RUN_AS_NODE) {
  console.log('[dev] 已清除继承的 ELECTRON_RUN_AS_NODE（否则 Electron 会以纯 Node 运行）。')
  delete process.env.ELECTRON_RUN_AS_NODE
}

const entry = join(dirname(require.resolve('electron-vite', { paths: [root] })), '..', 'bin', 'electron-vite.js')
if (!existsSync(entry)) {
  console.error(`[dev] 找不到 electron-vite 入口：${entry}。请先执行 npm ci。`)
  process.exit(1)
}

function run(extra) {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, [entry, 'dev', ...extra], { cwd: root, env: process.env, stdio: 'inherit' })
    child.on('error', error => {
      console.error(`[dev] 无法启动 electron-vite：${error.message}`)
      resolveRun(1)
    })
    child.on('exit', (code, signal) => resolveRun(signal ? 1 : code ?? 1))
  })
}

async function main() {
  const extra = process.argv.slice(2)
  const sandboxDisabled = extra.includes('--noSandbox') || extra.includes('--no-sandbox')
  let code = await run(extra)
  if (!sandboxDisabled && [0x80000003, 0xc0000005].includes(code >>> 0)) {
    console.error('[dev] Electron 沙箱初始化失败，自动改用 --noSandbox 重试一次…')
    code = await run([...extra, '--noSandbox'])
  }
  if (code !== 0) {
    const unsigned = code >>> 0
    console.error(`[dev] 启动失败，退出码 ${code}（0x${unsigned.toString(16)}）。`)
    if (unsigned === 0x80000003 || unsigned === 0xc0000005) {
      console.error('[dev] Electron 在窗口初始化阶段退出。请在普通桌面终端中运行 npm run dev；')
      console.error('       若当前环境禁止 Chromium 沙箱，可改用 npm run dev:nosandbox 再试。')
    }
  }
  process.exit(code)
}

void main()
