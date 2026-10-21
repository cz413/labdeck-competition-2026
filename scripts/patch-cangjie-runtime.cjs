// ABI-preserving backport of the official Windows loader fix (#920).
// Upstream: d28cbe02df27c53e278d69a26d9c326ba99bffc2.
// Only the exact bundled Cangjie 1.0.5 Windows x64 runtime is accepted.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const ORIGINAL = '14ff79293be6328393a0bee5d3d69b3023f3ba1bcac7cebda2dceb35b98cac6a'
const upstream = 'https://github.com/cangjielanguage/cangjie_runtime/commit/d28cbe02df27c53e278d69a26d9c326ba99bffc2'
const sha = data => createHash('sha256').update(data).digest('hex')

function patchedRuntime(original) {
  if (sha(original) !== ORIGINAL) throw new Error('Unsupported runtime SHA256; refusing to patch a different SDK or modified DLL')
  const data = Buffer.from(original), pe = data.readUInt32LE(60), optional = pe + 24
  if (data.toString('ascii', pe, pe + 4) !== 'PE\0\0' || data.readUInt16LE(pe + 4) !== 0x8664 || data.readUInt16LE(optional) !== 0x20b) throw new Error('Expected a Windows x64 PE runtime')
  // This is a local compatibility build, not an official signed binary. Clear
  // the certificate directory instead of retaining a now-invalid vendor signature.
  data.fill(0, optional + 112 + 4 * 8, optional + 112 + 5 * 8)
  const table = optional + data.readUInt16LE(pe + 20), sections = []
  for (let i = 0; i < data.readUInt16LE(pe + 6); i++) {
    const p = table + 40 * i
    sections.push({ rva: data.readUInt32LE(p + 12), size: data.readUInt32LE(p + 16), offset: data.readUInt32LE(p + 20), flags: data.readUInt32LE(p + 36) })
  }
  const offset = rva => {
    const section = sections.find(s => rva >= s.rva && rva < s.rva + s.size)
    if (!section) throw new Error('Runtime export is outside mapped file sections')
    return section.offset + rva - section.rva
  }
  const exports = offset(data.readUInt32LE(optional + 112)), count = data.readUInt32LE(exports + 24)
  const functions = offset(data.readUInt32LE(exports + 28)), names = offset(data.readUInt32LE(exports + 32)), ordinals = offset(data.readUInt32LE(exports + 36))
  const find = name => {
    for (let i = 0; i < count; i++) {
      const p = offset(data.readUInt32LE(names + i * 4)), end = data.indexOf(0, p)
      if (data.toString('ascii', p, end) === name) return data.readUInt32LE(functions + 4 * data.readUInt16LE(ordinals + i * 2))
    }
    throw new Error('Required runtime export missing: ' + name)
  }
  const from = find('_ZN12MapleRuntime16WinModuleManager19ReadWinModuleAtInitEv')
  const to = find('_ZN12MapleRuntime16WinModuleManager22ReadWinModuleAtRunningEv')
  const section = sections.find(s => from >= s.rva && from + 5 <= s.rva + s.size && to >= s.rva && to < s.rva + s.size)
  if (!section || !(section.flags & 0x20000000)) throw new Error('Both functions must be in the same executable section')
  // x64 member functions use the same RCX this pointer. A tail jump preserves
  // the caller stack and delegates to the existing Win32 API implementation,
  // exactly as ReadWinModuleAtInit(){ ReadWinModuleAtRunning(); } upstream.
  const p = offset(from)
  data[p] = 0xe9
  data.writeInt32LE(to - from - 5, p + 1)
  // Upstream also stores the base module name, not its full path, because the
  // unwinder looks up names such as ntdll.dll. Keep stack slots/unwind metadata
  // unchanged and select the existing moduleName string instead of moduleFName.
  const nameOffset = offset(0x1a874)
  const oldName = Buffer.from('f6457001488d55717407488b9580000000', 'hex')
  const newName = Buffer.from('f6455001488d55517407488b9560000000', 'hex')
  if (!data.subarray(nameOffset, nameOffset + oldName.length).equals(oldName)) throw new Error('Module name selection does not match the pinned runtime')
  newName.copy(data, nameOffset)
  return { data, from, to, offset: p }
}

function patchRuntime(file, check = false) {
  const installed = fs.readFileSync(file)
  // Restore only the known entry bytes to identify an already patched file;
  // all other bytes must still match the pinned original hash.
  const restored = Buffer.from(installed)
  const entryOffset = 0x19220
  const originalEntry = Buffer.from('5541574156', 'hex')
  if (originalEntry.length !== 5) throw new Error('Missing pinned entry bytes')
  originalEntry.copy(restored, entryOffset)
  Buffer.from('00681200c8170000', 'hex').copy(restored, 0x128)
  Buffer.from('f6457001488d55717407488b9580000000', 'hex').copy(restored, 0x19c74)
  const result = patchedRuntime(sha(installed) === ORIGINAL ? installed : restored)
  if (result.offset !== entryOffset) throw new Error('Unexpected pinned export offset')
  if (sha(installed) !== ORIGINAL && !installed.equals(result.data)) throw new Error('DLL differs from both the original and the expected compatibility backport')
  if (check && !installed.equals(result.data)) throw new Error('Runtime needs the Windows loader compatibility backport')
  if (!check && !installed.equals(result.data)) fs.writeFileSync(file, result.data)
  return { sdk: '1.0.5', fix: 'windows-loader-920', upstream, localUnsignedBackport: true, originalSha256: ORIGINAL, patchedSha256: sha(result.data), initRva: result.from, runningRva: result.to }
}

if (require.main === module) {
  const file = process.argv.find(a => a.endsWith('.dll')) || path.resolve(__dirname, '../resources/cangjie/libcangjie-runtime.dll')
  try { console.log(JSON.stringify(patchRuntime(file, process.argv.includes('--check')), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { patchRuntime }
