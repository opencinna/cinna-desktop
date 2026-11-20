/**
 * D28: the engine and its ACP adapter are not in the guest image. Main copies
 * them into a vault with `runtime.install`, and the guest reports the sha256
 * of what it received.
 *
 * - **The engine** (`claude` linux-arm64): the pinned release asset,
 *   downloaded once into `<userData>/vault/runtime/` by `managedAsset` (digest
 *   checked against `runtimePins.ts`), hashed again against the pin before
 *   every install (a file changed under userData is refused, and the cached
 *   copy removed), streamed as one executable. The guest's hash must equal the
 *   **pin**, and the guest commits nothing whose hash differs from the
 *   `expectedSha256` main sends with `runtime.install`.
 * - **The adapter**: the patched `@agentclientprotocol/claude-agent-acp` and
 *   its runtime dependency closure, as the deterministic tar the app build
 *   wrote from the checkout's `node_modules` (`adapterTar.ts`,
 *   `out/vault/claude-adapter.tar`; inside app.asar when packaged, so under
 *   asar integrity). Its sha256 is pinned in `runtimePins.ts`
 *   (`claude.vaultAdapterTarSha256`, `npm run vault:pin-adapter`); a tar that
 *   differs is refused before anything is sent, and the bytes actually
 *   streamed and the guest's report must both equal the pin.
 *
 * The other engines (phase 2):
 *
 * - **codex**: the pinned `codex` and `codex-code-mode-host` archives, each
 *   checked against its own row, unpacked under `<userData>/vault/runtime/`,
 *   and streamed as **one** deterministic tar so the host sits beside the
 *   executable as Codex requires; that tar's sha256 is pinned too
 *   (`codex.vaultRuntimeTarSha256`). Its adapter is the `codex-acp` package
 *   alone, as `out/vault/codex-adapter.tar` (`codex.vaultAdapterTarSha256`).
 * - **opencode**: the pinned npm tarball itself, streamed as an archive (the
 *   guest's hash is the asset's pin); `opencode acp` needs no adapter.
 * - **antigravity**: the server and its sibling from the pinned zip, as one
 *   deterministic tar (the guest takes tar only; `antigravity.vaultRuntimeTarSha256`).
 *
 * Hub core: no Electron. The bytes come from a {@link RuntimeSource}, which a
 * test replaces with a fake executable and a fake adapter.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RUNTIME_PINS } from '../../shared/runtimePins'
import type { RuntimeKind, VaultEngine } from '../../shared/vault/protocol'
import { runtimeHost } from '../host/runtimeHost'
import { createLogger } from '../logger/logger'
import { downloadToFile, extractArchive, findNamedFile, installPinnedAsset, isFile, withVerifiedFile } from '../managed/managedAsset'
import type { VaultdClient } from './vaultdClient'
import { ADAPTER_TAR_PATH, CODEX_ADAPTER_TAR_PATH, deterministicTar, deterministicTarSha256, VaultRuntimeError } from './adapterTar'

const logger = createLogger('vault-runtime')

/** One thing `runtime.install` copies into a vault. */
export interface RuntimeArtifact {
  engine: VaultEngine
  version: string
  kind: RuntimeKind
  /** executable: the file name; adapter: informational. */
  name: string
  /** The bytes, opened per install. */
  open(): AsyncIterable<Uint8Array>
  /** The sha256 the guest must report; null = what main hashed while streaming. */
  expectedSha256: string | null
}

/** What a vault must hold of an engine for this app to run it: one row per kind it installs. */
export interface RuntimePin {
  engine: VaultEngine
  kind: RuntimeKind
  version: string
  /** The sha256 the installed row must report; null = nothing pins it (the fake backend's host executable). */
  sha256: string | null
  /**
   * Earlier reviewed rows the launch gate still runs (`installedRuntime`),
   * exact version and sha256 each. Never installed: `ensureRuntimes` installs
   * `version`/`sha256` alone.
   */
  accepted?: readonly { version: string; sha256: string }[]
}

/** Where the runtime bytes come from (the pinned download and the app's adapter; a fake in tests). */
export interface RuntimeSource {
  /** Every artifact an engine needs in a vault, at the versions this app pins. Rejects with a readable message. */
  artifacts(engine: VaultEngine): Promise<RuntimeArtifact[]>
  /**
   * What {@link artifacts} would install, without downloading or reading
   * anything: the vault launcher refuses an installed runtime that is not
   * this (another version, or the same version with other bytes).
   */
  pins(engine: VaultEngine): RuntimePin[]
}

type RuntimeRow = { engine: VaultEngine; version: string; kind: RuntimeKind; sha256: string }

/**
 * The row of an engine's executable (or archive), or of its adapter, that
 * cinna-vaultd runs: `runtime.status` lists rows in install order, and vaultd
 * starts the last installed one of the kind (`latest()` in its runtime.ts).
 */
export function currentRuntimeRow<R extends RuntimeRow>(runtimes: readonly R[], engine: VaultEngine, adapter: boolean): R | null {
  let found: R | null = null
  for (const row of runtimes) if (row.engine === engine && (row.kind === 'adapter') === adapter) found = row
  return found
}

/** True when an installed `runtime.status` row is the one `pin` names. */
export function matchesPin(row: RuntimeRow, pin: RuntimePin): boolean {
  return row.engine === pin.engine && row.kind === pin.kind && row.version === pin.version && (pin.sha256 === null || row.sha256 === pin.sha256)
}

/** {@link matchesPin}, or exactly one of the pin's `accepted` earlier rows (version and sha256 both). */
export function runsAsPinned(row: RuntimeRow, pin: RuntimePin): boolean {
  return matchesPin(row, pin) || (row.engine === pin.engine && row.kind === pin.kind &&
    (pin.accepted ?? []).some((earlier) => row.version === earlier.version && row.sha256 === earlier.sha256))
}

export { VaultRuntimeError }

type Client = Pick<VaultdClient, 'request' | 'attach' | 'onNotification'>

/**
 * Stream one artifact into the vault and check the guest's hash. `token` is
 * the move-in or install session token. Resolves with what the guest reported.
 */
export async function installRuntimeArtifact(client: Client, artifact: RuntimeArtifact, token: string): Promise<{ sha256: string; bytes: number }> {
  let streamId: string | null = null
  const early: { stream: string; result: { sha256: string; bytes: number } | Error }[] = []
  let settle!: (result: { sha256: string; bytes: number } | Error) => void
  const finished = new Promise<{ sha256: string; bytes: number } | Error>((resolve) => { settle = resolve })
  const stop = client.onNotification((notification) => {
    if (notification.method === 'runtime.installed') {
      const { stream, sha256, bytes } = notification.params
      if (streamId === null) early.push({ stream, result: { sha256, bytes } })
      else if (stream === streamId) settle({ sha256, bytes })
    } else if (notification.method === 'stream.error') {
      const { stream, message } = notification.params
      if (streamId === null) early.push({ stream, result: new VaultRuntimeError(message) })
      else if (stream === streamId) settle(new VaultRuntimeError(message))
    }
  })
  try {
    // The guest commits only bytes that hash to this. Nothing pins a fake's
    // host executable: hash it first (open() is re-openable per install).
    const pinned = artifact.expectedSha256 ?? (await sha256Of(artifact.open()))
    const { stream } = await client.request('runtime.install', {
      engine: artifact.engine, version: artifact.version, kind: artifact.kind, name: artifact.name, expectedSha256: pinned, token
    })
    streamId = stream
    const known = early.find((entry) => entry.stream === stream)
    if (known) settle(known.result)
    const channel = await client.attach(stream)
    const hash = createHash('sha256')
    let sent = 0
    const writer = channel.writable.getWriter()
    try {
      for await (const chunk of artifact.open()) {
        hash.update(chunk)
        sent += chunk.byteLength
        await writer.write(chunk)
      }
      await writer.close()
    } catch (error) {
      channel.close('runtime stream failed')
      throw error
    } finally {
      writer.releaseLock()
    }
    const result = await finished
    channel.close('done')
    const mismatch = (): VaultRuntimeError =>
      new VaultRuntimeError(`The ${artifact.engine} ${artifact.kind} the vault received does not match what this app pins (${artifact.version}).`)
    if (result instanceof Error) {
      // The guest refused to commit bytes that are not the pin (its stage is gone).
      if (/sha256 mismatch/.test(result.message)) {
        logger.error('the vault refused a runtime that did not match its pin', { engine: artifact.engine, version: artifact.version, kind: artifact.kind })
        throw mismatch()
      }
      throw result
    }
    const streamed = hash.digest('hex')
    const expected = pinned
    // Both sides: what main actually sent (a file changed between the check and
    // the stream) and what the guest says it received.
    if (streamed !== expected || result.sha256 !== expected || result.bytes !== sent) {
      logger.error('a vault runtime install did not match', { engine: artifact.engine, version: artifact.version, kind: artifact.kind, expected, actual: result.sha256 })
      throw mismatch()
    }
    return result
  } finally {
    stop()
  }
}

/**
 * Install every artifact of `engine` the vault does not already hold at this
 * app's pin (same engine, version, kind and hash). `onStep` hears each one.
 * Returns the artifacts installed.
 */
export async function ensureRuntimes(
  client: Client,
  source: RuntimeSource,
  engine: VaultEngine,
  token: string,
  onStep?: (message: string) => void
): Promise<RuntimeArtifact[]> {
  const artifacts = await source.artifacts(engine)
  const { runtimes } = await client.request('runtime.status', {})
  const installed: RuntimeArtifact[] = []
  for (const artifact of artifacts) {
    // The row the engine would run (the last installed of its kind), not just any row of this version.
    const current = currentRuntimeRow(runtimes, artifact.engine, artifact.kind === 'adapter')
    if (current && matchesPin(current, { engine: artifact.engine, kind: artifact.kind, version: artifact.version, sha256: artifact.expectedSha256 })) continue
    onStep?.(`Installing ${artifact.engine} ${artifact.kind} ${artifact.version}…`)
    await installRuntimeArtifact(client, artifact, token)
    installed.push(artifact)
  }
  return installed
}

/**
 * The versions this app pins for an engine's vault runtimes (`runtimes()` on
 * the Security tab). `adapter` is null for an engine that speaks ACP itself.
 */
export function pinnedVaultVersions(engine: VaultEngine): { executable: string; adapter: string | null } | null {
  switch (engine) {
    case 'claude':
      return { executable: RUNTIME_PINS.claude.cli, adapter: claudeAdapterVersionLabel() }
    case 'codex':
      return { executable: RUNTIME_PINS.codex.cli, adapter: codexAdapterVersionLabel() }
    case 'opencode':
      return { executable: RUNTIME_PINS.opencode.cli, adapter: null }
    case 'antigravity':
      return { executable: RUNTIME_PINS.antigravity.cli, adapter: null }
  }
}

/** `<adapter version>-<first 8 of the patched entry's sha>`: a patch change is a new version in the vault. */
export function claudeAdapterVersionLabel(): string {
  return `${RUNTIME_PINS.claude.adapter}-${RUNTIME_PINS.claude.adapterPatchedSha256.slice(0, 8)}`
}

/** The Codex adapter's version in a vault, labelled like Claude's. */
export function codexAdapterVersionLabel(patchedSha256: string = RUNTIME_PINS.codex.adapterPatchedSha256): string {
  return `${RUNTIME_PINS.codex.adapter}-${patchedSha256.slice(0, 8)}`
}

// ---------------------------------------------------------------------------
// The real source

const GUEST_PLATFORM = 'linux-arm64'

/**
 * A plain tar of `files` (relative to `cwd`), in that order, from the system
 * `tar`: no extended attributes or macOS metadata, so the guest's archive
 * check sees ordinary entries. The list goes in on stdin.
 */
export async function* tarFiles(cwd: string, files: readonly string[], options: { noRecursion?: boolean } = {}): AsyncIterable<Uint8Array> {
  const args = ['-c', '-f', '-', '-C', cwd]
  // The list names directories too (so empty ones survive): add each alone.
  if (options.noRecursion) args.push('--no-recursion')
  if (process.platform === 'darwin') args.push('--no-mac-metadata', '--no-xattrs', '--no-acls', '--no-fflags', '--format', 'pax')
  args.push('-T', '-')
  const child = spawn('tar', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', COPYFILE_DISABLE: '1', LANG: 'C' } })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000) })
  child.stdin.on('error', () => {})
  child.stdin.end(files.map((file) => `${file}\n`).join(''))
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
  try {
    for await (const chunk of child.stdout) yield chunk as Uint8Array
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  const code = await exited
  if (code !== 0) throw new VaultRuntimeError(`tar failed (${code}): ${stderr.trim().split('\n').at(-1) ?? ''}`)
}

async function sha256Of(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of chunks) hash.update(chunk)
  return hash.digest('hex')
}

async function* readFileChunks(path: string): AsyncIterable<Uint8Array> {
  for await (const chunk of createReadStream(path)) yield chunk as Uint8Array
}

/** The pinned linux-arm64 `claude`, downloaded once and kept under `<userData>/vault/runtime/`. */
async function guestClaudeExecutable(): Promise<string> {
  const asset = RUNTIME_PINS.claude.assets[GUEST_PLATFORM]
  if (!asset?.url) throw new VaultRuntimeError('This build pins no Linux Claude Code for vaults.')
  const root = join(runtimeHost.getPath('userData'), 'vault', 'runtime')
  const installDir = join(root, `claude-${RUNTIME_PINS.claude.cli}-${GUEST_PLATFORM}`)
  const target = join(installDir, 'claude')
  await installPinnedAsset({
    root,
    installDir,
    label: 'Claude Code for vaults',
    archiveName: 'claude',
    url: asset.url,
    sha256: asset.sha256,
    locate: (dir) => findNamedFile(dir, 'claude'),
    isInstalled: () => isFile(target),
    download: (url, dest) => downloadToFile(url, dest, undefined, asset.size),
    // The asset is the executable itself, not an archive.
    extract: (archive, dest) => rename(archive, join(dest, 'claude'))
  })
  await requirePinnedFile('claude', target, installDir, asset.sha256)
  return target
}

/**
 * A cached download is checked against its pin before every install, not
 * only when it was downloaded: a file changed under userData since is
 * refused before a byte is sent, and its cached copy removed so the next try
 * downloads it again.
 */
async function requirePinnedFile(engine: VaultEngine, file: string, cacheDir: string, pin: string): Promise<void> {
  const sha256 = await fileSha256(file)
  if (sha256 === pin) return
  logger.error('a cached vault runtime does not match its pin', { engine, expected: pin, actual: sha256 })
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
  throw new VaultRuntimeError(`The ${engine} files for vaults on this computer are not the ones this app pins. Try again; they are downloaded again.`)
}

function vaultRuntimeRoot(): string {
  return join(runtimeHost.getPath('userData'), 'vault', 'runtime')
}

/**
 * Codex for vaults: the pinned linux-arm64 archive and its `codex-code-mode-host`
 * companion, each checked against its row, unpacked into one directory as
 * `codex` and `codex-code-mode-host`. Returns that directory.
 */
async function guestCodexDir(): Promise<string> {
  const asset = RUNTIME_PINS.codex.assets[GUEST_PLATFORM]
  const companion = asset?.companions?.[0]
  if (!asset?.url || !asset.executable || !companion) throw new VaultRuntimeError('This build pins no Linux Codex for vaults.')
  const root = vaultRuntimeRoot()
  const installDir = join(root, `codex-${RUNTIME_PINS.codex.cli}-${GUEST_PLATFORM}`)
  const executable = asset.executable
  await installPinnedAsset({
    root,
    installDir,
    label: 'Codex for vaults',
    archiveName: asset.file,
    url: asset.url,
    sha256: asset.sha256,
    locate: (dir) => findNamedFile(dir, 'codex'),
    isInstalled: () => isFile(join(installDir, 'codex')),
    download: (url, dest) => downloadToFile(url, dest, undefined, asset.size),
    extract: async (archive, dest) => {
      await extractArchive(archive, dest)
      const found = await findNamedFile(dest, executable)
      if (!found) throw new VaultRuntimeError('The downloaded Codex for vaults did not contain its executable.')
      await rename(found, join(dirname(found), 'codex'))
    }
  })
  const host = join(installDir, companion.installAs)
  if (!(await isFile(host))) {
    await withVerifiedFile({
      root,
      label: 'Codex code-mode host for vaults',
      archiveName: companion.file,
      url: companion.url,
      sha256: companion.sha256,
      name: companion.executable,
      download: (url, dest) => downloadToFile(url, dest, undefined, companion.size),
      extract: extractArchive
    }, (file) => rename(file, host))
  }
  return installDir
}

/** Antigravity for vaults: the pinned linux-arm64 zip, unpacked (the server and its sibling). Returns that directory. */
async function guestAntigravityDir(): Promise<string> {
  const asset = RUNTIME_PINS.antigravity.assets[GUEST_PLATFORM]
  if (!asset?.url || !asset.executable) throw new VaultRuntimeError('This build pins no Linux Antigravity for vaults.')
  const root = vaultRuntimeRoot()
  const installDir = join(root, `antigravity-${RUNTIME_PINS.antigravity.cli}-${GUEST_PLATFORM}`)
  const executable = asset.executable
  const siblings = asset.siblings ?? []
  await installPinnedAsset({
    root,
    installDir,
    label: 'Antigravity for vaults',
    archiveName: asset.file,
    url: asset.url,
    sha256: asset.sha256,
    locate: (dir) => findNamedFile(dir, executable),
    isInstalled: async () => (await isFile(join(installDir, executable))) && (await Promise.all(siblings.map((name) => isFile(join(installDir, name))))).every(Boolean),
    download: (url, dest) => downloadToFile(url, dest, undefined, asset.size),
    extract: extractArchive
  })
  return installDir
}

/** OpenCode for vaults: the pinned linux-arm64 npm tarball itself, kept as downloaded. Returns its path. */
async function guestOpencodeArchive(): Promise<string> {
  const asset = RUNTIME_PINS.opencode.assets[GUEST_PLATFORM]
  if (!asset?.url) throw new VaultRuntimeError('This build pins no Linux OpenCode for vaults.')
  const root = vaultRuntimeRoot()
  const installDir = join(root, `opencode-${RUNTIME_PINS.opencode.cli}-${GUEST_PLATFORM}`)
  const target = join(installDir, asset.file)
  await installPinnedAsset({
    root,
    installDir,
    label: 'OpenCode for vaults',
    archiveName: asset.file,
    url: asset.url,
    sha256: asset.sha256,
    locate: (dir) => findNamedFile(dir, asset.file),
    isInstalled: () => isFile(target),
    download: (url, dest) => downloadToFile(url, dest, undefined, asset.size),
    // Kept as the archive: the guest unpacks it and its hash must be the pin's.
    extract: (archive, dest) => rename(archive, join(dest, asset.file))
  })
  await requirePinnedFile('opencode', target, installDir, asset.sha256)
  return target
}

/**
 * Files unpacked from pinned archives, streamed as one deterministic tar
 * whose sha256 is itself pinned. Checked here before anything is sent (a
 * changed file under userData is refused), and again on the bytes streamed.
 */
async function pinnedRuntimeTar(engine: VaultEngine, version: string, dir: string, files: string[], name: string, pin: string): Promise<RuntimeArtifact> {
  const { sha256 } = await deterministicTarSha256(dir, files)
  if (sha256 !== pin) {
    logger.error('a vault runtime tar does not match its pin', { engine, expected: pin, actual: sha256 })
    throw new VaultRuntimeError(`The ${engine} files for vaults on this computer are not the ones this app pins. Try again; they are downloaded again if they were removed.`)
  }
  return { engine, version, kind: 'archive', name, open: () => deterministicTar(dir, files), expectedSha256: pin }
}

/** The adapter tar this build carries (`out/vault/claude-adapter.tar`, inside app.asar when packaged). */
function adapterTarPath(path: string = ADAPTER_TAR_PATH): string {
  return join(runtimeHost.getAppPath(), ...path.split('/'))
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array)
  return hash.digest('hex')
}

/**
 * This app's patched adapter and its closure, as the one tar the build wrote
 * ({@link ADAPTER_TAR_PATH}): its sha256 must equal the pin, checked here
 * before anything is sent, and again on the bytes streamed.
 */
async function hostAdapterArtifact(): Promise<RuntimeArtifact> {
  const path = adapterTarPath()
  if (!existsSync(path)) {
    throw new VaultRuntimeError(runtimeHost.isPackaged
      ? 'This installation carries no Claude adapter for vaults.'
      : `No Claude adapter tar at ${path}; run \`npx electron-vite build\`.`)
  }
  const sha256 = await fileSha256(path)
  if (sha256 !== RUNTIME_PINS.claude.vaultAdapterTarSha256) {
    logger.error('the Claude adapter tar does not match its pin', { expected: RUNTIME_PINS.claude.vaultAdapterTarSha256, actual: sha256 })
    throw new VaultRuntimeError('The Claude adapter files in this installation are not the ones this app pins.')
  }
  return {
    engine: 'claude', version: claudeAdapterVersionLabel(), kind: 'adapter', name: 'claude-agent-acp',
    open: () => readFileChunks(path),
    expectedSha256: RUNTIME_PINS.claude.vaultAdapterTarSha256
  }
}

/** The Codex adapter tar this build carries ({@link CODEX_ADAPTER_TAR_PATH}), checked against its pin first. */
async function codexAdapterArtifact(): Promise<RuntimeArtifact> {
  const path = adapterTarPath(CODEX_ADAPTER_TAR_PATH)
  if (!existsSync(path)) {
    throw new VaultRuntimeError(runtimeHost.isPackaged
      ? 'This installation carries no Codex adapter for vaults.'
      : `No Codex adapter tar at ${path}; run \`npx electron-vite build\`.`)
  }
  const sha256 = await fileSha256(path)
  if (sha256 !== RUNTIME_PINS.codex.vaultAdapterTarSha256) {
    logger.error('the Codex adapter tar does not match its pin', { expected: RUNTIME_PINS.codex.vaultAdapterTarSha256, actual: sha256 })
    throw new VaultRuntimeError('The Codex adapter files in this installation are not the ones this app pins.')
  }
  return {
    engine: 'codex', version: codexAdapterVersionLabel(), kind: 'adapter', name: 'codex-acp',
    open: () => readFileChunks(path),
    expectedSha256: RUNTIME_PINS.codex.vaultAdapterTarSha256
  }
}

/** Every row an engine's real runtimes install, with the hash each must have ({@link RuntimeSource.pins}). */
export function pinnedVaultRuntimes(engine: VaultEngine): RuntimePin[] {
  switch (engine) {
    case 'claude':
      return [
        { engine, kind: 'executable', version: RUNTIME_PINS.claude.cli, sha256: RUNTIME_PINS.claude.assets[GUEST_PLATFORM]?.sha256 ?? '' },
        { engine, kind: 'adapter', version: claudeAdapterVersionLabel(), sha256: RUNTIME_PINS.claude.vaultAdapterTarSha256 }
      ]
    case 'codex':
      return [
        { engine, kind: 'archive', version: RUNTIME_PINS.codex.cli, sha256: RUNTIME_PINS.codex.vaultRuntimeTarSha256 },
        { engine, kind: 'adapter', version: codexAdapterVersionLabel(), sha256: RUNTIME_PINS.codex.vaultAdapterTarSha256,
          // A vault set up on 0.12.0 runs the five-edit patch; it is the same adapter there (RUNTIME_PINS.codex.vaultAdapterEarlier).
          accepted: [{ version: codexAdapterVersionLabel(RUNTIME_PINS.codex.vaultAdapterEarlier.patchedSha256), sha256: RUNTIME_PINS.codex.vaultAdapterEarlier.tarSha256 }] }
      ]
    case 'opencode':
      return [{ engine, kind: 'archive', version: RUNTIME_PINS.opencode.cli, sha256: RUNTIME_PINS.opencode.assets[GUEST_PLATFORM]?.sha256 ?? '' }]
    case 'antigravity':
      return [{ engine, kind: 'archive', version: RUNTIME_PINS.antigravity.cli, sha256: RUNTIME_PINS.antigravity.vaultRuntimeTarSha256 }]
  }
}

/** The real source: pinned downloads + this app's own adapter tars. */
export function defaultRuntimeSource(): RuntimeSource {
  return {
    pins: pinnedVaultRuntimes,
    async artifacts(engine) {
      switch (engine) {
        case 'claude': {
          const adapter = await hostAdapterArtifact()
          const executable = await guestClaudeExecutable()
          return [
            {
              engine: 'claude', version: RUNTIME_PINS.claude.cli, kind: 'executable', name: 'claude',
              open: () => readFileChunks(executable),
              expectedSha256: RUNTIME_PINS.claude.assets[GUEST_PLATFORM]!.sha256
            },
            adapter
          ]
        }
        case 'codex': {
          const adapter = await codexAdapterArtifact()
          const dir = await guestCodexDir()
          return [
            await pinnedRuntimeTar('codex', RUNTIME_PINS.codex.cli, dir, ['codex', 'codex-code-mode-host'], 'codex', RUNTIME_PINS.codex.vaultRuntimeTarSha256),
            adapter
          ]
        }
        case 'opencode': {
          const archive = await guestOpencodeArchive()
          return [{
            engine: 'opencode', version: RUNTIME_PINS.opencode.cli, kind: 'archive', name: 'package/bin/opencode',
            open: () => readFileChunks(archive),
            expectedSha256: RUNTIME_PINS.opencode.assets[GUEST_PLATFORM]!.sha256
          }]
        }
        case 'antigravity': {
          const asset = RUNTIME_PINS.antigravity.assets[GUEST_PLATFORM]!
          const dir = await guestAntigravityDir()
          const executable = asset.executable ?? 'agy_acp_server.par'
          return [await pinnedRuntimeTar('antigravity', RUNTIME_PINS.antigravity.cli, dir, [executable, ...(asset.siblings ?? [])], executable, RUNTIME_PINS.antigravity.vaultRuntimeTarSha256)]
        }
      }
    }
  }
}

/**
 * The fake backend's source (its "guest" is this computer): the `claude` and
 * `codex` this app resolved for itself (`resolveClaude`, `resolveCodex`, which
 * never download when the download is switched off, as in E2E) and the
 * adapters this build carries, and the `antigravity` server it resolved
 * (`resolveAntigravity`; it has no adapter). No network, and no pin to compare
 * the executables with: the guest's hash must equal what main streamed.
 * OpenCode ships Linux builds only for vaults, so it is not offered.
 */
export function hostRuntimeSource(resolveClaude: () => Promise<string>, resolveCodex?: () => Promise<string>, resolveAntigravity?: () => Promise<string>): RuntimeSource {
  /** The engines this computer runs for the fake: how to find its executable, what to call it, and its adapter. */
  const hosts: Partial<Record<VaultEngine, { resolve: () => Promise<string>; label: string; short: string; adapter: (() => Promise<RuntimeArtifact>) | null }>> = {
    claude: { resolve: resolveClaude, label: 'Claude Code', short: 'Claude', adapter: hostAdapterArtifact },
    ...(resolveCodex ? { codex: { resolve: resolveCodex, label: 'Codex', short: 'Codex', adapter: codexAdapterArtifact } } : {}),
    ...(resolveAntigravity ? { antigravity: { resolve: resolveAntigravity, label: 'Antigravity', short: 'Antigravity', adapter: null } } : {})
  }
  const offered = Object.values(hosts).map((host) => host.short)
  const offeredWords = offered.length > 1 ? `${offered.slice(0, -1).join(', ')} or ${offered.at(-1)}` : offered[0]
  const version = (engine: VaultEngine): string => `${RUNTIME_PINS[engine].cli}-host`
  return {
    // As `artifacts` below: this computer's executable (nothing pins it) and the pinned adapter.
    pins: (engine) => hosts[engine]
      ? [{ engine, kind: 'executable', version: version(engine), sha256: null }, ...pinnedVaultRuntimes(engine).filter((pin) => pin.kind === 'adapter')]
      : [],
    async artifacts(engine) {
      const host = hosts[engine]
      // The others ship Linux builds only for vaults; the fake's "guest" is this Mac.
      if (!host) throw new VaultRuntimeError(`The test backend runs agents in a vault on ${offeredWords} only, not ${engine}.`)
      // The adapter first: a build that wrote none is the likelier problem, and its words name the fix.
      const adapter = host.adapter ? await host.adapter() : null
      let executable: string
      try {
        executable = await host.resolve()
      } catch (error) {
        throw new VaultRuntimeError(`${host.label} is not available on this computer: ${error instanceof Error ? error.message : String(error)}`)
      }
      const artifact: RuntimeArtifact = { engine, version: version(engine), kind: 'executable', name: engine, open: () => readFileChunks(executable), expectedSha256: null }
      return adapter ? [artifact, adapter] : [artifact]
    }
  }
}
