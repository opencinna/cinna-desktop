const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { runtimePackages, canvasTargets, prepareCanvasPayload, validateCanvasPayload, beforePack, afterPack } = require('./packaged-dependencies.cjs')
const { checkEnvironment } = require('./check-packaged-main.cjs')

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

test('build hooks preserve resource patterns and reject a broken shipped tree', (t) => {
  const { root, pkg } = fixture(t)
  const agent = pkg('@agentclientprotocol/claude-agent-acp', { dependencies: { shared: '*' } })
  pkg('@agentclientprotocol/codex-acp')
  pkg('shared', {}, agent) // Source is nested; electron-builder may hoist it.
  const canvasName = '@napi-rs/canvas-darwin-x64'
  pkg('@napi-rs/canvas', { optionalDependencies: { [canvasName]: '1.0.0' } })
  const native = pkg(canvasName, { main: 'skia.darwin-x64.node' })
  writeFileSync(join(native, 'skia.darwin-x64.node'), 'native fixture')
  const packager = {
    info: { appDir: root }, config: { asarUnpack: ['resources/**'] },
    getResourcesDir: () => root
  }
  const context = { packager, electronPlatformName: 'darwin', arch: 1, appOutDir: root }
  beforePack(context)
  beforePack(context)
  assert.equal(packager.config.asarUnpack.length, 5)
  assert.ok(packager.config.asarUnpack.includes('**/node_modules/shared/**'))
  assert.ok(packager.config.asarUnpack.includes(`**/node_modules/${canvasName}/**`))
  const unpacked = join(root, 'app.asar.unpacked')
  pkg('@agentclientprotocol/claude-agent-acp', { dependencies: { shared: '*' } }, unpacked)
  pkg('@agentclientprotocol/codex-acp', {}, unpacked)
  assert.throws(() => afterPack(context), /Missing runtime dependency shared/)
  pkg('shared', {}, unpacked)
  assert.throws(() => afterPack(context), /Missing packaged Canvas payload/)
  const shipped = pkg(canvasName, { main: 'skia.darwin-x64.node' }, unpacked)
  assert.throws(() => afterPack(context), /Missing native Canvas binary/)
  writeFileSync(join(shipped, 'skia.darwin-x64.node'), 'native fixture')
  assert.doesNotThrow(() => afterPack(context))
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
