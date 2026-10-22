import { applyAccessRoute, getAccessRoutes, getDefaultAccessRouteId } from '../shared/access-routes'
import { processLogReadSchema, processLogTargetSchema } from '../shared/schemas'
import type { ProcessLogInfo, ProcessLogReadInput, ProcessLogSnapshot, ProcessLogTarget } from '../shared/types'
import type { AppStore } from './store'
import type { SshService } from './ssh-service'
import { parseProcessIdentity } from './process-watch-service'
import { buildLogReadCommand, parseLogOutput, quoteLogPath } from './remote-log'

const EXTRA_MARKER = '__LAB_EXTRA__'
const MAX_SOURCES = 6
const PARENT_DEPTH = 4

function connection(store: AppStore, target: ProcessLogTarget) {
  const server = store.getServer(target.serverId)
  if (server.mode !== 'real') throw new Error('进程日志需要真实服务器')
  const routeId = target.accessRouteId ?? getDefaultAccessRouteId(server)
  if (!getAccessRoutes(server).some(route => route.id === routeId)) throw new Error('SSH 连接路径已不存在')
  return { profile: applyAccessRoute(server, routeId), secrets: store.getSecrets(server.id) }
}

// A job rarely holds its log on fd 1/2: `2>&1 | tee train.log`, a launcher script or
// the trainer's own logging handler are all more common. Only names that look like a
// log are accepted for the higher descriptors so open datasets and checkpoints stay out.
function isLogFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return /log/i.test(name) || /\.(?:txt|out|err|output|jsonl)$/i.test(name)
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export async function inspectProcessLog(store: AppStore, ssh: SshService, raw: ProcessLogTarget): Promise<ProcessLogInfo> {
  const target = processLogTargetSchema.parse(raw)
  const { profile, secrets } = connection(store, target)
  const proc = `/proc/${target.pid}`
  // readlink inspects destinations only. Never read a pipe, socket or terminal FD:
  // doing so could consume output intended for the original program/terminal.
  const command = [
    'cat /proc/sys/kernel/random/boot_id || exit 1',
    `if [ -r ${proc}/stat ]; then cat ${proc}/stat; elif [ -d ${proc} ]; then printf 'unreadable\\n'; else printf 'missing\\n'; fi`,
    `for fd in 1 2; do readlink ${proc}/fd/$fd 2>/dev/null | base64 | tr -d '\\n'; printf '\\n'; if [ -f ${proc}/fd/$fd ]; then printf 'file\\n'; else printf 'other\\n'; fi; done`,
    `readlink ${proc}/cwd 2>/dev/null | base64 | tr -d '\\n'; printf '\\n'`,
    `printf '${EXTRA_MARKER}\\n'`,
    `if [ -r ${proc}/fd ] && [ -x ${proc}/fd ]; then printf 'rights\\tok\\n'; else printf 'rights\\tdenied\\n'; fi`,
    // The process itself, its ancestors up to a few levels and their other children
    // (that is where `tee` sits) are all able to hold the redirect target open.
    // One pid per line, read with `while` and expanded through `$( )`, because zsh
    // neither splits unquoted parameters nor tolerates an unmatched glob.
    `ps -eo pid=,ppid= 2>/dev/null | awk -v root=${target.pid} '{pp[$1]=$2} END{keep[root]=1; cur=root; for(i=0;i<${PARENT_DEPTH};i++){p=pp[cur]; if(p==""||p==0||p==1||p==cur)break; keep[p]=1; cur=p} for(k in pp){if((pp[k] in keep)&&!(k in keep))child[k]=1} for(k in keep)print k; for(k in child)print k}' | while IFS= read -r q; do [ -n "$q" ] || continue; for n in $(ls -1 /proc/$q/fd 2>/dev/null); do f=/proc/$q/fd/$n; [ -f "$f" ] || continue; t=$(readlink "$f" 2>/dev/null) || continue; case "$t" in /*) ;; *) continue;; esac; printf 'fd\\t%s\\t%s\\t' "$q" "$n"; printf '%s' "$t" | base64 | tr -d '\\n'; printf '\\n'; done; done`
  ].join('\n')
  const output = await ssh.runCommand(profile, secrets, command, 10_000)
  const lines = output.split('\n')
  const identity = parseProcessIdentity(lines.slice(0, 2).join('\n'))
  if (!identity || ['Z', 'X'].includes(identity.state)) throw new Error('该进程已结束，请刷新进程列表')
  if (lines.length < 7) throw new Error('进程日志识别响应不完整')
  const decode = (index: number): string => Buffer.from(lines[index], 'base64').toString('utf8').replace(/\n$/, '')
  const stdoutTarget = decode(2)
  const stderrTarget = decode(4)
  const cwd = decode(6)
  const sources: ProcessLogInfo['sources'] = []
  const accept = (path: string, label: string, merge = false): void => {
    if (!path.startsWith('/') || path.endsWith(' (deleted)') || /[\0\r\n]/.test(path)) return
    const existing = sources.find(source => source.path === path)
    if (!existing) {
      if (sources.length < MAX_SOURCES) sources.push({ path, label })
      return
    }
    // Only stdout/stderr labels are combined; an already listed file keeps its name.
    if (merge && !existing.label.split(' / ').includes(label)) existing.label += ` / ${label}`
  }
  if (lines[3] === 'file') accept(stdoutTarget, '标准输出', true)
  if (lines[5] === 'file') accept(stderrTarget, '错误输出', true)
  let note: string | undefined
  const extraStart = lines.indexOf(EXTRA_MARKER)
  if (extraStart >= 0) {
    const found: Array<{ pid: number; fd: number; path: string }> = []
    for (const line of lines.slice(extraStart + 1)) {
      if (!line) continue
      const [kind, first, second, payload] = line.split('\t')
      if (kind === 'rights') {
        if (first === 'denied') note = '无法读取该进程的文件描述符：进程可能属于其他用户，或服务器启用了 hidepid。'
        continue
      }
      if (kind !== 'fd' || !payload) continue
      const path = Buffer.from(payload, 'base64').toString('utf8')
      if (!path.startsWith('/') || path.endsWith(' (deleted)') || /[\0\r\n]/.test(path)) continue
      const pid = Number(first)
      const fd = Number(second)
      if (!Number.isInteger(pid) || !Number.isInteger(fd)) continue
      found.push({ pid, fd, path })
    }
    const own = (item: { pid: number }): number => item.pid === target.pid ? 0 : 1
    const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`
    // Siblings of a job launched from the same shell may each write their own log, so
    // a file inside this process' working directory is the more likely candidate.
    const inside = (item: { path: string }): number => cwd && item.path.startsWith(prefix) ? 0 : 1
    found.sort((a, b) => own(a) - own(b) || inside(a) - inside(b) || a.fd - b.fd || a.pid - b.pid)
    for (const item of found) {
      if (sources.length >= MAX_SOURCES) break
      // fd 1/2 of the process and of the processes that spawned it are the redirect
      // targets; every other descriptor only counts when it is named like a log.
      if (item.fd !== 1 && item.fd !== 2 && !isLogFile(item.path)) continue
      accept(item.path, basename(item.path))
    }
  }
  return { bootId: identity.bootId, startTicks: identity.startTicks, cwd, sources, stdoutTarget, stderrTarget, ...(note ? { note } : {}) }
}

export async function readProcessLog(store: AppStore, ssh: SshService, raw: ProcessLogReadInput): Promise<ProcessLogSnapshot> {
  const input = processLogReadSchema.parse(raw)
  const { profile, secrets } = connection(store, input)
  // Verify boot ID + start time in the same command before following the file.
  // An exited or reused PID stops polling; the viewer keeps the final file snapshot.
  const command = [
    'boot_id=$(cat /proc/sys/kernel/random/boot_id) || exit 1',
    `proc_stat=''; if [ -d /proc/${input.pid} ]; then proc_stat=$(cat /proc/${input.pid}/stat) || exit 1; fi`,
    `running=0; replaced=0; if [ "$boot_id" != ${quoteLogPath(input.bootId)} ]; then replaced=1; elif [ -n "$proc_stat" ]; then fields=${'${proc_stat##*) }'}; set -- $(printf '%s' "$fields" | awk '{print $1, $20}'); state=$1; start=$2; if [ "$start" != ${quoteLogPath(input.startTicks)} ]; then replaced=1; elif [ "$state" != Z ] && [ "$state" != X ]; then running=1; fi; fi`,
    'if [ "$replaced" = 1 ]; then printf \'replaced\\n\'; exit 0; fi',
    'printf \'%s\\n\' "$running"',
    buildLogReadCommand(input.logPath)
  ].join('; ')
  const output = await ssh.runCommand(profile, secrets, command, 10_000)
  if (output === 'replaced\n') return { text: '', missing: false, truncated: false, fetchedAt: new Date().toISOString(), processRunning: false, processIdentityChanged: true }
  if (!/^[01]\n/.test(output)) throw new Error('进程日志响应无效')
  return { ...parseLogOutput(output.slice(2)), processRunning: output.startsWith('1\n') }
}
