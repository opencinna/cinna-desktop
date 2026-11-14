/**
 * `files.import` (tar in → the agent folder), `files.export` (tar out of a
 * path in it), `files.list`, and `files.stat` / `files.read` (file references
 * in a vault chat: what a path names, and a capped read of one file).
 *
 * Import spools the archive, checks every header (tarCheck.ts), extracts
 * into a staging dir, walks it again, and only then moves its top-level
 * entries into `/vault/agent`, replacing same-named ones.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, type Dirent } from 'node:fs'
import type { Socket } from 'node:net'
import { join, relative, sep } from 'node:path'
import {
  approvalDetail,
  VAULT_FILES_PATH_MAX,
  VAULT_FILES_READ_MAX,
  VAULT_FILES_STAT_MAX,
  type VaultFileStatEntry
} from '../../../../../src/shared/vault/protocol'
import { extractChecked, plainTar, receiveToFile, scratch } from './archive'
import type { Ctx, Handler } from './context'
import { nodeSelfEnv, runCollect, spawnGroup } from './procs'
import { ownTree, spawnIdentity } from './users'
import { agentPath, invalid, log, oneOf, VaultdError } from './util'

export const filesImport: Handler = async (ctx, params, conn) => {
  oneOf(params.dest, ['agent'] as const, 'dest')
  ctx.tokens.verify(params.token, { actions: ['move-in'] })
  mkdirSync(ctx.layout.tmp, { recursive: true, mode: 0o700 })
  mkdirSync(ctx.layout.agent, { recursive: true, mode: 0o775 })

  const run = async (socket: Socket): Promise<{ files: number; bytes: number }> => {
    const spool = scratch(ctx.layout.tmp, 'import')
    const stage = scratch(ctx.layout.tmp, 'stage')
    const cleanup = [spool, stage]
    try {
      await receiveToFile(socket, spool)
      const tar = await plainTar(spool, ctx.layout.tmp)
      if (tar !== spool) cleanup.push(tar)
      const summary = await extractChecked(tar, stage, { PATH: ctx.config.path })
      // Agent-owned, group vault, group-writable (D36), before anything is visible in the agent folder.
      ownTree(ctx, stage, 'agent')
      const entries: Dirent[] = readdirSync(stage, { withFileTypes: true })
      for (const entry of entries) {
        const target = join(ctx.layout.agent, entry.name)
        if (existsSync(target) || isLink(target)) rmSync(target, { recursive: true, force: true })
        renameSync(join(stage, entry.name), target)
      }
      return summary
    } finally {
      for (const path of cleanup) rmSync(path, { recursive: true, force: true })
    }
  }

  const stream = ctx.streams.create((socket) => {
    run(socket).then(
      (summary) => {
        log('info', 'files imported', { files: summary.files, bytes: summary.bytes })
        conn.notify('files.imported', { stream, files: summary.files, bytes: summary.bytes })
        socket.end()
      },
      (err: Error) => {
        log('warn', 'files import refused or failed')
        conn.notify('stream.error', { stream, message: err instanceof VaultdError ? err.message : 'Import failed.' })
        socket.destroy()
      }
    )
  })
  return { stream }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** The agent-relative real path of `rel`, refused when it now lies outside the agent folder. */
function realRelative(ctx: Ctx, rel: string): string {
  const root = realpathSync(ctx.layout.agent)
  const real = realpathSync(resolveInAgent(ctx, rel))
  return real === root ? '' : relative(root, real)
}

/** An existing path inside the agent folder whose real location is inside it too. */
function resolveInAgent(ctx: Ctx, rel: string): string {
  const root = realpathSync(ctx.layout.agent)
  const full = rel ? join(root, rel) : root
  let real: string
  try {
    real = realpathSync(full)
  } catch {
    throw new VaultdError('not_found', 'No such path.')
  }
  if (real !== root && !real.startsWith(root + sep)) throw new VaultdError('invalid', 'Invalid path.')
  return full
}

export const filesExport: Handler = async (ctx, params, conn) => {
  if (typeof params.path !== 'string') throw new VaultdError('invalid', 'Invalid path.')
  const raw = params.path
  const rel = agentPath(raw)
  // Resolved first, so a missing path does not spend the single-use approval.
  resolveInAgent(ctx, rel)
  // `export` names the exact path the caller sent; `move-out` covers only the whole folder.
  ctx.tokens.verify(params.token, {
    actions: rel === '' ? ['export', 'move-out'] : ['export'],
    detail: (action) =>
      action === 'move-out' ? approvalDetail({ method: 'move-out' }) : approvalDetail({ method: 'files.export', path: raw })
  })

  const stream = ctx.streams.create((socket) => {
    // Resolved again now, after the prompt and the save dialog, and tar is given the real
    // path: a parent swapped for a symlink while the user decided is followed here or
    // refused, not by tar. tar runs as agent (D36), so whatever is left of the window can
    // only hand out what the agent could read itself (and could have copied in anyway).
    let target: string
    try {
      target = realRelative(ctx, rel)
    } catch {
      conn.notify('stream.error', { stream, message: 'Export failed.' })
      socket.destroy()
      return
    }
    // No -h: symlinks go out as links, never as what they point to.
    const child = spawnGroup('tar', ['-c', '-f', '-', '-C', ctx.layout.agent, '--', target || '.'], {
      env: { PATH: ctx.config.path, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'ignore'],
      ...spawnIdentity(ctx, 'agent')
    })
    child.stdout!.pipe(socket, { end: false })
    let ended = false
    child.stdout!.on('end', () => { ended = true })
    child.on('error', () => {
      conn.notify('stream.error', { stream, message: 'Export failed.' })
      socket.destroy()
    })
    child.on('close', (code) => {
      if (code === 0 && ended) {
        socket.end()
      } else {
        log('warn', 'files export failed', { code })
        conn.notify('stream.error', { stream, message: 'Export failed.' })
        socket.destroy()
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => { if (child.exitCode === null) child.kill('SIGTERM') })
    socket.resume()
  })
  return { stream }
}

export const filesList: Handler = async (ctx, params) => {
  const rel = agentPath(params.path)
  const dir = resolveInAgent(ctx, rel)
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    throw new VaultdError('not_found', 'Not a folder.')
  }
  const out: { name: string; type: 'file' | 'dir' | 'link'; size: number; mtime: number }[] = []
  for (const entry of entries) {
    let stat
    try { stat = lstatSync(join(dir, entry.name)) } catch { continue }
    const type = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : null
    if (!type) continue
    out.push({ name: entry.name, type, size: stat.size, mtime: Math.floor(stat.mtimeMs) })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return { entries: out }
}

// ---------------------------------------------------------------------------
// files.stat / files.read

/**
 * The agent-relative path a caller named, or null: agent-relative, or
 * absolute under the agent folder as processes inside the vault see it
 * (`/vault/agent/…`, the fake's own root, either spelling of it). Lexical
 * only; the child below decides what it really names.
 */
export function agentRelative(ctx: Ctx, raw: string): string | null {
  if (raw.length === 0 || raw.length > VAULT_FILES_PATH_MAX) return null
  let rel = raw
  if (raw.startsWith('/')) {
    const roots = [ctx.layout.agent]
    try {
      roots.push(realpathSync(ctx.layout.agent))
    } catch {
      // No agent folder yet: nothing in it either.
    }
    const root = roots.find((r) => raw === r || raw === r + '/' || raw.startsWith(r + '/'))
    if (root === undefined) return null
    rel = raw.slice(root.length + 1)
  }
  try {
    return agentPath(rel)
  } catch {
    return null
  }
}

/**
 * Runs as the agent user (D36), so it can reach nothing the agent could not
 * read itself. Each path is realpath-ed and must stay inside the agent folder
 * (a symlink out answers nothing); a realpath longer than `pathMax` answers
 * nothing too, so one entry's output stays bounded.
 *
 * A read opens with O_NOFOLLOW | O_NONBLOCK (a fifo cannot hold it) and then
 * checks that what it *opened* is inside the agent folder: O_NOFOLLOW guards
 * the last component only, so a parent directory swapped for a symlink out
 * between the realpath and the open would otherwise be followed. On Linux (the
 * guest) the fd's own path, `/proc/self/fd/<fd>`, must be under the agent
 * folder's realpath, and the agent-relative path returned as `rel` is that
 * one. Without `/proc` (fake mode on macOS) the path is realpath-ed again after
 * the open and its dev/ino compared with the fd's: best effort only, since the
 * tree can still change between those two calls — the guest never takes this
 * branch.
 *
 * `beforeOpen` (tests only, see {@link filesScript}) runs between the
 * realpath and the open, where a swap would land.
 */
export function filesScript(hooks: { beforeOpen?: string } = {}): string {
  return `
const fs = require('fs'), path = require('path')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { input += d })
process.stdin.on('end', () => {
  const req = JSON.parse(input)
  const root = fs.realpathSync(req.root)
  const inside = (real) => real === root || real.startsWith(root + path.sep)
  const locate = (rel) => {
    try {
      const real = fs.realpathSync(rel === '' ? root : path.join(root, rel))
      if (!inside(real) || real.length > req.pathMax) return null
      return real
    } catch { return null }
  }
  // Where the open fd really is, or null when that is not inside the agent folder.
  const openedAt = (fd, real, opened) => {
    let at
    try { at = fs.readlinkSync('/proc/self/fd/' + fd) } catch { at = null }
    if (at === null) {
      // The guest mounts /proc: on Linux a missing fd link is a refusal, never the fallback.
      if (process.platform === 'linux') return null
      // No /proc (fake mode on macOS): realpath again and compare identities. Best effort.
      try { at = fs.realpathSync(real) } catch { return null }
      let now
      try { now = fs.statSync(at) } catch { return null }
      if (now.dev !== opened.dev || now.ino !== opened.ino) return null
    }
    return inside(at) && at.length <= req.pathMax ? at : null
  }
  const out = (value) => process.stdout.write(JSON.stringify(value))
  if (req.op === 'stat') {
    out(req.rels.map((rel) => {
      const real = rel === null ? null : locate(rel)
      if (!real) return null
      try {
        const st = fs.statSync(real)
        const type = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null
        return type ? { rel: path.relative(root, real), type, size: type === 'file' ? st.size : 0 } : null
      } catch { return null }
    }))
    return
  }
  const real = locate(req.rel)
  if (!real) return out({ error: 'not_found' })
  let fd
  try {
    ${hooks.beforeOpen ?? ''}
    const st = fs.statSync(real)
    if (st.isDirectory()) return out({ error: 'dir' })
    if (!st.isFile()) return out({ error: 'not_found' })
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino) return out({ error: 'not_found' })
    const at = openedAt(fd, real, opened)
    if (at === null || at === root) return out({ error: 'not_found' })
    const length = Math.min(opened.size, req.maxBytes)
    const buffer = Buffer.alloc(length)
    let offset = 0
    while (offset < length) {
      const n = fs.readSync(fd, buffer, offset, length - offset, offset)
      if (n === 0) break
      offset += n
    }
    out({ rel: path.relative(root, at), bytes: buffer.subarray(0, offset).toString('base64'), size: opened.size, truncated: opened.size > offset })
  } catch { out({ error: 'not_found' }) }
  finally { if (fd !== undefined) fs.closeSync(fd) }
})
`
}

const FILES_SCRIPT = filesScript()

/**
 * The most one answered path can add to the child's JSON: every character of
 * a {@link VAULT_FILES_PATH_MAX}-long path escaped (`\u0001`, six bytes), plus
 * the object around it.
 */
const FILES_ENTRY_OUTPUT_MAX = 6 * VAULT_FILES_PATH_MAX + 128
/** A full `files.stat` batch of capped entries, so no agent-made name can push the answer past the cap. */
const FILES_STAT_OUTPUT_MAX = VAULT_FILES_STAT_MAX * FILES_ENTRY_OUTPUT_MAX + 64

/** The child above, as the agent user, in the agent folder. Null when it failed. */
async function runFilesChild<T>(ctx: Ctx, request: Record<string, unknown>, maxBytes: number): Promise<T | null> {
  const r = await runCollect(ctx.config.node, ['-e', FILES_SCRIPT], {
    input: Buffer.from(JSON.stringify({ ...request, root: ctx.layout.agent, pathMax: VAULT_FILES_PATH_MAX })),
    env: { PATH: ctx.config.path, LANG: 'C.UTF-8', ...nodeSelfEnv() },
    cwd: ctx.layout.agent,
    timeoutMs: 30_000,
    maxBytes,
    ...spawnIdentity(ctx, 'agent')
  })
  if (r.code !== 0) return null
  try {
    return JSON.parse(r.stdout) as T
  } catch {
    return null
  }
}

/**
 * The child's agent-relative path, if it is one: no leading `/`, no `..`, no
 * `.` or empty part, within {@link VAULT_FILES_PATH_MAX}; `''` is the folder
 * itself. The child runs as the agent user, so what it prints is checked like
 * anything else from the agent.
 */
export function childRel(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > VAULT_FILES_PATH_MAX) return null
  if (value === '') return ''
  try {
    return agentPath(value) === value ? value : null
  } catch {
    return null
  }
}

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** One stat answer of the child, checked: anything malformed names nothing. */
export function checkedStatEntry(path: string, hit: unknown): VaultFileStatEntry {
  const none: VaultFileStatEntry = { path, rel: null, type: null, size: 0 }
  if (!hit || typeof hit !== 'object') return none
  const { rel, type, size } = hit as { rel?: unknown; type?: unknown; size?: unknown }
  const checked = childRel(rel)
  if (checked === null || (type !== 'file' && type !== 'dir') || !isSize(size)) return none
  return { path, rel: checked, type, size }
}

export const filesStat: Handler = async (ctx, params) => {
  const paths = params.paths
  if (!Array.isArray(paths) || paths.length > VAULT_FILES_STAT_MAX || !paths.every((p) => typeof p === 'string')) {
    throw invalid('Invalid paths.')
  }
  const asked = paths as string[]
  if (asked.length === 0 || !existsSync(ctx.layout.agent)) {
    return { entries: asked.map((path): VaultFileStatEntry => ({ path, rel: null, type: null, size: 0 })) }
  }
  const rels = asked.map((path) => agentRelative(ctx, path))
  const found = await runFilesChild<unknown[]>(ctx, { op: 'stat', rels }, FILES_STAT_OUTPUT_MAX)
  if (!found || !Array.isArray(found) || found.length !== asked.length) throw new VaultdError('internal', 'The files could not be checked.')
  return { entries: asked.map((path, i) => checkedStatEntry(path, found[i])) }
}

export const filesRead: Handler = async (ctx, params) => {
  if (typeof params.path !== 'string') throw invalid('Invalid path.')
  const maxBytes = params.maxBytes
  if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 0) throw invalid('Invalid maxBytes.')
  const rel = agentRelative(ctx, params.path)
  if (rel === null || !existsSync(ctx.layout.agent)) throw new VaultdError('not_found', 'No such file.')
  const cap = Math.min(maxBytes, VAULT_FILES_READ_MAX)
  // Base64 is 4/3 the bytes, plus the path and the JSON around them.
  const read = await runFilesChild<{ rel?: unknown; bytes?: unknown; size?: unknown; truncated?: unknown; error?: unknown }>(
    ctx, { op: 'read', rel, maxBytes: cap }, Math.ceil((cap * 4) / 3) + FILES_ENTRY_OUTPUT_MAX + 4096
  )
  if (!read || typeof read !== 'object') throw new VaultdError('internal', 'The file could not be read.')
  if (read.error === 'dir') throw invalid('That is a folder, not a file.')
  if (read.error || typeof read.bytes !== 'string') throw new VaultdError('not_found', 'No such file.')
  // What was opened, as the child found it from the fd; never the folder itself.
  const opened = childRel(read.rel)
  if (opened === null || opened === '' || !isSize(read.size)) throw new VaultdError('not_found', 'No such file.')
  log('info', 'file read', { bytes: Math.floor((read.bytes.length * 3) / 4), truncated: read.truncated === true })
  return { rel: opened, bytes: read.bytes, size: read.size, truncated: read.truncated === true }
}
