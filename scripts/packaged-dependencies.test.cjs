const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { runtimePackages, beforePack, afterPack } = require('./packaged-dependencies.cjs')
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
  const packager = {
    info: { appDir: root }, config: { asarUnpack: ['resources/**'] },
    getResourcesDir: () => root
  }
  beforePack({ packager })
  beforePack({ packager })
  assert.equal(packager.config.asarUnpack.length, 4)
  assert.ok(packager.config.asarUnpack.includes('**/node_modules/shared/**'))
  const unpacked = join(root, 'app.asar.unpacked')
  pkg('@agentclientprotocol/claude-agent-acp', { dependencies: { shared: '*' } }, unpacked)
  pkg('@agentclientprotocol/codex-acp', {}, unpacked)
  assert.throws(() => afterPack({ packager, appOutDir: root }), /Missing runtime dependency shared/)
  pkg('shared', {}, unpacked)
  assert.doesNotThrow(() => afterPack({ packager, appOutDir: root }))
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
