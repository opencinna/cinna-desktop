#!/usr/bin/env node
// npm run vault:pin-guest -- --app-version <x.y.z> [--guest-dir <dir>] [--stage-dir <dir>]
//
// After a RELEASE=1 `make vault-image`: prints the `const VAULT_GUEST` block to
// paste into src/shared/runtimePins.ts, its four assets on the GitHub release
// v<x.y.z> under their fixed names, and the `gh release upload` command that
// puts them there. It stages the files under those names in
// build/vault-guest-release/<version>/ and uploads nothing: the command is
// printed for the release step to run.
'use strict'
const { copyFileSync, existsSync, linkSync, mkdirSync, rmSync, statSync } = require('node:fs')
const { join, relative } = require('node:path')
const { LOCK_FILES, assetNames, pinBlock, readGuestLock, sha256File } = require('./guest-pin.cjs')

const ROOT = join(__dirname, '..', '..')

function fail(message) {
  console.error(`vault:pin-guest: ${message}`)
  process.exit(1)
}

function args(argv) {
  const out = { appVersion: null, guestDir: join(ROOT, 'build', 'vault-guest'), stageDir: join(ROOT, 'build', 'vault-guest-release') }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app-version') out.appVersion = argv[++i]
    else if (argv[i] === '--guest-dir') out.guestDir = argv[++i]
    else if (argv[i] === '--stage-dir') out.stageDir = argv[++i]
    else fail(`unknown argument ${argv[i]}`)
  }
  return out
}

const { appVersion, guestDir, stageDir } = args(process.argv.slice(2))
if (!appVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(appVersion)) {
  fail('--app-version <x.y.z> is required: the app release that first ships this guest (its assets are uploaded there)')
}
const lock = readGuestLock(guestDir)
if (!lock) fail(`no guest.lock.json in ${guestDir}; run RELEASE=1 make vault-image`)
if (lock.vaultd?.placeholder !== false) {
  fail(`${guestDir} was built with the placeholder vaultd; rebuild with npx electron-vite build && RELEASE=1 make vault-image`)
}
if (!/^[A-Za-z0-9._+-]{1,64}$/.test(String(lock.version ?? ''))) fail(`guest.lock.json: bad version ${lock.version}`)
if (!/^[0-9a-f]{64}$/.test(String(lock.rootHash ?? ''))) fail('guest.lock.json: rootHash must be 64 hex digits')
if (!Number.isSafeInteger(lock.hashOffset) || lock.hashOffset <= 0) fail('guest.lock.json: bad hashOffset')
for (const file of Object.values(LOCK_FILES)) {
  if (!lock.files?.[file]?.sha256 || !Number.isSafeInteger(lock.files[file].size)) fail(`guest.lock.json: no sha256/size for ${file}`)
  if (!existsSync(join(guestDir, file))) fail(`${file} is missing from ${guestDir}`)
}
// The pin is printed from the lock: the files uploaded must be those bytes.
for (const file of Object.values(LOCK_FILES)) {
  const path = join(guestDir, file)
  const size = statSync(path).size
  if (size !== lock.files[file].size) fail(`${file} is ${size} bytes, guest.lock.json says ${lock.files[file].size}; rebuild with RELEASE=1 make vault-image`)
  if (sha256File(path) !== lock.files[file].sha256) fail(`${file} does not hash to guest.lock.json's sha256; rebuild with RELEASE=1 make vault-image`)
}

// Staged under the asset names: `gh release upload` names an asset after its file.
const names = assetNames(lock.version)
const stage = join(stageDir, lock.version)
mkdirSync(stage, { recursive: true })
const staged = []
for (const [key, file] of [...Object.entries(LOCK_FILES), ['lock', 'guest.lock.json']]) {
  const dest = join(stage, names[key])
  rmSync(dest, { force: true })
  try {
    linkSync(join(guestDir, file), dest)
  } catch {
    copyFileSync(join(guestDir, file), dest)
  }
  staged.push(dest)
}

const rel = (p) => relative(process.cwd(), p) || p
console.log(`// Paste over the VAULT_GUEST block in src/shared/runtimePins.ts (guest ${lock.version}, assets on release v${appVersion}):\n`)
console.log(pinBlock(lock, appVersion))
console.log(`\n# Upload to the draft release v${appVersion} before it is published (not run by this script):`)
console.log(`gh release upload v${appVersion} --repo opencinna/cinna-desktop ${staged.map((p) => `'${rel(p)}'`).join(' ')}`)
console.log('\n# Then build the release helper from exactly this guest: make vault-release')
