// Install a runtime CLI outside the app, for the contract tests and probes.
//
//   node --experimental-strip-types scripts/install-runtime.mjs codex
//   node --experimental-strip-types scripts/install-runtime.mjs claude
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
  }
}

const args = process.argv.slice(2)
const tool = args[0]
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
if (!Object.hasOwn(TOOLS, tool)) {
  console.error('usage: install-runtime.mjs <codex|claude> [--version <x.y.z>] [--dir <directory>]')
  process.exit(2)
}

const { pin, candidateUrl, versionOutput } = TOOLS[tool]
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
const installed = join(installDir, tool)
const log = (line) => console.error(line)

const sha256 = (path) => new Promise((done, fail) => {
  const hash = createHash('sha256')
  createReadStream(path).on('error', fail).on('data', (chunk) => hash.update(chunk)).on('end', () => done(hash.digest('hex')))
})
const versionOf = (path) => {
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

if (existsSync(installed)) {
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
    log(`downloading ${url}`)
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`)
    // Streamed: a 215 MB executable is not something to hold in one Buffer.
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive))
  }
  const digest = await sha256(archive)
  if (pinned && digest !== row.sha256) {
    throw new Error(`checksum mismatch for the pinned ${row.file}: expected ${row.sha256}, got ${digest}. Nothing was installed.`)
  }
  log(pinned ? `sha256 verified: ${digest}` : `UNVERIFIED candidate — sha256 ${platform}: ${digest}`)
  const unpacked = join(staging, 'unpacked')
  mkdirSync(unpacked)
  const binary = join(unpacked, tool)
  if (row.format === 'executable') {
    // The asset is the executable: nothing to unpack, only to put in place.
    renameSync(archive, binary)
  } else {
    const tar = spawnSync('tar', ['-xf', archive, '-C', unpacked], { encoding: 'utf8' })
    if (tar.status !== 0) throw new Error(`could not unpack: ${tar.stderr.trim()}`)
    const found = readdirSync(unpacked).find((name) => name === row.executable || name === tool)
    if (!found) throw new Error(`the archive did not contain ${row.executable ?? tool}`)
    if (found !== tool) renameSync(join(unpacked, found), binary)
  }
  chmodSync(binary, 0o755)
  const reported = versionOf(binary)
  if (reported !== versionOutput(version)) throw new Error(`expected ${versionOutput(version)}, the binary reports ${reported}`)
  renameSync(unpacked, installDir)
  log(`installed ${reported}`)
  console.log(installed)
} catch (error) {
  log(String(error instanceof Error ? error.message : error))
  process.exitCode = 1
} finally {
  rmSync(staging, { recursive: true, force: true })
}
