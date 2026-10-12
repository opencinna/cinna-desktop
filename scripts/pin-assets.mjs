// Print url + sha256 (+ size) for EVERY platform of one runtime version, ready
// to paste into src/shared/runtimePins.ts.
//
//   node --experimental-strip-types scripts/pin-assets.mjs claude 2.1.277
//   node --experimental-strip-types scripts/pin-assets.mjs codex 0.156.0
//   node --experimental-strip-types scripts/pin-assets.mjs antigravity 1.4.0
//   node --experimental-strip-types scripts/pin-assets.mjs opencode 1.19.1
//
// scripts/install-runtime.mjs prints the digest for the platform it runs on
// only; bumping a pin needs all of them, and doing the other three by hand is
// how a row ends up stale.
//
// **Where each digest comes from, because it is not the same for both:**
//
// - codex  — every archive is DOWNLOADED from the GitHub release and hashed
//   here. The release publishes no digests, so there is nothing else to trust.
// - claude — read from the vendor's own `manifest.json` (`checksum`, `size`) by
//   default: ~900 MB across four platforms is a lot to fetch to re-derive a
//   number the vendor's installer itself trusts. `--verify` downloads each
//   binary anyway and refuses a row whose bytes disagree with the manifest —
//   use it before committing a bump. (The 2.1.296 rows were verified that way.)
// - antigravity — every zip is DOWNLOADED from Google's release path and
//   hashed here, as for codex: nothing is published to compare against.
// - opencode — every archive is DOWNLOADED from the GitHub release and hashed
//   here, then compared with the `sha256:` digest GitHub publishes per release
//   asset; a row whose bytes disagree is refused. A release the API does not
//   answer for (rate limit, no network to api.github.com) still prints, and
//   says so on its row. Rows carry no size: the app derives none for opencode.
//
// The platform list is the pinned one: a platform is added by adding its row to
// runtimePins.ts first, deliberately.
import { createHash } from 'node:crypto'
import { RUNTIME_PINS } from '../src/shared/runtimePins.ts'

const [tool, version] = process.argv.slice(2)
const verify = process.argv.includes('--verify')
if (!['codex', 'claude', 'antigravity', 'opencode'].includes(tool) || !version || version.startsWith('--')) {
  console.error('usage: pin-assets.mjs <codex|claude|antigravity|opencode> <version> [--verify]')
  process.exit(2)
}
const log = (line) => console.error(line)

/** sha256 + byte length of a URL's body, streamed — never a 200 MB Buffer. */
async function hashUrl(url) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of response.body) { hash.update(chunk); size += chunk.byteLength }
  return { sha256: hash.digest('hex'), size }
}

const rows = []
if (tool === 'claude') {
  const pin = RUNTIME_PINS.claude
  const release = pin.assets[Object.keys(pin.assets)[0]].url.split(`/${pin.cli}/`)[0]
  const manifestUrl = `${release}/${version}/manifest.json`
  log(`reading ${manifestUrl}`)
  const response = await fetch(manifestUrl)
  if (!response.ok) throw new Error(`no manifest for claude ${version}: HTTP ${response.status}`)
  const manifest = await response.json()
  if (manifest.version !== version) throw new Error(`the manifest says version ${manifest.version}, not ${version}`)
  for (const platform of Object.keys(pin.assets)) {
    const entry = manifest.platforms?.[platform]
    if (!entry) throw new Error(`claude ${version} has no ${platform} build`)
    const url = `${release}/${version}/${platform}/${entry.binary}`
    let source = 'manifest'
    if (verify) {
      log(`downloading ${url} (${Math.round(entry.size / 1e6)} MB)`)
      const actual = await hashUrl(url)
      if (actual.sha256 !== entry.checksum || actual.size !== entry.size) {
        throw new Error(`${platform}: the bytes (${actual.sha256}, ${actual.size}) disagree with the manifest (${entry.checksum}, ${entry.size})`)
      }
      source = 'downloaded, matches manifest'
    }
    rows.push({ platform, url, sha256: entry.checksum, size: entry.size, source,
      paste: `'${platform}': claudeAsset('${platform}', '${entry.checksum}', ${entry.size}),` })
  }
} else if (tool === 'antigravity') {
  const pin = RUNTIME_PINS.antigravity
  for (const [platform, asset] of Object.entries(pin.assets)) {
    // The file name carries the version; the release path does not.
    const url = asset.url.replace(`-${pin.cli}-`, `-${version}-`)
    log(`downloading ${url}`)
    const { sha256, size } = await hashUrl(url)
    const os = url.includes('/releases/linux/') ? 'linux' : 'macos'
    const file = url.split('/').pop().replace(`-${version}-`, '-${ANTIGRAVITY_CLI}-')
    rows.push({ platform, url, sha256, size, source: 'downloaded',
      paste: `'${platform}': antigravityAsset(\n  '${os}',\n  \`${file}\`,\n  '${sha256}',\n  ${size}\n),` })
  }
} else if (tool === 'opencode') {
  const release = `https://github.com/anomalyco/opencode/releases/download/v${version}`
  const api = `https://api.github.com/repos/anomalyco/opencode/releases/tags/v${version}`
  /** GitHub's `sha256:` digest per asset name, or the reason there is none. */
  let published
  try {
    log(`reading ${api}`)
    const response = await fetch(api, { headers: { accept: 'application/vnd.github+json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    published = new Map((body.assets ?? []).map((asset) => [asset.name, String(asset.digest ?? '').replace(/^sha256:/, '')]))
  } catch (err) {
    published = err instanceof Error ? err.message : String(err)
  }
  for (const [platform, asset] of Object.entries(RUNTIME_PINS.opencode.assets)) {
    // Same file names every release; the tag carries the version (binaryResolver's `assetUrl`).
    const url = `${release}/${asset.file}`
    log(`downloading ${url}`)
    const { sha256, size } = await hashUrl(url)
    let source = `downloaded; GitHub digest unavailable (${typeof published === 'string' ? published : 'not listed'})`
    const digest = typeof published === 'string' ? undefined : published.get(asset.file)
    if (digest) {
      if (digest !== sha256) throw new Error(`${platform}: the bytes (${sha256}) disagree with GitHub's digest (${digest})`)
      source = 'downloaded, matches GitHub digest'
    }
    rows.push({ platform, url, sha256, size, source,
      paste: `'${platform}': {\n  file: '${asset.file}',\n  sha256: '${sha256}'\n},` })
  }
} else {
  const pin = RUNTIME_PINS.codex
  for (const [platform, asset] of Object.entries(pin.assets)) {
    const url = asset.url.replace(`rust-v${pin.cli}`, `rust-v${version}`)
    log(`downloading ${url}`)
    const { sha256, size } = await hashUrl(url)
    const triple = asset.executable.replace(/^codex-/, '')
    const archive = asset.file.endsWith('.zip') ? 'zip' : 'tar.gz'
    // The companion (`codex-code-mode-host`) is its own archive of the same release.
    const hosts = []
    for (const companion of asset.companions ?? []) {
      const hostUrl = companion.url.replace(`rust-v${pin.cli}`, `rust-v${version}`)
      log(`downloading ${hostUrl}`)
      const host = await hashUrl(hostUrl)
      rows.push({ platform, url: hostUrl, ...host, source: 'downloaded (companion)' })
      hosts.push(`{ sha256: '${host.sha256}', size: ${host.size} }`)
    }
    rows.push({ platform, url, sha256, size, source: 'downloaded',
      paste: `'${platform}': codexAsset(\n  '${triple}',\n  '${archive}',\n  '${sha256}',\n  ${size}${hosts.map((h) => `,\n  ${h}`).join('')}\n),` })
  }
}

for (const row of rows) log(`${row.platform}  ${row.sha256}  ${row.size} bytes  (${row.source})\n  ${row.url}`)
log(`\n--- paste into RUNTIME_PINS.${tool}.assets, and set ${tool === 'opencode' ? 'RUNTIME_PINS.opencode.cli' : 'the version constant'} to '${version}':`)
console.log(rows.filter((row) => row.paste).map((row) => row.paste).join('\n'))
