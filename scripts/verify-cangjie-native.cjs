const { spawnSync } = require('node:child_process')
const path = require('node:path')
const directory = path.resolve(process.argv[2] || path.join(__dirname, '../resources/cangjie'))
const executable = path.join(directory, 'parameter-engine.exe')
const env = { ...process.env }
delete env.CANGJIE_HOME
// Run without the SDK search path so deployment really uses local components.
env.PATH = directory + path.delimiter + path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
function run(input) {
  const result = spawnSync(executable, [], { cwd: directory, input, env, windowsHide: true, timeout: 10000, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status === null || result.status > 1) throw new Error(`Native startup failed: ${result.status} ${result.stderr}`)
  return result
}
try {
  for (const source of ['python\ttrain.py', 'python\ttrain.py\t--lr=0.01', 'python\ttrain.py\t--lr\t0.01']) {
    const result = run(`4\n${source}\n--lr\t0.001\t0.001\t0.0001\n--seed\t42\t43\n`)
    if (result.status !== 0) throw new Error(result.stderr)
    const output = JSON.parse(result.stdout)
    const equals = source.includes('--lr=')
    const expected = ['0.001', '0.0001'].flatMap(lr => ['42', '43'].map(seed => `python train.py --lr${equals ? '=' : ' '}${lr} --seed ${seed}`))
    if (output.version !== '1' || output.count !== 4 || JSON.stringify(output.commands) !== JSON.stringify(expected)) throw new Error('Native protocol output mismatch')
  }
  const exceeded = run('1\npython\ttrain.py\n--seed\t1\t2\n')
  if (exceeded.status !== 1 || !exceeded.stderr.includes('budget')) throw new Error('Native budget enforcement failed')
  const invalid = run('1\npython\ttrain.py\n--seed\tunsafe;command\n')
  if (invalid.status !== 1 || !invalid.stderr.includes('Unsafe')) throw new Error('Native input validation failed')
  console.log('Native Cangjie passed: expansion, replacement, deduplication, budget, invalid input; SDK not required.')
} catch (error) { console.error(error.message); process.exitCode = 1 }
