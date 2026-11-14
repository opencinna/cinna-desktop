/**
 * `runtime.install` / `runtime.status` (D28): main streams a pinned engine
 * executable, archive or the adapter's JS closure; vaultd hashes what it
 * received, installs it under a staging dir and, only when that hash equals
 * the `expectedSha256` main sent (its compiled-in pin), renames it into place
 * and records it in `runtime/index.json`. Bytes that differ are deleted with
 * the stage; nothing in the vault changes. Main compares the reported sha256
 * with its pin again.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { VAULT_ENGINES, type RuntimeKind, type VaultEngine } from '../../../../../src/shared/vault/protocol'
import { extractChecked, plainTar, receiveToFile, scratch } from './archive'
import type { Ctx, Handler } from './context'
import { writeJsonAtomic } from './jsonFile'
import { ownTree } from './users'
import { invalid, log, oneOf, relativeName, segment } from './util'

const SHA256_HEX = /^[0-9a-f]{64}$/

export interface RuntimeEntry {
  engine: VaultEngine
  version: string
  kind: RuntimeKind
  /** executable: the file name; archive: the entry point's path inside it; adapter: informational. */
  name: string
  sha256: string
  bytes: number
  installedAt: number
}

const KINDS: readonly RuntimeKind[] = ['executable', 'archive', 'adapter']

export function readIndex(ctx: Ctx): RuntimeEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(ctx.layout.runtimeIndex, 'utf8')) as { runtimes?: RuntimeEntry[] }
    return Array.isArray(parsed.runtimes) ? parsed.runtimes : []
  } catch {
    return []
  }
}

export function installDir(ctx: Ctx, entry: Pick<RuntimeEntry, 'engine' | 'version' | 'kind'>): string {
  return entry.kind === 'adapter'
    ? join(ctx.layout.adapter, entry.engine, entry.version)
    : join(ctx.layout.runtime, entry.engine, entry.version)
}

/** The most recently installed entry of an engine for these kinds (what main last pushed, i.e. the current pin). */
export function latest(ctx: Ctx, engine: VaultEngine, kinds: readonly RuntimeKind[]): RuntimeEntry | null {
  let best: RuntimeEntry | null = null
  for (const entry of readIndex(ctx)) {
    if (entry.engine !== engine || !kinds.includes(entry.kind)) continue
    if (!existsSync(installDir(ctx, entry))) continue
    if (!best || entry.installedAt >= best.installedAt) best = entry
  }
  return best
}

/** Absolute path of an engine's executable (from an `executable` or `archive` install), or null. */
export function engineExecutable(ctx: Ctx, engine: VaultEngine): string | null {
  const entry = latest(ctx, engine, ['executable', 'archive'])
  return entry ? join(installDir(ctx, entry), entry.name) : null
}

/**
 * Installed entries in install order (a reinstall moves an entry to the end),
 * so the last of an engine's kind is the one {@link latest} runs: main's
 * launcher checks exactly that one against its pin. Entries whose files are
 * gone are left out, as `latest` skips them.
 */
export const runtimeStatus: Handler = async (ctx) => ({
  runtimes: readIndex(ctx)
    .filter((entry) => existsSync(installDir(ctx, entry)))
    .sort((a, b) => a.installedAt - b.installedAt)
    .map(({ engine, version, kind, sha256 }) => ({ engine, version, kind, sha256 }))
})

export const runtimeInstall: Handler = async (ctx, params, conn) => {
  const engine = oneOf(params.engine, VAULT_ENGINES, 'engine')
  const version = segment(params.version, 'version')
  const kind = oneOf(params.kind, KINDS, 'kind')
  const name = kind === 'executable' ? segment(params.name, 'name') : relativeName(params.name, 'name')
  if (typeof params.expectedSha256 !== 'string' || !SHA256_HEX.test(params.expectedSha256)) throw invalid('Invalid expectedSha256.')
  const expectedSha256 = params.expectedSha256
  ctx.tokens.verify(params.token, { actions: ['move-in', 'install'] })
  mkdirSync(ctx.layout.tmp, { recursive: true, mode: 0o700 })

  // Never committed when the bytes are not the ones main pinned: the stage goes with `cleanup`.
  const mismatch = (received: { sha256: string }): void => {
    if (received.sha256 !== expectedSha256) {
      log('warn', 'runtime install refused: sha256 mismatch', { engine, version, kind })
      throw new Error('the bytes received are not the pinned ones (sha256 mismatch); nothing was installed')
    }
  }

  const install = async (socket: import('node:net').Socket): Promise<{ sha256: string; bytes: number }> => {
    const stage = scratch(ctx.layout.tmp, 'runtime')
    mkdirSync(stage, { mode: 0o755 })
    const cleanup: string[] = [stage]
    try {
      let received: { sha256: string; bytes: number }
      if (kind === 'executable') {
        const file = join(stage, name)
        received = await receiveToFile(socket, file, 0o755)
        mismatch(received)
        chmodSync(file, 0o755)
      } else {
        const spool = scratch(ctx.layout.tmp, 'spool')
        cleanup.push(spool)
        received = await receiveToFile(socket, spool)
        // Checked before a byte of it is unpacked.
        mismatch(received)
        const tar = await plainTar(spool, ctx.layout.tmp)
        if (tar !== spool) cleanup.push(tar)
        rmSync(stage, { recursive: true, force: true })
        await extractChecked(tar, stage, { PATH: ctx.config.path })
        if (kind === 'archive' && !existsSync(join(stage, name))) {
          throw new Error('entry point missing from archive')
        }
      }
      // Root-owned, readable and runnable by agent and build, writable by neither (D36).
      ownTree(ctx, stage, 'runtime')
      const dest = installDir(ctx, { engine, version, kind })
      await ctx.serial('runtime-index', async () => {
        mkdirSync(join(dest, '..'), { recursive: true, mode: 0o755 })
        if (existsSync(dest)) {
          const old = scratch(ctx.layout.tmp, 'old')
          renameSync(dest, old)
          cleanup.push(old)
        }
        renameSync(stage, dest)
        const entries = readIndex(ctx).filter((e) => !(e.engine === engine && e.version === version && e.kind === kind))
        entries.push({ engine, version, kind, name, sha256: received.sha256, bytes: received.bytes, installedAt: Date.now() })
        await writeJsonAtomic(ctx.layout.runtimeIndex, { runtimes: entries }, 0o644)
      })
      return received
    } finally {
      for (const path of cleanup) rmSync(path, { recursive: true, force: true })
    }
  }

  const stream = ctx.streams.create((socket) => {
    install(socket).then(
      (received) => {
        log('info', 'runtime installed', { engine, version, kind, bytes: received.bytes })
        conn.notify('runtime.installed', { stream, sha256: received.sha256, bytes: received.bytes })
        socket.end()
      },
      (err: Error) => {
        log('warn', 'runtime install failed', { engine, version, kind })
        conn.notify('stream.error', { stream, message: `Install failed: ${err.message}` })
        socket.destroy()
      }
    )
  })
  return { stream }
}
