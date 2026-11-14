/**
 * Child processes: every child gets its own process group so a kill reaches
 * whatever it spawned, and runs with an environment built from scratch.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { Socket } from 'node:net'

export const KILL_GRACE_MS = 3_000

/** setpriv from util-linux, on the guest rootfs. */
export const SETPRIV = '/usr/bin/setpriv'

/** Spawn options plus the unprivileged user to run as (guest only). */
export type GroupSpawnOptions = SpawnOptions & { asUser?: { uid: number; gid: number } }

/**
 * The command line that drops to `user` (D36): setpriv sets the gid and uid,
 * clears supplementary groups, empties the bounding and inheritable
 * capability sets and sets no_new_privs, so neither a setuid file nor a file
 * capability can give anything back, then execs the command.
 */
export function dropTo(user: { uid: number; gid: number }, command: string, args: string[]): { command: string; args: string[] } {
  return {
    command: SETPRIV,
    args: [
      `--reuid=${user.uid}`, `--regid=${user.gid}`, '--clear-groups',
      '--no-new-privs', '--bounding-set=-all', '--inh-caps=-all', '--',
      command, ...args
    ]
  }
}

export function spawnGroup(command: string, args: string[], options: GroupSpawnOptions): ChildProcess {
  const { asUser, ...rest } = options
  const cmd = asUser ? dropTo(asUser, command, args) : { command, args }
  return spawn(cmd.command, cmd.args, { ...rest, detached: true })
}

/** SIGTERM the group, SIGKILL it after `graceMs` if the leader has not exited. */
export function killGroup(child: ChildProcess, graceMs = KILL_GRACE_MS): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-child.pid!, sig)
    } catch {
      try { child.kill(sig) } catch { /* already gone */ }
    }
  }
  signal('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal('SIGKILL')
  }, graceMs)
  timer.unref()
  child.once('exit', () => clearTimeout(timer))
}

/** Keeps the last `max` lines of a byte stream. */
export class LineTail {
  private lines: string[] = []
  private partial = ''
  constructor(private readonly max = 40) {}
  push(chunk: Buffer | string): void {
    const text = this.partial + chunk.toString()
    const parts = text.split('\n')
    this.partial = parts.pop() ?? ''
    if (this.partial.length > 4096) this.partial = this.partial.slice(-4096)
    this.lines.push(...parts.map((line) => line.slice(0, 4096)))
    if (this.lines.length > this.max) this.lines = this.lines.slice(-this.max)
  }
  text(): string {
    const all = this.partial ? [...this.lines, this.partial] : this.lines
    return all.slice(-this.max).join('\n')
  }
}

/** The extra variable a child of Electron-run-as-Node needs to stay a Node process. */
export function nodeSelfEnv(): Record<string, string> {
  return process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}
}

/** Run to completion, collecting stdout (bounded). Never rejects; `code` null on spawn failure. */
export function runCollect(
  command: string,
  args: string[],
  options: GroupSpawnOptions & { input?: Buffer; timeoutMs?: number; maxBytes?: number }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawnGroup(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      resolve({ code: null, stdout: '', stderr: '' })
      return
    }
    const max = options.maxBytes ?? 1024 * 1024
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < max) stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < max) stderr += d.toString() })
    const timer = options.timeoutMs ? setTimeout(() => killGroup(child, 500), options.timeoutMs) : null
    child.on('error', () => {
      if (timer) clearTimeout(timer)
      resolve({ code: null, stdout, stderr })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input)
  })
}

/**
 * Stream a child's merged stdout+stderr to `socket` (stdin from it when
 * `interactive`); end the socket when the child is done; kill the child when
 * the socket goes away first.
 */
export function bindChild(
  child: ChildProcess,
  socket: Socket,
  interactive: boolean,
  onDone: (code: number | null, signal: string | null) => void
): void {
  let open = 2
  let exit: [number | null, string | null] | null = null
  let finished = false
  const finish = (): void => {
    if (finished || open > 0 || !exit) return
    finished = true
    socket.end()
    onDone(exit[0], exit[1])
  }
  const done = (): void => { open--; finish() }
  for (const out of [child.stdout, child.stderr]) {
    if (!out) { done(); continue }
    out.pipe(socket, { end: false })
    out.on('end', done)
  }
  child.on('error', () => {
    if (!exit) exit = [null, null]
    open = 0
    finish()
  })
  child.on('exit', (code, signal) => { exit = [code, signal]; finish() })
  child.stdin?.on('error', () => {})
  if (interactive && child.stdin) {
    socket.pipe(child.stdin)
  } else {
    child.stdin?.end()
    socket.resume()
  }
  socket.on('close', () => { if (!exit) killGroup(child) })
}
