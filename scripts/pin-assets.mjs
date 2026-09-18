// Print url + sha256 (+ size) for EVERY platform of one runtime version, ready
// to paste into src/shared/runtimePins.ts.
//
//   node --experimental-strip-types scripts/pin-assets.mjs claude 2.1.277
//   node --experimental-strip-types scripts/pin-assets.mjs codex 0.156.0
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
//   use it before committing a bump. (The 2.1.276 rows were verified that way.)
//
// The platform list is the pinned one: a platform is added by adding its row to
// runtimePins.ts first, deliberately.
import { createHash } from 'node:crypto'
import { RUNTIME_PINS } from '../src/shared/runtimePins.ts'

const [tool, version] = process.argv.slice(2)
const verify = process.argv.includes('--verify')
if (!['codex', 'claude'].includes(tool) || !version || version.startsWith('--')) {
  console.error('usage: pin-assets.mjs <codex|claude> <version> [--verify]')
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
} else {
  const pin = RUNTIME_PINS.codex
  for (const [platform, asset] of Object.entries(pin.assets)) {
    const url = asset.url.replace(`rust-v${pin.cli}`, `rust-v${version}`)
    log(`downloading ${url}`)
    const { sha256, size } = await hashUrl(url)
    const triple = asset.executable.replace(/^codex-/, '')
    const archive = asset.file.endsWith('.zip') ? 'zip' : 'tar.gz'
    rows.push({ platform, url, sha256, size, source: 'downloaded',
      paste: `'${platform}': codexAsset(\n  '${triple}',\n  '${archive}',\n  '${sha256}',\n  ${size}\n),` })
  }
}

for (const row of rows) log(`${row.platform}  ${row.sha256}  ${row.size} bytes  (${row.source})\n  ${row.url}`)
log(`\n--- paste into RUNTIME_PINS.${tool}.assets, and set the version constant to '${version}':`)
console.log(rows.map((row) => row.paste).join('\n'))
