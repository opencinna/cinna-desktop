/**
 * `files.import` (tar in → the agent folder), `files.export` (tar out of a
 * path in it), `files.list`.
 *
 * Import spools the archive, checks every header (tarCheck.ts), extracts
 * into a staging dir, walks it again, and only then moves its top-level
 * entries into `/vault/agent`, replacing same-named ones.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, type Dirent } from 'node:fs'
import type { Socket } from 'node:net'
import { join, sep } from 'node:path'
import { approvalDetail } from '../../../../../src/shared/vault/protocol'
import { extractChecked, plainTar, receiveToFile, scratch } from './archive'
import type { Ctx, Handler } from './context'
import { spawnGroup } from './procs'
import { ownTree, spawnIdentity } from './users'
import { agentPath, log, oneOf, VaultdError } from './util'

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
    // No -h: symlinks go out as links, never as what they point to. As agent (D36), so the archive
    // can hold nothing the agent could not read itself, whatever links the folder holds.
    const child = spawnGroup('tar', ['-c', '-f', '-', '-C', ctx.layout.agent, '--', rel || '.'], {
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
