// The Agent Vault guest pin, as the release scripts see it: `RUNTIME_PINS.vaultGuest`
// read by text from src/shared/runtimePins.ts (the `const VAULT_GUEST` block), the
// guest.lock.json `make vault-image` writes, and the comparisons between the two.
//
// Used by scripts/vault/pin-guest.cjs (npm run vault:pin-guest), release-helper.cjs
// (make vault-release), build-helper.sh (the FLAVOR=release guard) and
// scripts/packaged-dependencies.cjs (the packaged helper check).
//
// CLI (for build-helper.sh):
//   node scripts/vault/guest-pin.cjs check-release <guestDir>
//     exit 0 when <guestDir>'s guest.lock.json, Image and initrd.img are the
//     published pin's; else every mismatch on stderr and exit 1.
'use strict'
const { createHash } = require('node:crypto')
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..', '..')
const RELEASE_BASE = 'https://github.com/opencinna/cinna-desktop/releases/download'
/** guest.lock.json `files` key per pin entry. */
const LOCK_FILES = { kernel: 'Image', initrd: 'initrd.img', rootfs: 'rootfs.img' }

/** The fixed release asset names of guest `version`. */
function assetNames(version) {
  return {
    kernel: `vault-guest-${version}-Image`,
    initrd: `vault-guest-${version}-initrd.img`,
    rootfs: `vault-guest-${version}-rootfs.img`,
    lock: `vault-guest-${version}.lock.json`
  }
}

/** Where a release asset of app version `appVersion` downloads from. */
function releaseUrl(appVersion, file) {
  return `${RELEASE_BASE}/v${appVersion}/${file}`
}

/**
 * `RUNTIME_PINS.vaultGuest` from the source the app compiles in. The block is
 * plain literals (single-quoted strings, numbers, booleans, nested objects):
 * turned into JSON and parsed, never evaluated.
 */
function readVaultGuestPin(projectDir = ROOT) {
  const source = readFileSync(join(projectDir, 'src', 'shared', 'runtimePins.ts'), 'utf8')
  const match = /\nconst VAULT_GUEST: VaultGuestPin = (\{[\s\S]*?\n\})\n/.exec(source)
  if (!match) throw new Error('src/shared/runtimePins.ts has no `const VAULT_GUEST: VaultGuestPin = { … }` block')
  const json = match[1]
    .replace(/'((?:[^'\\\n]|\\.)*)'/g, (_m, s) => JSON.stringify(s.replace(/\\'/g, "'")))
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/,(\s*[}\]])/g, '$1')
  let pin
  try {
    pin = JSON.parse(json)
  } catch (error) {
    throw new Error(`src/shared/runtimePins.ts: the VAULT_GUEST block is not plain literals (${error.message})`)
  }
  if (typeof pin.published !== 'boolean' || typeof pin.version !== 'string') throw new Error('VAULT_GUEST: published and version are required')
  for (const key of Object.keys(LOCK_FILES)) {
    const asset = pin[key]
    if (!asset || typeof asset.sha256 !== 'string' || typeof asset.size !== 'number' || typeof asset.url !== 'string') {
      throw new Error(`VAULT_GUEST.${key} must be { file, url, sha256, size }`)
    }
  }
  return pin
}

function readGuestLock(dir) {
  const path = join(dir, 'guest.lock.json')
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * What differs between a guest.lock.json and the pin; empty = the same image.
 * `keys` picks the pin entries whose sha256 (and size, when `sizes`) count.
 */
function lockMismatches(lock, pin, { keys = Object.keys(LOCK_FILES), sizes = true } = {}) {
  if (!lock) return ['there is no guest.lock.json']
  const out = []
  if (String(lock.version) !== pin.version) out.push(`version ${lock.version} ≠ pinned ${pin.version}`)
  if (String(lock.rootHash).toLowerCase() !== pin.rootHash.toLowerCase()) out.push(`rootHash ${String(lock.rootHash).slice(0, 12)}… ≠ pinned ${pin.rootHash.slice(0, 12)}…`)
  if (Number(lock.hashOffset) !== pin.hashOffset) out.push(`hashOffset ${lock.hashOffset} ≠ pinned ${pin.hashOffset}`)
  for (const key of keys) {
    const file = LOCK_FILES[key]
    const got = lock.files?.[file]
    if (!got || got.sha256 !== pin[key].sha256) out.push(`${file} sha256 ${got?.sha256?.slice(0, 12) ?? 'none'}… ≠ pinned ${pin[key].sha256.slice(0, 12)}…`)
    else if (sizes && got.size !== pin[key].size) out.push(`${file} size ${got.size} ≠ pinned ${pin[key].size}`)
  }
  return out
}

/**
 * Why `guestDir` cannot go into a release helper: the pin is unpublished, or
 * the lock or the Image / initrd.img bytes (the two the helper bundles) are
 * not the pinned ones. Empty = fine.
 */
function releaseGuestProblems(guestDir, pin = readVaultGuestPin()) {
  if (!pin.published) return ['RUNTIME_PINS.vaultGuest is unpublished (published: false); a release helper is built only from a published guest pin']
  const lock = readGuestLock(guestDir)
  const out = lockMismatches(lock, pin, { keys: ['kernel', 'initrd'], sizes: false }).map((m) => `guest.lock.json: ${m}`)
  for (const key of ['kernel', 'initrd']) {
    const path = join(guestDir, LOCK_FILES[key])
    if (!existsSync(path)) out.push(`${LOCK_FILES[key]} is missing`)
    else if (sha256File(path) !== pin[key].sha256) out.push(`${LOCK_FILES[key]} does not hash to the pinned sha256`)
  }
  return out
}

/** The `const VAULT_GUEST` block for a guest.lock.json, its assets on release v`appVersion`. */
function pinBlock(lock, appVersion) {
  const names = assetNames(lock.version)
  const entry = (key) => {
    const f = lock.files[LOCK_FILES[key]]
    return `  ${key}: {\n    file: '${names[key]}',\n    url: '${releaseUrl(appVersion, names[key])}',\n    sha256: '${f.sha256}',\n    size: ${f.size}\n  }`
  }
  return [
    'const VAULT_GUEST: VaultGuestPin = {',
    '  published: true,',
    `  version: '${lock.version}',`,
    `  rootHash: '${lock.rootHash}',`,
    `  hashOffset: ${lock.hashOffset},`,
    `${entry('kernel')},`,
    `${entry('initrd')},`,
    entry('rootfs'),
    '}'
  ].join('\n')
}

module.exports = { LOCK_FILES, RELEASE_BASE, assetNames, releaseUrl, readVaultGuestPin, readGuestLock, lockMismatches, releaseGuestProblems, pinBlock, sha256File }

if (require.main === module) {
  const [command, dir] = process.argv.slice(2)
  if (command !== 'check-release' || !dir) {
    console.error('usage: node scripts/vault/guest-pin.cjs check-release <guestDir>')
    process.exit(2)
  }
  const problems = releaseGuestProblems(dir)
  if (problems.length > 0) {
    console.error(`build-helper: FLAVOR=release refuses ${dir}: it is not the pinned guest (RUNTIME_PINS.vaultGuest):`)
    for (const p of problems) console.error(`  - ${p}`)
    console.error('build-helper: use make vault-release, which builds from the pinned guest.')
    process.exit(1)
  }
}
