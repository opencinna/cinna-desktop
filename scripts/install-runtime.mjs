// Install a runtime CLI outside the app, for the contract tests and probes.
//
//   node --experimental-strip-types scripts/install-runtime.mjs codex
//   node --experimental-strip-types scripts/install-runtime.mjs claude
//   node --experimental-strip-types scripts/install-runtime.mjs antigravity
//   node --experimental-strip-types scripts/install-runtime.mjs opencode
//   node --experimental-strip-types scripts/install-runtime.mjs codex --version 0.156.0 --dir /tmp/x
//
// The app installs its own copy into <userData>/runtimes (src/main/engine/
// binaryResolver.ts). Vitest and the probes run under plain Node and cannot ask
// Electron where that is, so this puts the same bytes in a per-machine cache:
// $CINNA_RUNTIME_CACHE, else ~/.cache/cinna-runtimes/<tool>-<version>/<tool>.
//
// The PINNED version is verified against the sha256 in src/shared/runtimePins.ts
// and refused on a mismatch, exactly as the app does. A CANDIDATE version has no
// pin to verify against: it is downloaded from the same vendor release, its
// digest is PRINTED (that line is what goes into the manifest when it becomes
// the pin — `make pin-assets` prints every platform's), and nothing about the
// app changes.
//
// Claude Code is one ~215 MB executable, not an archive. When the machine's own `claude`
// is byte-for-byte the pinned asset (same sha256), those bytes are copied
// instead of downloaded: the digest is the verification either way.
//
// A row's `companions` (Codex's `codex-code-mode-host`) are installed beside
// the executable, each verified against its own pin, before the install is
// published; an existing install that lacks one gets just the missing file.
//
// Antigravity's ACP server is a zip holding `agy_acp_server.par` and its
// sibling `localharness_external`; both stay in the install directory under
// their own names (the server finds its sibling beside itself), and an install
// lacking a sibling is not an install. It is never asked for `--version`: that
// prints absl build info, not a version line, and is slow on a ~280 MB par, so
// the pinned digest is the only proof of version.
//
// OpenCode 2 ships as npm platform tarballs (`@opencode/cli-<target>`, no
// GitHub release); the executable sits at `package/bin/opencode`, so it is
// looked for a couple of levels down, as the app's own `findNamedFile` does.
// A candidate is the same package at another version.
//
// Prints the installed executable's absolute path as its last stdout line.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { RUNTIME_PINS } from '../src/shared/runtimePins.ts'

/** What differs between the tools: where another version's asset is, and what `--version` must print. */
const TOOLS = {
  codex: {
    pin: RUNTIME_PINS.codex,
    candidateUrl: (row, pin, version) => row.url.replace(`rust-v${pin.cli}`, `rust-v${version}`),
    versionOutput: (version) => `codex-cli ${version}`
  },
  claude: {
    pin: RUNTIME_PINS.claude,
    candidateUrl: (row, pin, version) => row.url.replace(`/${pin.cli}/`, `/${version}/`),
    versionOutput: (version) => `${version} (Claude Code)`
  },
  antigravity: {
    pin: RUNTIME_PINS.antigravity,
    candidateUrl: (row, pin, version) => row.url.replace(`-${pin.cli}-`, `-${version}-`),
    // Versionless: no flag prints one.
    versionOutput: null,
    installName: 'agy_acp_server.par'
  },
  opencode: {
    pin: RUNTIME_PINS.opencode,
    candidateUrl: (row, pin, version) => row.url.replace(`-${pin.cli}.tgz`, `-${version}.tgz`),
    versionOutput: (version) => `opencode v${version}`
  }
}

const args = process.argv.slice(2)
const tool = args[0]
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
if (!Object.hasOwn(TOOLS, tool)) {
  console.error('usage: install-runtime.mjs <codex|claude|antigravity|opencode> [--version <x.y.z>] [--dir <directory>]')
  process.exit(2)
}

const { pin, candidateUrl, versionOutput, installName = tool } = TOOLS[tool]
const version = option('--version') ?? pin.cli
const pinned = version === pin.cli
const platform = `${process.platform}-${process.arch}`
const row = pin.assets[platform]
if (!row) {
  console.error(`No pinned ${tool} asset for ${platform}.`)
  process.exit(1)
}
// A candidate is the same asset of another release: same file name, other version.
const url = pinned ? row.url : candidateUrl(row, pin, version)
const cache = process.env.CINNA_RUNTIME_CACHE ?? join(homedir(), '.cache', 'cinna-runtimes')
const installDir = resolve(option('--dir') ?? join(cache, `${tool}-${version}`))
const installed = join(installDir, installName)
const log = (line) => console.error(line)

const sha256 = (path) => new Promise((done, fail) => {
  const hash = createHash('sha256')
  createReadStream(path).on('error', fail).on('data', (chunk) => hash.update(chunk)).on('end', () => done(hash.digest('hex')))
})
const versionOf = (path) => {
  if (versionOutput === null) return `${tool} (versionless; sha256-verified at install)`
  const out = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 15000 })
  return out.status === 0 ? out.stdout.trim().split('\n')[0] : null
}

/** The machine's own copy, when it is exactly the pinned bytes. Size first: hashing 215 MB to learn "no" is a waste. */
async function localPinnedBytes() {
  if (!pinned || row.format !== 'executable' || !row.size) return null
  const found = spawnSync('which', [tool], { encoding: 'utf8' })
  const onPath = found.status === 0 ? found.stdout.trim().split('\n')[0] : ''
  if (!onPath) return null
  try {
    const real = realpathSync(onPath)
    if (statSync(real).size !== row.size) return null
    return (await sha256(real)) === row.sha256 ? real : null
  } catch {
    return null
  }
}

/**
 * Unpack an archive into `dir`. GNU tar cannot read a zip, so a zip off macOS
 * tries `unzip`, then `bsdtar`, then Python's zipfile — the app's own order.
 */
function unpack(archive, dir) {
  const attempts = archive.endsWith('.zip') && process.platform !== 'darwin'
    ? [['unzip', ['-q', '-o', archive, '-d', dir]], ['bsdtar', ['-xf', archive, '-C', dir]], ['python3', ['-m', 'zipfile', '-e', archive, dir]]]
    : [['tar', ['-xf', archive, '-C', dir]]]
  const errors = []
  for (const [command, commandArgs] of attempts) {
    const out = spawnSync(command, commandArgs, { encoding: 'utf8' })
    if (out.status === 0) return
    errors.push(`${command}: ${(out.error?.message ?? out.stderr ?? '').trim()}`)
  }
  throw new Error(`could not unpack ${archive}: ${errors.join('; ')}`)
}

/** The first file named one of `names` in `dir` or up to `depth` levels below it, or null. */
function findNamed(dir, names, depth = 2) {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) if (entry.isFile() && names.includes(entry.name)) return join(dir, entry.name)
  if (depth <= 0) return null
  for (const entry of entries) {
    const found = entry.isDirectory() ? findNamed(join(dir, entry.name), names, depth - 1) : null
    if (found) return found
  }
  return null
}

/** Stream a URL to a file: a 215 MB executable is not something to hold in one Buffer. */
async function fetchTo(url, dest) {
  log(`downloading ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest))
}

/** Put each companion `dir` lacks into it, verified like the main asset; its archive stays in staging. */
async function installCompanions(dir) {
  for (const companion of row.companions ?? []) {
    const target = join(dir, companion.installAs)
    if (existsSync(target)) continue
    const stage = mkdtempSync(join(dirname(installDir), '.staging-'))
    try {
      const archive = join(stage, companion.file)
      await fetchTo(pinned ? companion.url : candidateUrl(companion, pin, version), archive)
      const digest = await sha256(archive)
      if (pinned && digest !== companion.sha256) {
        throw new Error(`checksum mismatch for the pinned ${companion.file}: expected ${companion.sha256}, got ${digest}. Nothing was installed.`)
      }
      log(pinned ? `sha256 verified: ${companion.file} ${digest}` : `UNVERIFIED candidate — sha256 ${platform} ${companion.file}: ${digest}`)
      unpack(archive, stage)
      const found = join(stage, companion.executable)
      if (!existsSync(found)) throw new Error(`${companion.file} did not contain ${companion.executable}`)
      chmodSync(found, 0o755)
      renameSync(found, target)
      log(`installed ${companion.installAs}`)
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
  }
}

/** Every sibling file the row names, present beside the executable in `dir`. */
const siblingsIn = (dir) => (row.siblings ?? []).every((name) => existsSync(join(dir, name)))

if (existsSync(installed) && !siblingsIn(installDir)) {
  // Published half-way, or a sibling deleted since: install the whole archive again.
  log(`${installDir} lacks ${(row.siblings ?? []).join(', ')}; installing again`)
  rmSync(installDir, { recursive: true, force: true })
}

if (existsSync(installed)) {
  try {
    await installCompanions(installDir)
  } catch (error) {
    log(String(error instanceof Error ? error.message : error))
    process.exit(1)
  }
  log(`already installed: ${versionOf(installed)}`)
  console.log(installed)
  process.exit(0)
}

mkdirSync(dirname(installDir), { recursive: true })
const staging = mkdtempSync(join(dirname(installDir), '.staging-'))
try {
  const archive = join(staging, row.file)
  const local = await localPinnedBytes()
  if (local) {
    log(`reusing ${local}: its sha256 is the pinned one, so nothing is downloaded`)
    copyFileSync(local, archive)
  } else {
    await fetchTo(url, archive)
  }
  const digest = await sha256(archive)
  if (pinned && digest !== row.sha256) {
    throw new Error(`checksum mismatch for the pinned ${row.file}: expected ${row.sha256}, got ${digest}. Nothing was installed.`)
  }
  log(pinned ? `sha256 verified: ${digest}` : `UNVERIFIED candidate — sha256 ${platform}: ${digest}`)
  const unpacked = join(staging, 'unpacked')
  mkdirSync(unpacked)
  const binary = join(unpacked, installName)
  if (row.format === 'executable') {
    // The asset is the executable: nothing to unpack, only to put in place.
    renameSync(archive, binary)
  } else {
    unpack(archive, unpacked)
    const found = findNamed(unpacked, [row.executable, installName].filter(Boolean))
    if (!found) throw new Error(`the archive did not contain ${row.executable ?? installName}`)
    if (found !== binary) renameSync(found, binary)
    const missing = (row.siblings ?? []).filter((name) => !existsSync(join(unpacked, name)))
    if (missing.length > 0) throw new Error(`the archive did not contain ${missing.join(', ')}`)
    for (const name of row.siblings ?? []) chmodSync(join(unpacked, name), 0o755)
  }
  chmodSync(binary, 0o755)
  const reported = versionOf(binary)
  if (versionOutput !== null && reported !== versionOutput(version)) throw new Error(`expected ${versionOutput(version)}, the binary reports ${reported}`)
  await installCompanions(unpacked)
  renameSync(unpacked, installDir)
  log(`installed ${reported}`)
  console.log(installed)
} catch (error) {
  log(String(error instanceof Error ? error.message : error))
  process.exitCode = 1
} finally {
  rmSync(staging, { recursive: true, force: true })
}
