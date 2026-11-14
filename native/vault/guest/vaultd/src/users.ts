/**
 * Who a child runs as (D36). vaultd stays root; engines, auth and the
 * terminal run as `agent`, the install and check presets as `build`, both
 * with primary group `vault`. Every such child starts through `setpriv`
 * (procs.ts dropTo): no supplementary groups, empty bounding and inheritable
 * sets, no_new_privs. The rootfs also has no setuid file and no xattrs, and
 * /vault, /tmp, /run are nosuid. Fake mode (a host process, no root) switches nothing.
 */
import { chmodSync, lchownSync, lstatSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { ownerIds, type DirOwner } from './config'
import type { Ctx } from './context'

export type Role = 'agent' | 'build'

/** The `asUser` spawn option for a role (spawnGroup drops to it through setpriv); empty in fake mode. */
export function spawnIdentity(ctx: Ctx, role: Role): { asUser?: { uid: number; gid: number } } {
  const users = ctx.config.users
  if (!users) return {}
  const user = users[role]
  return { asUser: { uid: user.uid, gid: user.gid } }
}

/**
 * The environment every child of a role starts from; nothing is inherited
 * from vaultd. build gets its own HOME (install scripts never see the
 * agent's) and the shared uv cache; agent keeps a uv cache in its home, since
 * build's cache is read-only to it.
 */
export function roleEnv(ctx: Ctx, role: Role): Record<string, string> {
  const { layout } = ctx
  return {
    PATH: ctx.config.path,
    HOME: role === 'agent' ? layout.home : layout.buildHome,
    LANG: 'C.UTF-8',
    UV_CACHE_DIR: role === 'agent' ? join(layout.home, '.cache', 'uv') : layout.uvCache,
    UV_PYTHON_INSTALL_DIR: layout.python,
    TMPDIR: layout.userTmp,
    ...ctx.config.proxyEnv
  }
}

/** chown when vaultd can (guest), never following links. */
export function chownTo(ctx: Ctx, path: string, owner: DirOwner): void {
  const ids = ownerIds(ctx.config.users, owner)
  if (ids) lchownSync(path, ids.uid, ids.gid)
}

/**
 * Normalize a tree vaultd just wrote, without following links. `runtime`:
 * root-owned, dirs 0755, files 0644 or 0755 (read and run for all, write for
 * none). `agent`: owner agent, group vault, dirs 2775, files 0664 or 0775, so
 * agent and build can both change it. Setuid, setgid-on-file and sticky bits
 * never survive.
 */
export function ownTree(ctx: Ctx, path: string, kind: 'runtime' | 'agent'): void {
  const stat = lstatSync(path)
  chownTo(ctx, path, kind === 'agent' ? 'agent' : 'root')
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    chmodSync(path, kind === 'agent' ? 0o2775 : 0o755)
    const entries: Dirent[] = readdirSync(path, { withFileTypes: true })
    for (const entry of entries) ownTree(ctx, join(path, entry.name), kind)
    return
  }
  const exec = (stat.mode & 0o100) !== 0
  if (kind === 'agent') chmodSync(path, exec ? 0o775 : 0o664)
  else chmodSync(path, exec ? 0o755 : 0o644)
}
