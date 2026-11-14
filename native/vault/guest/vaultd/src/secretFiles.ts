/**
 * `secrets.putFile`: a secret that is a **file** the agent's own scripts read
 * by path (the service credentials' `credentials.json` and its service-account
 * side files), as opposed to the env secrets of `secrets.ts`.
 *
 * Two copies, both inside the encrypted disk:
 * - the stored one, `/vault/secrets/files/<name>`: root's, 0600 in a 0700
 *   directory, like every other secret; main can replace or remove it and
 *   never read it back (no `get`);
 * - the agent's, `/vault/run-secrets/<name>`: what the engine's tools open.
 *   The directory is root's and 0711 (the agent may open a name it knows, may
 *   not list or plant anything there); each file is 0400 and owned by
 *   `agent`. Refreshed from the stored copies on every `secrets.putFile` and
 *   at every `engine.spawn` (each file replaced by a rename, so a running tool
 *   never reads half of one), and nothing else is left in it.
 *
 * A path, not a descriptor: the credentials are read by the scripts the
 * agent's tools run (grandchildren of the engine, through a shell), which
 * reach a file by the path in `CINNA_CREDENTIALS_PATH` and never inherit a
 * descriptor across those execs.
 */
import { closeSync, existsSync, fchmodSync, fchownSync, fsyncSync, lstatSync, mkdirSync, chmodSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync, type Dirent } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Ctx, Handler } from './context'
import { ownerIds } from './config'
import { invalid } from './util'

/** `credentials.json`, or a side file `<id>.json`. */
export const SECRET_FILE_NAME = /^(?:credentials|[a-zA-Z0-9_-]{1,128})\.json$/
/** Under the control line limit (1 MiB), so an oversized file is refused, not a dropped connection. */
export const MAX_SECRET_FILE_BYTES = 512 * 1024
/** The file `CINNA_CREDENTIALS_PATH` names when it is there. */
export const CREDENTIALS_FILE = 'credentials.json'

export function storedFilesDir(ctx: Ctx): string {
  return join(ctx.layout.secrets, 'files')
}

export function runSecretsDir(ctx: Ctx): string {
  return join(ctx.config.root, 'run-secrets')
}

function ensureDir(path: string, mode: number): void {
  if (existsSync(path)) {
    const stat = lstatSync(path)
    // Root's directories: a link or a file in their place is removed, never followed.
    if (stat.isSymbolicLink() || !stat.isDirectory()) rmSync(path, { force: true, recursive: false })
  }
  mkdirSync(path, { recursive: true, mode })
  chmodSync(path, mode)
}

/** Write `bytes` to `<dir>/<name>` by a temp file and a rename; `owner` set before the rename. */
function writeReplacing(dir: string, name: string, bytes: Buffer, mode: number, owner: { uid: number; gid: number } | null): void {
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeSync(fd, bytes)
    fsyncSync(fd)
    if (owner) fchownSync(fd, owner.uid, owner.gid)
    fchmodSync(fd, mode)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, join(dir, name))
}

function listNames(dir: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.map((e) => e.name)
}

/**
 * Make the agent's copies equal the stored files: each written fresh, 0400
 * and the agent's, and anything else in the directory removed.
 */
export function syncRunSecrets(ctx: Ctx): void {
  const stored = storedFilesDir(ctx)
  const run = runSecretsDir(ctx)
  const names = listNames(stored).filter((name) => SECRET_FILE_NAME.test(name) && lstatSync(join(stored, name)).isFile())
  if (names.length === 0 && !existsSync(run)) return
  ensureDir(run, 0o711)
  const agent = ownerIds(ctx.config.users, 'agent')
  for (const name of names) writeReplacing(run, name, readFileSync(join(stored, name)), 0o400, agent)
  for (const name of listNames(run)) {
    if (!names.includes(name)) rmSync(join(run, name), { force: true, recursive: true })
  }
}

/** `CINNA_CREDENTIALS_PATH` for an engine, when credentials were delivered. */
export function credentialsEnv(ctx: Ctx): Record<string, string> {
  syncRunSecrets(ctx)
  const path = join(runSecretsDir(ctx), CREDENTIALS_FILE)
  return existsSync(path) ? { CINNA_CREDENTIALS_PATH: path } : {}
}

/** `{name, content}`: store (or, with `content: null`, remove) one secret file; the agent's copy follows. */
export const secretsPutFile: Handler = async (ctx, params) => {
  const name = params.name
  if (typeof name !== 'string' || !SECRET_FILE_NAME.test(name)) throw invalid('Invalid secret file name.')
  const content = params.content
  if (content !== null && (typeof content !== 'string' || Buffer.byteLength(content) > MAX_SECRET_FILE_BYTES || content.includes('\0'))) {
    throw invalid('Invalid secret file content.')
  }
  await ctx.serial('secret-files', async () => {
    ensureDir(ctx.layout.secrets, 0o700)
    const stored = storedFilesDir(ctx)
    ensureDir(stored, 0o700)
    if (content === null) rmSync(join(stored, name), { force: true })
    else writeReplacing(stored, name, Buffer.from(content, 'utf8'), 0o600, null)
    syncRunSecrets(ctx)
  })
  return {}
}
