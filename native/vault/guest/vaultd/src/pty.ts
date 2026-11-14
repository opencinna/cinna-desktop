/**
 * The terminal's window size (`exec.resize`). The `shell` preset runs bash
 * under script(1), whose stdin is a pipe, so script never sizes the pty it
 * makes: the size comes from here. In the guest vaultd is root, finds the
 * pty slave the shell sits on (script's child's stdin, `/dev/pts/<n>`) and
 * runs `stty -F /dev/pts/<n> rows R cols C`; setting the size on the slave
 * makes the kernel SIGWINCH the shell's foreground group, so the prompt,
 * wrapping, less and vim follow.
 *
 * The last size asked for is kept, and applied as soon as the pty exists
 * (the stream may be resized before it is attached, or before script has
 * forked the shell). Fake mode and any other OS: nothing is applied (BSD
 * script on macOS and a test host's shell are not ours to size); the call
 * still validates and answers {}.
 */
import { readdirSync, readFileSync, readlinkSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { VAULT_TERMINAL_COLS, VAULT_TERMINAL_ROWS } from '../../../../../src/shared/vault/protocol'
import type { Ctx, Params } from './context'
import { runCollect } from './procs'
import { invalid, log, VaultdError } from './util'

export interface PtySize { cols: number; rows: number }

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))

/** `cols`/`rows` as integers, clamped; `invalid` for anything else. */
export function ptySize(params: Params): PtySize {
  const { cols, rows } = params
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw invalid('Invalid size.')
  return {
    cols: clamp(cols as number, VAULT_TERMINAL_COLS.min, VAULT_TERMINAL_COLS.max),
    rows: clamp(rows as number, VAULT_TERMINAL_ROWS.min, VAULT_TERMINAL_ROWS.max)
  }
}

/** The optional initial size on `exec`: null when neither is given. */
export function optionalPtySize(params: Params): PtySize | null {
  return params.cols === undefined && params.rows === undefined ? null : ptySize(params)
}

/** What sizing a pty takes; null where vaultd sizes nothing (fake mode, not Linux). */
export interface PtyOps {
  /** The pty slave the shell started by `pid` (script) reads from, or null while there is none yet. */
  findPts(pid: number): string | null
  /** Set the slave's window size as `asUser` (the shell's owner); false if it did not take. */
  setSize(pts: string, size: PtySize, path: string, asUser?: { uid: number; gid: number }): Promise<boolean>
}

const PTS = /^\/dev\/pts\/\d+$/

/**
 * Direct children of `pid`: `/proc/<pid>/task/<tid>/children` when the kernel has it, else a scan of `stat` ppids.
 * The guest kernel (Alpine linux-virt) has CONFIG_PROC_CHILDREN=y, so the synchronous scan is only a fallback.
 */
export function childPids(procRoot: string, pid: number): number[] {
  const out = new Set<number>()
  let viaChildren = false
  try {
    const tasks: Dirent[] = readdirSync(join(procRoot, String(pid), 'task'), { withFileTypes: true })
    for (const task of tasks) {
      try {
        const text = readFileSync(join(procRoot, String(pid), 'task', task.name, 'children'), 'utf8')
        viaChildren = true
        for (const part of text.split(/\s+/)) if (/^\d+$/.test(part)) out.add(Number(part))
      } catch { /* no children file: the scan below */ }
    }
  } catch { /* the process is gone, or no task dir */ }
  if (viaChildren) return [...out]
  let entries: Dirent[] = []
  try {
    entries = readdirSync(procRoot, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue
    try {
      // `pid (comm) state ppid …`; comm may hold spaces and parentheses, so read after the last one.
      const stat = readFileSync(join(procRoot, entry.name, 'stat'), 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1])
      if (ppid === pid) out.add(Number(entry.name))
    } catch { /* gone meanwhile */ }
  }
  return [...out]
}

/** The `/dev/pts/<n>` one of `pid`'s children has on fd 0, checked to be exactly that shape. */
export function findShellPts(procRoot: string, pid: number): string | null {
  for (const child of childPids(procRoot, pid)) {
    try {
      const target = readlinkSync(join(procRoot, String(child), 'fd', '0'))
      if (PTS.test(target)) return target
    } catch { /* gone, or not readable */ }
  }
  return null
}

export const linuxPtyOps: PtyOps = {
  findPts: (pid) => findShellPts('/proc', pid),
  async setSize(pts, size, path, asUser) {
    if (!PTS.test(pts)) return false
    // As the shell's own user, never root: the agent may have pointed the shell's
    // fd 0 at a pty it opened, and setting a window size needs no privilege.
    const res = await runCollect('stty', ['-F', pts, 'rows', String(size.rows), 'cols', String(size.cols)], {
      env: { PATH: path }, timeoutMs: 2_000, ...(asUser ? { asUser } : {})
    })
    return res.code === 0
  }
}

/** The ops for this vaultd: Linux sizes the guest's pty; fake mode and other OSes size nothing. */
export function ptyOpsFor(fake: boolean): PtyOps | null {
  return !fake && process.platform === 'linux' ? linuxPtyOps : null
}

/** How long to look for the pty after a size is asked for before giving up until the next ask. */
const FIND_TRIES = 40
const FIND_EVERY_MS = 50

/**
 * One shell's size: the last one asked for, applied once (and again on each
 * change) when the shell's pty can be found.
 */
export class ShellPty {
  private desired: PtySize | null
  private applied: PtySize | null = null
  private pid: number | null = null
  private ended = false
  private running = false

  constructor(
    private readonly ops: PtyOps | null,
    private readonly path: string,
    initial: PtySize | null,
    private readonly asUser?: { uid: number; gid: number }
  ) {
    this.desired = initial
  }

  resize(size: PtySize): void {
    this.desired = size
    void this.apply()
  }

  started(pid: number | undefined): void {
    if (pid === undefined) return
    this.pid = pid
    void this.apply()
  }

  end(): void {
    this.ended = true
  }

  /** For tests: resolves once nothing is being applied. */
  idle(): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => { if (!this.running) resolve(); else setTimeout(check, 10) }
      check()
    })
  }

  private async apply(): Promise<void> {
    if (this.running || !this.ops) return
    this.running = true
    try {
      let tries = 0
      while (!this.ended && this.pid !== null && this.desired && !same(this.desired, this.applied)) {
        const pts = this.ops.findPts(this.pid)
        if (!pts) {
          if (++tries >= FIND_TRIES) break
          await new Promise((resolve) => setTimeout(resolve, FIND_EVERY_MS))
          continue
        }
        const size = this.desired
        if (await this.ops.setSize(pts, size, this.path, this.asUser)) this.applied = size
        else break
      }
    } catch {
      log('warn', 'terminal resize failed')
    } finally {
      this.running = false
    }
  }
}

const same = (a: PtySize | null, b: PtySize | null): boolean => !!a && !!b && a.cols === b.cols && a.rows === b.rows

/** `exec.resize {stream, cols, rows}`: only a live `shell` stream; no token (the terminal approval already opened it). */
export async function execResize(ctx: Ctx, params: Params): Promise<Record<string, never>> {
  const stream = params.stream
  const size = ptySize(params)
  const shell = typeof stream === 'string' ? ctx.shells.get(stream) : undefined
  if (!shell) throw new VaultdError('not_found', 'No such terminal.')
  shell.resize(size)
  return {}
}
