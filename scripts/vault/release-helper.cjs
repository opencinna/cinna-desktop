#!/usr/bin/env node
// make vault-release: the release-flavor helper, built strictly from the pinned guest
// (RUNTIME_PINS.vaultGuest).
//
//   - an unpublished pin: removes resources/vault/VaultHelper.app and exits 0 (the
//     release ships no helper; the app reports Agent Vault unavailable);
//   - uses build/vault-guest/ when its guest.lock.json is exactly the pin (version,
//     rootHash, hashOffset, and the sha256 and size of all three files);
//   - else downloads the three files from the pin's URLs into
//     build/vault-release-guest/<version>/ (kept as a cache; sha256 and size checked,
//     a mismatch refused and deleted) beside a guest.lock.json made from the pin;
//   - then runs VAULT_GUEST_DIR=<that dir> FLAVOR=release sh scripts/vault/build-helper.sh,
//     whose own release guard checks the same pin again.
//
//   --dry-run          choose and verify the source, print the build command, do not build
//   --project <dir>    read the pin and the build/ dirs from <dir> (tests); default the repo
'use strict'
const { createHash } = require('node:crypto')
const { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync, createReadStream } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { LOCK_FILES, lockMismatches, readGuestLock, readVaultGuestPin } = require('./guest-pin.cjs')

const ROOT = join(__dirname, '..', '..')
const DRY = process.argv.includes('--dry-run')
const projectAt = process.argv.indexOf('--project')
const PROJECT = projectAt > 0 ? process.argv[projectAt + 1] : ROOT

function fail(message) {
  console.error(`vault-release: ${message}`)
  process.exit(1)
}

function sha256Of(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject)
  })
}

async function verified(path, asset) {
  if (!existsSync(path)) return false
  if (statSync(path).size !== asset.size) return false
  return (await sha256Of(path)) === asset.sha256
}

async function download(asset, dest) {
  const part = `${dest}.part`
  rmSync(part, { force: true })
  console.log(`vault-release: downloading ${asset.url}`)
  const response = await fetch(asset.url, { redirect: 'follow' })
  if (!response.ok || !response.body) fail(`${asset.url}: HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(part))
  if (!(await verified(part, asset))) {
    rmSync(part, { force: true })
    fail(`${asset.file}: the downloaded bytes are not the pinned ones (sha256 ${asset.sha256.slice(0, 12)}…, ${asset.size} bytes); nothing kept`)
  }
  renameSync(part, dest)
}

async function main() {
  const pin = readVaultGuestPin(PROJECT)
  if (!pin.published) {
    // No guest, no helper: the release ships none and the app reports Agent
    // Vault unavailable (packaging allows that only for an unpublished pin).
    const helper = join(PROJECT, 'resources', 'vault', 'VaultHelper.app')
    if (existsSync(helper)) {
      if (DRY) console.log(`vault-release: --dry-run, would remove ${helper}`)
      else {
        rmSync(helper, { recursive: true, force: true })
        console.log(`vault-release: removed ${helper}`)
      }
    }
    console.log('RUNTIME_PINS.vaultGuest is unpublished: this release ships no vault helper; the app reports Agent Vault unavailable')
    return
  }
  if (!/^[A-Za-z0-9._+-]{1,64}$/.test(pin.version)) fail(`the pinned version ${pin.version} is not a plain version`)

  let guestDir = join(PROJECT, 'build', 'vault-guest')
  const local = readGuestLock(guestDir)
  const localMismatch = local ? lockMismatches(local, pin) : ['no guest.lock.json']
  if (localMismatch.length === 0) {
    console.log(`vault-release: build/vault-guest/ is the pinned guest ${pin.version}`)
  } else {
    console.log(`vault-release: build/vault-guest/ is not the pinned guest (${localMismatch.join('; ')}); using the published assets`)
    guestDir = join(PROJECT, 'build', 'vault-release-guest', pin.version)
    mkdirSync(guestDir, { recursive: true })
    for (const [key, file] of Object.entries(LOCK_FILES)) {
      const dest = join(guestDir, file)
      if (await verified(dest, pin[key])) {
        console.log(`vault-release: ${file} cached, sha256 checked`)
        continue
      }
      rmSync(dest, { force: true })
      if (!pin[key].url) fail(`RUNTIME_PINS.vaultGuest.${key} has no url`)
      await download(pin[key], dest)
    }
    // The lock build-helper reads (and bundles), made from the pin alone.
    const lock = {
      version: pin.version,
      rootHash: pin.rootHash,
      hashOffset: pin.hashOffset,
      files: Object.fromEntries(Object.entries(LOCK_FILES).map(([key, file]) => [file, { sha256: pin[key].sha256, size: pin[key].size }])),
      source: 'RUNTIME_PINS.vaultGuest (make vault-release)'
    }
    writeFileSync(join(guestDir, 'guest.lock.json'), JSON.stringify(lock, null, 2) + '\n')
  }

  const command = `VAULT_GUEST_DIR=${guestDir} FLAVOR=release sh scripts/vault/build-helper.sh`
  if (DRY) {
    console.log(`vault-release: --dry-run, would run: ${command}`)
    return
  }
  console.log(`vault-release: ${command}`)
  const run = spawnSync('sh', [join(ROOT, 'scripts', 'vault', 'build-helper.sh')], {
    stdio: 'inherit',
    env: { ...process.env, VAULT_GUEST_DIR: guestDir, FLAVOR: 'release' }
  })
  process.exit(run.status ?? 1)
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
