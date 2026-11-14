const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, chmodSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { runtimePackages, canvasTargets, prepareCanvasPayload, validateCanvasPayload, beforePack, afterPack, verifyVaultHelper } = require('./packaged-dependencies.cjs')
const { checkDeadline, checkEnvironment, executableArch } = require('./check-packaged-main.cjs')
const codexPatch = require('../src/main/agents/drivers/acp/codexAdapterPatch.json')
const claudePatch = require('../src/main/agents/drivers/acp/claudeAdapterPatch.json')

function copyCodexAdapter(directory) {
  mkdirSync(join(directory, 'dist'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@agentclientprotocol/codex-acp', version: codexPatch.version }))
  copyFileSync(join(__dirname, '../node_modules/@agentclientprotocol/codex-acp/dist/index.js'), join(directory, 'dist/index.js'))
}

// The installed (patched) Claude adapter, as a package `pkg` created.
function copyClaudeAdapter(directory) {
  mkdirSync(join(directory, 'dist'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@agentclientprotocol/claude-agent-acp', version: claudePatch.version, dependencies: { shared: '*' } }))
  copyFileSync(join(__dirname, '../node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'), join(directory, 'dist/acp-agent.js'))
  copyFileSync(join(__dirname, '../node_modules/@agentclientprotocol/claude-agent-acp/dist/native-subagents.js'), join(directory, 'dist/native-subagents.js'))
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cinna-package-tree-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pkg = (name, manifest = {}, parent = root) => {
    const directory = join(parent, 'node_modules', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }))
    return directory
  }
  return { root, pkg }
}

test('follows hoisted, nested, peer and optional dependencies without relying on exports', (t) => {
  const { root, pkg } = fixture(t)
  const agent = pkg('agent', { dependencies: { shared: '*', nested: '*' }, peerDependencies: { peer: '*' } })
  pkg('shared', { exports: './index.js', dependencies: { agent: '*' } }) // cycle
  pkg('nested', { dependencies: { shared: '*' } }, agent)
  pkg('peer', { optionalDependencies: { installed: '*', unavailable: '*' } })
  pkg('installed')
  pkg('unrelated')
  assert.deepEqual(runtimePackages(root, ['agent']), [
    'node_modules/agent', 'node_modules/agent/node_modules/nested',
    'node_modules/installed', 'node_modules/peer', 'node_modules/shared'
  ])
})

test('includes distinct nested versions of the same package', (t) => {
  const { root, pkg } = fixture(t)
  const agent = pkg('agent', { dependencies: { shared: '*' } })
  pkg('shared', {}, agent)
  pkg('shared')
  assert.deepEqual(runtimePackages(root, ['agent', 'shared']), [
    'node_modules/agent', 'node_modules/agent/node_modules/shared', 'node_modules/shared'
  ])
})

test('fails for missing required packages and peers; ignores absent optional peers', (t) => {
  const { root, pkg } = fixture(t)
  pkg('agent', { peerDependencies: { peer: '*' } })
  assert.throws(() => runtimePackages(root, ['agent']), /Missing runtime dependency peer/)
  pkg('agent', { peerDependencies: { peer: '*' }, peerDependenciesMeta: { peer: { optional: true } } })
  assert.deepEqual(runtimePackages(root, ['agent']), ['node_modules/agent'])
  pkg('agent', { dependencies: { peer: '*' }, peerDependencies: { peer: '*' }, peerDependenciesMeta: { peer: { optional: true } } })
  assert.throws(() => runtimePackages(root, ['agent']), /Missing runtime dependency peer/)
})

test('never satisfies a dependency from outside the packaged root', (t) => {
  const { root, pkg } = fixture(t)
  pkg('outside')
  const app = join(root, 'app')
  pkg('agent', { dependencies: { outside: '*' } }, app)
  assert.throws(() => runtimePackages(app, ['agent']), /Missing runtime dependency outside/)
})

test('excludes bundled Claude and Codex CLIs even when installed', (t) => {
  const { root, pkg } = fixture(t)
  const cli = '@anthropic-ai/claude-agent-sdk-darwin-arm64'
  pkg('agent', { optionalDependencies: { [cli]: '*' }, dependencies: { '@openai/codex': '*' } })
  pkg(cli)
  pkg('@openai/codex')
  assert.deepEqual(runtimePackages(root, ['agent']), ['node_modules/agent'])
})

test('build hooks preserve resource patterns and reject a broken shipped tree', async (t) => {
  const { root, pkg } = fixture(t)
  const agent = pkg('@agentclientprotocol/claude-agent-acp', { dependencies: { shared: '*' } })
  copyClaudeAdapter(agent)
  copyCodexAdapter(pkg('@agentclientprotocol/codex-acp'))
  pkg('shared', {}, agent) // Source is nested; electron-builder may hoist it.
  const canvasName = '@napi-rs/canvas-darwin-x64'
  pkg('@napi-rs/canvas', { optionalDependencies: { [canvasName]: '1.0.0' } })
  const native = pkg(canvasName, { main: 'skia.darwin-x64.node' })
  writeFileSync(join(native, 'skia.darwin-x64.node'), 'native fixture')
  const packager = {
    info: { appDir: root, projectDir: join(__dirname, '..') }, config: { asarUnpack: ['resources/**'] },
    getResourcesDir: () => root
  }
  const context = { packager, electronPlatformName: 'darwin', arch: 1, appOutDir: root }
  beforePack(context)
  beforePack(context)
  assert.equal(packager.config.asarUnpack.length, 5)
  assert.ok(packager.config.asarUnpack.includes('**/node_modules/shared/**'))
  assert.ok(packager.config.asarUnpack.includes(`**/node_modules/${canvasName}/**`))
  const unpacked = join(root, 'app.asar.unpacked')
  const shippedClaude = pkg('@agentclientprotocol/claude-agent-acp', { dependencies: { shared: '*' } }, unpacked)
  copyCodexAdapter(pkg('@agentclientprotocol/codex-acp', {}, unpacked))
  assert.throws(() => afterPack(context), /Missing runtime dependency shared/)
  pkg('shared', {}, unpacked)
  // A shipped Claude adapter without the reviewed patch is refused.
  copyClaudeAdapter(shippedClaude)
  writeFileSync(join(shippedClaude, 'dist/acp-agent.js'), '// pristine adapter\n')
  assert.throws(() => afterPack(context), /Claude ACP patch \(context usage, AIR client off\) is missing or changed/)
  copyClaudeAdapter(shippedClaude)
  writeFileSync(join(shippedClaude, 'dist/native-subagents.js'), '// pristine adapter\n')
  assert.throws(() => afterPack(context), /Claude ACP patch \(subagent routing\) is missing or changed/)
  copyClaudeAdapter(shippedClaude)
  assert.throws(() => afterPack(context), /Missing packaged Canvas payload/)
  const shipped = pkg(canvasName, { main: 'skia.darwin-x64.node' }, unpacked)
  assert.throws(() => afterPack(context), /Missing native Canvas binary/)
  writeFileSync(join(shipped, 'skia.darwin-x64.node'), 'native fixture')
  // A mac package without the voice-input helper, or with one that cannot run.
  assert.throws(() => afterPack(context), /speech helper .*scripts\/build-speech-helper\.sh/)
  mkdirSync(join(root, 'speech'))
  writeFileSync(join(root, 'speech', 'cinna-speech'), 'helper fixture', { mode: 0o644 })
  assert.throws(() => afterPack(context), /Missing executable speech helper/)
  chmodSync(join(root, 'speech', 'cinna-speech'), 0o755)
  // The packed app itself: only what the app reads may sit at its top level.
  const appSource = join(root, '.app-source')
  mkdirSync(join(appSource, 'out'), { recursive: true })
  writeFileSync(join(appSource, 'out', 'index.js'), '')
  writeFileSync(join(appSource, 'package.json'), '{}')
  await require('@electron/asar').createPackage(appSource, join(root, 'app.asar'))
  // The extra-CA preload every run-as-node child requires.
  assert.throws(() => afterPack(context), /Missing unpacked extra-CA preload/)
  const extraCa = join(unpacked, 'resources', 'node-extra-ca')
  mkdirSync(extraCa, { recursive: true })
  for (const file of ['preload.cjs', 'extra-ca.cjs']) writeFileSync(join(extraCa, file), '')
  assert.doesNotThrow(() => afterPack(context))
  mkdirSync(join(appSource, 'drafts'))
  writeFileSync(join(appSource, 'drafts', 'notes.md'), '')
  await require('@electron/asar').createPackage(appSource, join(root, 'app.asar'))
  assert.throws(() => afterPack(context), /never reads: drafts\./)
})

function canvasFixture(t, options = {}) {
  const result = fixture(t)
  const name = '@napi-rs/canvas-darwin-x64'
  result.pkg('@napi-rs/canvas', { optionalDependencies: { [name]: '1.0.0' } })
  const target = canvasTargets(result.root, 'darwin', 'x64')[0]
  const source = join(result.root, 'tar-source')
  const payload = join(source, 'package')
  mkdirSync(payload, { recursive: true })
  writeFileSync(join(payload, 'package.json'), JSON.stringify({
    name, version: options.version ?? '1.0.0', main: target.binary
  }))
  writeFileSync(join(payload, target.binary), 'native fixture')
  const archive = join(result.root, 'canvas.tgz')
  require('tar').c({ file: archive, cwd: source, gzip: true, sync: true }, ['package'])
  const record = {
    version: '1.0.0', resolved: 'https://registry.npmjs.org/canvas-fixture.tgz',
    integrity: require('ssri').fromData(readFileSync(archive)).toString()
  }
  const lockPath = join(result.root, 'package-lock.json')
  writeFileSync(lockPath, JSON.stringify({ packages: { [`node_modules/${name}`]: record } }))
  return { ...result, target, archive, record, lockPath }
}

test('Canvas targets follow the build architecture and installed wrapper version', (t) => {
  const { root, pkg } = fixture(t)
  const names = ['darwin-x64', 'darwin-arm64', 'linux-x64-gnu', 'win32-x64-msvc']
  pkg('@napi-rs/canvas', { optionalDependencies: Object.fromEntries(names.map((name) => [`@napi-rs/canvas-${name}`, '1.0.0'])) })
  assert.equal(canvasTargets(root, 'darwin', 1)[0].name, '@napi-rs/canvas-darwin-x64')
  assert.equal(canvasTargets(root, 'darwin', 3)[0].name, '@napi-rs/canvas-darwin-arm64')
  assert.equal(canvasTargets(root, 'linux', 'x64')[0].name, '@napi-rs/canvas-linux-x64-gnu')
  assert.equal(canvasTargets(root, 'win32', 'x64')[0].name, '@napi-rs/canvas-win32-x64-msvc')
  assert.equal(canvasTargets(root, 'darwin', 'universal').length, 2)
  assert.throws(() => canvasTargets(root, 'win32', 'ia32'), /Unsupported packaged Canvas target/)
  pkg('@napi-rs/canvas', { optionalDependencies: { '@napi-rs/canvas-darwin-x64': '^1.0.0' } })
  assert.throws(() => canvasTargets(root, 'darwin', 'x64'), /does not pin/)
})

test('prepares only the locked target Canvas tarball, preserves the lock and skips valid installed payloads', (t) => {
  const { root, target, archive, record, lockPath } = canvasFixture(t)
  const originalLock = readFileSync(lockPath, 'utf8')
  let temporaryDirectory
  prepareCanvasPayload(root, target, (requested, scratch) => {
    assert.deepEqual(requested, record)
    temporaryDirectory = scratch
    return archive
  })
  assert.equal(existsSync(temporaryDirectory), false)
  assert.equal(readFileSync(lockPath, 'utf8'), originalLock)
  validateCanvasPayload(join(root, 'node_modules', target.name), target)
  prepareCanvasPayload(root, target, () => { throw new Error('must not fetch an installed payload') })
})

test('rejects tampered Canvas tarballs before installing anything', (t) => {
  const { root, target, archive } = canvasFixture(t)
  writeFileSync(archive, 'corrupted archive')
  assert.throws(() => prepareCanvasPayload(root, target, () => archive), /Integrity mismatch/)
  assert.equal(existsSync(join(root, 'node_modules', target.name)), false)
})

test('rejects a matching-integrity tarball with the wrong Canvas version', (t) => {
  const { root, target, archive } = canvasFixture(t, { version: '2.0.0' })
  assert.throws(() => prepareCanvasPayload(root, target, () => archive), /Expected @napi-rs\/canvas-darwin-x64@1.0.0/)
  assert.equal(existsSync(join(root, 'node_modules', target.name)), false)
})

test('refuses Canvas preparation without the exact lock version and integrity', (t) => {
  const { root, target, lockPath, record } = canvasFixture(t)
  for (const invalid of [{ ...record, version: '2.0.0' }, { ...record, integrity: undefined }]) {
    writeFileSync(lockPath, JSON.stringify({ packages: { [`node_modules/${target.name}`]: invalid } }))
    assert.throws(() => prepareCanvasPayload(root, target, () => { throw new Error('must not fetch') }), /Missing locked tarball\/integrity/)
  }
})

test('main check starts with an isolated home and no loader overrides or credentials', (t) => {
  const { root } = fixture(t)
  const env = checkEnvironment(root, {
    PATH: '/usr/bin', HOME: '/real/home', USERPROFILE: '/real/profile',
    NODE_PATH: '/developer/node_modules', NODE_OPTIONS: '--require /developer/preload.cjs',
    ELECTRON_RUN_AS_NODE: '1', ANTHROPIC_API_KEY: 'secret'
  })
  assert.equal(env.HOME, root)
  assert.equal(env.USERPROFILE, root)
  assert.equal(env.PATH, '/usr/bin')
  for (const key of ['NODE_PATH', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ANTHROPIC_API_KEY']) {
    assert.equal(env[key], undefined)
  }
})

test('main check cannot satisfy a missing CommonJS dependency through inherited NODE_PATH', (t) => {
  const { root, pkg } = fixture(t)
  const developer = join(root, 'developer')
  const fallback = pkg('cinna-only-in-developer-tree', { main: 'index.cjs' }, developer)
  writeFileSync(join(fallback, 'index.cjs'), 'module.exports = "DEVELOPER_FALLBACK"')
  const app = join(root, 'packaged-app')
  mkdirSync(app)
  const source = `require('node:module').createRequire(${JSON.stringify(join(app, 'entry.cjs'))})('cinna-only-in-developer-tree')`
  const host = { ...process.env, NODE_PATH: join(developer, 'node_modules') }
  const baseline = spawnSync(process.execPath, ['-e', source], { cwd: app, env: host })
  assert.equal(baseline.status, 0)
  const isolated = spawnSync(process.execPath, ['-e', source], { cwd: app, env: checkEnvironment(app, host), encoding: 'utf8' })
  assert.equal(isolated.status, 1)
  assert.match(isolated.stderr, /MODULE_NOT_FOUND/)
})

test('main check waits longer for an executable of another architecture, or as long as the override says', (t) => {
  const { root } = fixture(t)
  const header = (bytes) => { const path = join(root, `exe-${bytes.length}-${bytes[4]}-${bytes[18]}`); writeFileSync(path, Buffer.from(bytes)); return path }
  const machO = (cpu) => { const b = Buffer.alloc(32); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(cpu, 4); return [...b] }
  const elf = (machine) => { const b = Buffer.alloc(32); b.writeUInt32BE(0x7f454c46, 0); b.writeUInt16LE(machine, 18); return [...b] }
  assert.equal(executableArch(header(machO(0x01000007))), 'x64')
  assert.equal(executableArch(header(machO(0x0100000c))), 'arm64')
  assert.equal(executableArch(header(elf(0x3e))), 'x64')
  assert.equal(executableArch(header(elf(0xb7))), 'arm64')
  assert.equal(executableArch(join(root, 'missing')), null)
  assert.equal(checkDeadline('arm64', 'arm64', {}), 45_000)
  assert.equal(checkDeadline(null, 'arm64', {}), 45_000)
  assert.equal(checkDeadline('x64', 'arm64', {}), 120_000)
  assert.equal(checkDeadline('arm64', 'arm64', { CINNA_PACKAGED_MAIN_TIMEOUT_MS: '200000' }), 200_000)
  assert.equal(checkDeadline('x64', 'arm64', { CINNA_PACKAGED_MAIN_TIMEOUT_MS: 'soon' }), 120_000)
})

test('refuses an app.asar that holds anything but the app', (t) => {
  const { verifyAppContents } = require('./packaged-dependencies.cjs')
  const resources = mkdtempSync(join(tmpdir(), 'cinna-app-contents-'))
  t.after(() => rmSync(resources, { recursive: true, force: true }))
  const shipped = ['/out/main/index.js', '/node_modules/x/index.js', '/package.json', '/resources/icon.png', '/LICENSE']
  verifyAppContents(resources, () => shipped)
  assert.throws(
    () => verifyAppContents(resources, () => [...shipped, '/drafts/notes.md', '/.claude/settings.local.json', '/cinna.log']),
    /never reads: \.claude, cinna\.log, drafts\./
  )
  mkdirSync(join(resources, 'app.asar.unpacked', 'plans'), { recursive: true })
  assert.throws(() => verifyAppContents(resources, () => shipped), /never reads: plans\./)
})

test('afterPack requires the extra-CA preload as real files in app.asar.unpacked', (t) => {
  const { verifyExtraCaPreload } = require('./packaged-dependencies.cjs')
  const resources = mkdtempSync(join(tmpdir(), 'cinna-extra-ca-'))
  t.after(() => rmSync(resources, { recursive: true, force: true }))
  assert.throws(() => verifyExtraCaPreload(resources), /preload\.cjs, resources\/node-extra-ca\/extra-ca\.cjs/)
  const dir = join(resources, 'app.asar.unpacked', 'resources', 'node-extra-ca')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preload.cjs'), '')
  assert.throws(() => verifyExtraCaPreload(resources), /Missing unpacked extra-CA preload: resources\/node-extra-ca\/extra-ca\.cjs\./)
  writeFileSync(join(dir, 'extra-ca.cjs'), '')
  verifyExtraCaPreload(resources)
})

// A stand-in for plutil/codesign: what a release helper (or a lesser one) reports.
function helperTools({ flavor = 'release', group = 'G5E484HA2U.io.opencinna.desktop.vault-helper', verifies = true } = {}) {
  return (command, args) => {
    if (command === 'plutil') return { status: 0, output: `${flavor}\n` }
    if (args[0] === '-d') return { status: 0, output: `<plist><dict><key>keychain-access-groups</key><array><string>${group}</string></array></dict></plist>` }
    return verifies ? { status: 0, output: '' } : { status: 1, output: 'a sealed resource is missing or invalid\n' }
  }
}

test('afterPack refuses an arm64 mac package without a shippable vault helper; --dir only warns; x64 drops it', (t) => {
  const { root } = fixture(t)
  const appPath = join(root, 'Cinna Desktop.app')
  const helper = join(appPath, 'Contents', 'Library', 'Helpers', 'VaultHelper.app')
  // The repo's pin is unpublished: a present helper must still pass every release check.
  const arm64 = { appPath, arch: 3, dirOnly: false, projectDir: guestPinProject(t, { published: false }) }
  // A published pin needs the helper.
  const published = { ...arm64, projectDir: guestPinProject(t, { published: true }) }
  assert.throws(() => verifyVaultHelper(published, helperTools()), /VaultHelper\.app cannot ship: it is missing\. Build it with make vault-release/)
  const warnings = []
  t.mock.method(console, 'warn', (line) => warnings.push(line))
  assert.doesNotThrow(() => verifyVaultHelper({ ...published, dirOnly: true }, helperTools()))
  assert.match(warnings[0], /^WARNING Agent Vault helper .* it is missing/)

  mkdirSync(join(helper, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(helper, 'Contents', 'MacOS', 'VaultHelper'), '')
  assert.throws(() => verifyVaultHelper(arm64, helperTools()), /no embedded provisioning profile; guest Image is missing; guest initrd\.img is missing/)
  writeFileSync(join(helper, 'Contents', 'embedded.provisionprofile'), '')
  mkdirSync(join(helper, 'Contents', 'Resources', 'guest'), { recursive: true })
  for (const file of ['Image', 'initrd.img']) writeFileSync(join(helper, 'Contents', 'Resources', 'guest', file), '')
  assert.doesNotThrow(() => verifyVaultHelper(arm64, helperTools()))
  // A test or dev helper must never ship: approvals without a prompt, or no parent check.
  assert.throws(() => verifyVaultHelper(arm64, helperTools({ flavor: 'test' })), /flavor is test, not release/)
  assert.throws(() => verifyVaultHelper(arm64, helperTools({ flavor: 'dev' })), /flavor is dev, not release/)
  // electron-builder re-signed it (signIgnore lost): the keychain group is gone.
  assert.throws(() => verifyVaultHelper(arm64, helperTools({ group: 'G5E484HA2U.other' })), /does not carry keychain-access-groups/)
  assert.throws(() => verifyVaultHelper(arm64, helperTools({ verifies: false })), /signature does not verify \(a sealed resource/)
  // A test-gate binary is refused by its bytes, even with a release plist and a good signature.
  writeFileSync(join(helper, 'Contents', 'MacOS', 'VaultHelper'), 'xx CINNA-VAULT-TEST-GATE-BUILD:7c1e9a4f-do-not-ship xx')
  assert.throws(() => verifyVaultHelper(arm64, helperTools()), /its binary is a test-gate build/)
  writeFileSync(join(helper, 'Contents', 'MacOS', 'VaultHelper'), '')

  verifyVaultHelper({ appPath, arch: 1, dirOnly: false }, helperTools())
  assert.equal(existsSync(helper), false)
})

// A runtimePins.ts holding only the VAULT_GUEST block, as vault:pin-guest prints it.
function guestPinProject(t, { published, version = '1.0.0-7', rootHash = 'a'.repeat(64) }) {
  const project = mkdtempSync(join(tmpdir(), 'cinna-guest-pin-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  mkdirSync(join(project, 'src', 'shared'), { recursive: true })
  const asset = (name) => `{ file: '${name}', url: 'https://example.invalid/${name}', sha256: '${'b'.repeat(64)}', size: 1 }`
  writeFileSync(join(project, 'src', 'shared', 'runtimePins.ts'), `export {}\nconst VAULT_GUEST: VaultGuestPin = {\n  published: ${published},\n  version: '${version}',\n  rootHash: '${rootHash}',\n  hashOffset: 4096,\n  kernel: ${asset('k')},\n  initrd: ${asset('i')},\n  rootfs: ${asset('r')}\n}\n`)
  return project
}

test('afterPack refuses a vault helper built for another guest than the published pin; an unpublished pin asks nothing of it', (t) => {
  const { root } = fixture(t)
  const appPath = join(root, 'Cinna Desktop.app')
  const helper = join(appPath, 'Contents', 'Library', 'Helpers', 'VaultHelper.app')
  const guest = join(helper, 'Contents', 'Resources', 'guest')
  mkdirSync(join(helper, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(guest, { recursive: true })
  writeFileSync(join(helper, 'Contents', 'MacOS', 'VaultHelper'), '')
  writeFileSync(join(helper, 'Contents', 'embedded.provisionprofile'), '')
  for (const file of ['Image', 'initrd.img']) writeFileSync(join(guest, file), '')
  const published = guestPinProject(t, { published: true })
  const arm64 = (projectDir) => ({ appPath, arch: 'arm64', dirOnly: false, projectDir })

  // Unpublished: a helper that is there passes the release checks without a lock…
  const unpublished = guestPinProject(t, { published: false })
  assert.doesNotThrow(() => verifyVaultHelper(arm64(unpublished), helperTools()))
  // …but a test or dev one never ships, pin or no pin.
  assert.throws(() => verifyVaultHelper(arm64(unpublished), helperTools({ flavor: 'test' })), /flavor is test, not release/)
  // Published: the bundled lock must be there and name the pinned image.
  assert.throws(() => verifyVaultHelper(arm64(published), helperTools()), /carries no guest\/guest\.lock\.json/)
  writeFileSync(join(guest, 'guest.lock.json'), JSON.stringify({ version: '1.0.0-6', rootHash: 'c'.repeat(64), hashOffset: 4096 }))
  assert.throws(() => verifyVaultHelper(arm64(published), helperTools()), /its guest is 1\.0\.0-6, not the pinned 1\.0\.0-7; its guest root hash is not the pinned one/)
  writeFileSync(join(guest, 'guest.lock.json'), JSON.stringify({ version: '1.0.0-7', rootHash: 'c'.repeat(64), hashOffset: 4096 }))
  assert.throws(() => verifyVaultHelper(arm64(published), helperTools()), /root hash is not the pinned one/)
  writeFileSync(join(guest, 'guest.lock.json'), JSON.stringify({ version: '1.0.0-7', rootHash: 'A'.repeat(64), hashOffset: 8192 }))
  assert.throws(() => verifyVaultHelper(arm64(published), helperTools()), /its guest hash offset 8192 is not the pinned 4096/)
  writeFileSync(join(guest, 'guest.lock.json'), JSON.stringify({ version: '1.0.0-7', rootHash: 'A'.repeat(64), hashOffset: 4096 }))
  assert.doesNotThrow(() => verifyVaultHelper(arm64(published), helperTools()))
  // --dir only warns, as for every other helper problem.
  writeFileSync(join(guest, 'guest.lock.json'), JSON.stringify({ version: '1.0.0-6', rootHash: 'a'.repeat(64), hashOffset: 4096 }))
  t.mock.method(console, 'warn', () => {})
  assert.doesNotThrow(() => verifyVaultHelper({ ...arm64(published), dirOnly: true }, helperTools()))
  // Unpublished and no helper at all: the package ships none (Agent Vault unavailable).
  rmSync(helper, { recursive: true, force: true })
  const logs = []
  t.mock.method(console, 'log', (line) => logs.push(line))
  assert.doesNotThrow(() => verifyVaultHelper(arm64(unpublished), helperTools()))
  assert.match(logs.join('\n'), /No vault helper: RUNTIME_PINS\.vaultGuest is unpublished/)
  // A published pin still requires it.
  assert.throws(() => verifyVaultHelper(arm64(published), helperTools()), /it is missing/)
  // The repo's own pin parses (and is what the default projectDir reads).
  const { readVaultGuestPin } = require('./vault/guest-pin.cjs')
  assert.equal(typeof readVaultGuestPin().published, 'boolean')
})

test('afterPack requires the pinned vault adapter tar inside app.asar', async (t) => {
  const { verifyVaultAdapterTar, pinnedAdapterTarSha256 } = require('./packaged-dependencies.cjs')
  const asar = require('@electron/asar')
  const { createHash } = require('node:crypto')
  const resources = mkdtempSync(join(tmpdir(), 'cinna-adapter-tar-'))
  t.after(() => rmSync(resources, { recursive: true, force: true }))
  const appSource = join(resources, '.app-source')
  mkdirSync(join(appSource, 'out', 'main'), { recursive: true })
  writeFileSync(join(appSource, 'out', 'main', 'index.js'), '')
  await asar.createPackage(appSource, join(resources, 'app.asar'))
  const pin = createHash('sha256').update('the pinned tar').digest('hex')
  assert.throws(() => verifyVaultAdapterTar(resources, pin), /app\.asar holds no out\/vault\/claude-adapter\.tar/)
  mkdirSync(join(appSource, 'out', 'vault'))
  writeFileSync(join(appSource, 'out', 'vault', 'claude-adapter.tar'), 'another tar')
  await asar.createPackage(appSource, join(resources, 'app.asar'))
  assert.throws(() => verifyVaultAdapterTar(resources, pin), /not the pinned/)
  writeFileSync(join(appSource, 'out', 'vault', 'claude-adapter.tar'), 'the pinned tar')
  await asar.createPackage(appSource, join(resources, 'app.asar'))
  verifyVaultAdapterTar(resources, pin)
  // The pin is read from the TypeScript source the app compiles in.
  const source = readFileSync(join(__dirname, '..', 'src', 'shared', 'runtimePins.ts'), 'utf8')
  const actual = pinnedAdapterTarSha256(join(__dirname, '..'))
  assert.match(actual, /^[0-9a-f]{64}$/)
  assert.ok(source.includes(`vaultAdapterTarSha256: '${actual}'`))
})

test('afterPack requires the pinned Codex adapter tar beside the Claude one', async (t) => {
  const { verifyVaultAdapterTars, pinnedAdapterTarSha256 } = require('./packaged-dependencies.cjs')
  const asar = require('@electron/asar')
  const { createHash } = require('node:crypto')
  const project = mkdtempSync(join(tmpdir(), 'cinna-adapter-pins-'))
  t.after(() => rmSync(project, { recursive: true, force: true }))
  const sha = (text) => createHash('sha256').update(text).digest('hex')
  mkdirSync(join(project, 'src', 'shared'), { recursive: true })
  writeFileSync(join(project, 'src', 'shared', 'runtimePins.ts'), `export const RUNTIME_PINS = {\n  claude: {\n    vaultAdapterTarSha256: '${sha('claude tar')}',\n  },\n  codex: {\n    vaultAdapterTarSha256: '${sha('codex tar')}',\n  }\n}\n`)
  assert.equal(pinnedAdapterTarSha256(project, 'claude'), sha('claude tar'))
  assert.equal(pinnedAdapterTarSha256(project, 'codex'), sha('codex tar'))
  const resources = join(project, 'resources')
  const appSource = join(project, '.app-source')
  mkdirSync(join(appSource, 'out', 'vault'), { recursive: true })
  mkdirSync(resources)
  writeFileSync(join(appSource, 'out', 'vault', 'claude-adapter.tar'), 'claude tar')
  await asar.createPackage(appSource, join(resources, 'app.asar'))
  assert.throws(() => verifyVaultAdapterTars(resources, project), /app\.asar holds no out\/vault\/codex-adapter\.tar/)
  writeFileSync(join(appSource, 'out', 'vault', 'codex-adapter.tar'), 'another codex tar')
  await asar.createPackage(appSource, join(resources, 'app.asar'))
  assert.throws(() => verifyVaultAdapterTars(resources, project), /RUNTIME_PINS\.codex\.vaultAdapterTarSha256/)
  writeFileSync(join(appSource, 'out', 'vault', 'codex-adapter.tar'), 'codex tar')
  await asar.createPackage(appSource, join(resources, 'app.asar'))
  verifyVaultAdapterTars(resources, project)
  // The real source names both pins.
  assert.match(pinnedAdapterTarSha256(join(__dirname, '..'), 'codex'), /^[0-9a-f]{64}$/)
  assert.notEqual(pinnedAdapterTarSha256(join(__dirname, '..'), 'codex'), pinnedAdapterTarSha256(join(__dirname, '..'), 'claude'))
})
