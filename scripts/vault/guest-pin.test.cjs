const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { assetNames, lockMismatches, pinBlock, readVaultGuestPin, releaseGuestProblems, releaseUrl } = require('./guest-pin.cjs')

const sha = (data) => createHash('sha256').update(data).digest('hex')

// A guest dir as make vault-image leaves it, and a project whose VAULT_GUEST
// block is what vault:pin-guest printed for it.
function setup(t, { published = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cinna-guest-pin-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const guest = join(root, 'guest')
  mkdirSync(guest)
  const files = { Image: 'kernel bytes', 'initrd.img': 'initrd bytes', 'rootfs.img': 'rootfs bytes' }
  for (const [name, data] of Object.entries(files)) writeFileSync(join(guest, name), data)
  const lock = {
    version: '1.0.0-20261114',
    rootHash: 'd'.repeat(64),
    hashOffset: 4096,
    files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, { sha256: sha(data), size: data.length }])),
    vaultd: { sha256: 'e'.repeat(64), placeholder: false }
  }
  writeFileSync(join(guest, 'guest.lock.json'), JSON.stringify(lock))
  const project = join(root, 'project')
  mkdirSync(join(project, 'src', 'shared'), { recursive: true })
  const block = pinBlock(lock, '0.12.0').replace('published: true', `published: ${published}`)
  writeFileSync(join(project, 'src', 'shared', 'runtimePins.ts'), `import x from 'y'\n\n${block}\n\nexport const RUNTIME_PINS = { vaultGuest: VAULT_GUEST }\n`)
  return { root, guest, lock, project }
}

test('the printed pin block parses back to the lock, with the fixed asset names on the app release', (t) => {
  const { lock, project } = setup(t)
  const pin = readVaultGuestPin(project)
  assert.equal(pin.published, true)
  assert.equal(pin.version, lock.version)
  assert.equal(pin.rootHash, lock.rootHash)
  assert.equal(pin.hashOffset, 4096)
  assert.deepEqual(pin.kernel, {
    file: 'vault-guest-1.0.0-20261114-Image',
    url: 'https://github.com/opencinna/cinna-desktop/releases/download/v0.12.0/vault-guest-1.0.0-20261114-Image',
    sha256: lock.files.Image.sha256,
    size: lock.files.Image.size
  })
  assert.equal(pin.initrd.file, assetNames(lock.version).initrd)
  assert.equal(pin.rootfs.url, releaseUrl('0.12.0', 'vault-guest-1.0.0-20261114-rootfs.img'))
  assert.deepEqual(lockMismatches(lock, pin), [])
  assert.match(lockMismatches({ ...lock, hashOffset: 8192 }, pin).join(), /hashOffset 8192/)
  assert.match(lockMismatches({ ...lock, files: { ...lock.files, 'rootfs.img': { sha256: 'f'.repeat(64), size: 1 } } }, pin).join(), /rootfs\.img sha256/)
})

test('a release helper is built only from the published pin: lock and the bundled bytes', (t) => {
  const { guest, project } = setup(t)
  const pin = readVaultGuestPin(project)
  assert.deepEqual(releaseGuestProblems(guest, pin), [])
  assert.match(releaseGuestProblems(guest, { ...pin, published: false }).join(), /unpublished/)
  assert.match(releaseGuestProblems(guest, { ...pin, version: '1.0.0-1' }).join(), /version 1\.0\.0-20261114 ≠ pinned 1\.0\.0-1/)
  assert.match(releaseGuestProblems(guest, { ...pin, rootHash: 'a'.repeat(64) }).join(), /rootHash/)
  assert.match(releaseGuestProblems(guest, { ...pin, hashOffset: 1 }).join(), /hashOffset/)
  assert.match(releaseGuestProblems(guest, { ...pin, initrd: { ...pin.initrd, sha256: 'a'.repeat(64) } }).join(), /initrd\.img sha256/)
  // The lock is right but the kernel on disk is not the pinned one.
  writeFileSync(join(guest, 'Image'), 'another kernel')
  assert.match(releaseGuestProblems(guest, pin).join(), /Image does not hash to the pinned sha256/)
})

test('the repo pin parses, and the check-release CLI refuses an unpublished one', () => {
  const pin = readVaultGuestPin()
  assert.equal(typeof pin.published, 'boolean')
  if (pin.published) return
  const run = spawnSync(process.execPath, [join(__dirname, 'guest-pin.cjs'), 'check-release', tmpdir()], { encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /FLAVOR=release refuses .*unpublished/s)
})

test('vault:pin-guest refuses a placeholder vaultd and a missing --app-version, and prints the block and the upload command', (t) => {
  const { guest, root } = setup(t)
  const script = join(__dirname, 'pin-guest.cjs')
  const noVersion = spawnSync(process.execPath, [script, '--guest-dir', guest, '--stage-dir', join(root, 'stage')], { encoding: 'utf8', cwd: root })
  assert.equal(noVersion.status, 1)
  assert.match(noVersion.stderr, /--app-version <x\.y\.z> is required/)
  const ok = spawnSync(process.execPath, [script, '--app-version', '0.12.0', '--guest-dir', guest, '--stage-dir', join(root, 'stage')], { encoding: 'utf8', cwd: root })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /const VAULT_GUEST: VaultGuestPin = \{\n {2}published: true,/)
  assert.match(ok.stdout, /gh release upload v0\.12\.0 --repo opencinna\/cinna-desktop .*vault-guest-1\.0\.0-20261114-Image.*vault-guest-1\.0\.0-20261114-initrd\.img.*vault-guest-1\.0\.0-20261114-rootfs\.img.*vault-guest-1\.0\.0-20261114\.lock\.json/)
  // A file that is not the bytes the lock names: refused, nothing printed.
  writeFileSync(join(guest, 'rootfs.img'), 'rootfs bytez')
  const badHash = spawnSync(process.execPath, [script, '--app-version', '0.12.0', '--guest-dir', guest, '--stage-dir', join(root, 'stage')], { encoding: 'utf8', cwd: root })
  assert.equal(badHash.status, 1)
  assert.match(badHash.stderr, /rootfs\.img does not hash to guest\.lock\.json's sha256/)
  assert.doesNotMatch(badHash.stdout, /gh release upload/)
  writeFileSync(join(guest, 'initrd.img'), 'initrd bytes!')
  const badSize = spawnSync(process.execPath, [script, '--app-version', '0.12.0', '--guest-dir', guest, '--stage-dir', join(root, 'stage')], { encoding: 'utf8', cwd: root })
  assert.equal(badSize.status, 1)
  assert.match(badSize.stderr, /initrd\.img is 13 bytes, guest\.lock\.json says 12/)
  writeFileSync(join(guest, 'rootfs.img'), 'rootfs bytes')
  writeFileSync(join(guest, 'initrd.img'), 'initrd bytes')
  const placeholder = JSON.parse(require('node:fs').readFileSync(join(guest, 'guest.lock.json'), 'utf8'))
  placeholder.vaultd.placeholder = true
  writeFileSync(join(guest, 'guest.lock.json'), JSON.stringify(placeholder))
  const refused = spawnSync(process.execPath, [script, '--app-version', '0.12.0', '--guest-dir', guest, '--stage-dir', join(root, 'stage')], { encoding: 'utf8', cwd: root })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /placeholder vaultd/)
})

test('make vault-release takes build/vault-guest only when it is the pin, else downloads and checks the pinned assets', async (t) => {
  const { createServer } = require('node:http')
  const { existsSync, readFileSync, cpSync } = require('node:fs')
  const { guest, lock, project, root } = setup(t)
  const bodies = { '/k': 'kernel bytes', '/i': 'initrd bytes', '/r': 'rootfs bytes' }
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    const body = bodies[req.url]
    if (body === undefined) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  // The pin's URLs point at the local server.
  const pins = join(project, 'src', 'shared', 'runtimePins.ts')
  writeFileSync(pins, readFileSync(pins, 'utf8')
    .replace(/url: '[^']*-Image'/, `url: '${base}/k'`).replace(/url: '[^']*-initrd\.img'/, `url: '${base}/i'`).replace(/url: '[^']*-rootfs\.img'/, `url: '${base}/r'`))
  const run = () => new Promise((resolve) => {
    const child = require('node:child_process').spawn(process.execPath, [join(__dirname, 'release-helper.cjs'), '--dry-run', '--project', project], { cwd: root })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (status) => resolve({ status, out }))
  })

  // build/vault-guest is the pinned guest: used as is, nothing downloaded.
  cpSync(guest, join(project, 'build', 'vault-guest'), { recursive: true })
  let r = await run()
  assert.equal(r.status, 0, r.out)
  assert.match(r.out, /build\/vault-guest\/ is the pinned guest/)
  assert.match(r.out, new RegExp(`VAULT_GUEST_DIR=${join(project, 'build', 'vault-guest')} FLAVOR=release`))
  assert.equal(hits, 0)

  // Another local guest: the pinned assets are downloaded, checked and cached.
  const other = JSON.parse(readFileSync(join(project, 'build', 'vault-guest', 'guest.lock.json'), 'utf8'))
  other.rootHash = 'f'.repeat(64)
  writeFileSync(join(project, 'build', 'vault-guest', 'guest.lock.json'), JSON.stringify(other))
  r = await run()
  assert.equal(r.status, 0, r.out)
  const dir = join(project, 'build', 'vault-release-guest', lock.version)
  assert.match(r.out, new RegExp(`VAULT_GUEST_DIR=${dir} FLAVOR=release`))
  assert.equal(hits, 3)
  assert.equal(readFileSync(join(dir, 'initrd.img'), 'utf8'), 'initrd bytes')
  const made = JSON.parse(readFileSync(join(dir, 'guest.lock.json'), 'utf8'))
  assert.deepEqual(lockMismatches(made, readVaultGuestPin(project)), [])
  r = await run()
  assert.equal(hits, 3, 'cached files are not downloaded again')

  // Bytes that are not the pinned ones are refused and not kept.
  rmSync(join(dir, 'rootfs.img'))
  bodies['/r'] = 'a captive portal'
  r = await run()
  assert.equal(r.status, 1)
  assert.match(r.out, /not the pinned ones/)
  assert.equal(existsSync(join(dir, 'rootfs.img')), false)
  assert.equal(existsSync(join(dir, 'rootfs.img.part')), false)

})

test('make vault-release with an unpublished pin ships no helper: removes resources/vault/VaultHelper.app and exits 0 (dry run removes nothing)', (t) => {
  const { existsSync } = require('node:fs')
  const { project } = setup(t, { published: false })
  const helper = join(project, 'resources', 'vault', 'VaultHelper.app')
  mkdirSync(join(helper, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(helper, 'Contents', 'MacOS', 'VaultHelper'), '')
  const run = (...extra) => spawnSync(process.execPath, [join(__dirname, 'release-helper.cjs'), '--project', project, ...extra], { encoding: 'utf8' })
  const message = /RUNTIME_PINS\.vaultGuest is unpublished: this release ships no vault helper; the app reports Agent Vault unavailable/
  const dry = run('--dry-run')
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, message)
  assert.equal(existsSync(helper), true)
  const real = run()
  assert.equal(real.status, 0, real.stderr)
  assert.match(real.stdout, message)
  assert.equal(existsSync(helper), false)
  // Nothing there: the same answer.
  assert.equal(run().status, 0)
})
