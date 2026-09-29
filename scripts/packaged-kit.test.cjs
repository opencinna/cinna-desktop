const assert = require('node:assert/strict')
const { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { completePackagedKit, restoreKitFiles, verifyKit } = require('./packaged-kit.cjs')

const PROJECT = join(__dirname, '..')
const BUNDLE = join(PROJECT, 'resources', 'cinna-agent-kit')
const LOCK = JSON.parse(readFileSync(join(PROJECT, 'scripts', 'kit-sync', 'kit.lock.json'), 'utf8'))

/** The bundle as electron-builder ships it: every `.gitkeep` filtered out. */
function packagedCopy(t) {
  const resources = mkdtempSync(join(tmpdir(), 'cinna-packaged-kit-'))
  t.after(() => rmSync(resources, { recursive: true, force: true }))
  cpSync(BUNDLE, join(resources, 'cinna-agent-kit'), {
    recursive: true,
    filter: (path) => !path.endsWith('.gitkeep')
  })
  return resources
}

test('the bundle carries .gitkeep files electron-builder would drop', () => {
  // Without them this suite proves nothing about the packaged gap.
  assert.ok(existsSync(join(BUNDLE, 'templates', 'agent', 'files', '.gitkeep')))
})

test('restores what the packager dropped and verifies the tree against kit.lock.json', (t) => {
  const resources = packagedCopy(t)
  const shipped = join(resources, 'cinna-agent-kit')
  assert.throws(() => verifyKit(shipped, LOCK), /is not the bundled one/)

  completePackagedKit(PROJECT, resources)

  assert.ok(existsSync(join(shipped, 'templates', 'agent', 'files', '.gitkeep')))
  assert.ok(existsSync(join(shipped, 'templates', 'agent', 'app-data', 'storage', '.gitkeep')))
  assert.ok(existsSync(join(shipped, 'templates', 'agent', 'app-data', 'uploads', '.gitkeep')))
  assert.equal(verifyKit(shipped, LOCK), LOCK.file_count)
  assert.deepEqual(restoreKitFiles(BUNDLE, shipped), [], 'a second pass has nothing to restore')
})

test('keeps restored files at the bundle mode, kit.py executable included', (t) => {
  const resources = packagedCopy(t)
  const shipped = join(resources, 'cinna-agent-kit')
  rmSync(join(shipped, 'tools', 'kit.py'))

  const restored = restoreKitFiles(BUNDLE, shipped)

  assert.ok(restored.includes('tools/kit.py'))
  assert.equal(statSync(join(shipped, 'tools', 'kit.py')).mode & 0o777, statSync(join(BUNDLE, 'tools', 'kit.py')).mode & 0o777)
})

test('fails the build when a shipped file differs from the bundle', (t) => {
  // Restoring only adds what is missing; a changed file must still stop it.
  const resources = packagedCopy(t)
  writeFileSync(join(resources, 'cinna-agent-kit', 'README.md'), 'not the kit')

  assert.throws(() => completePackagedKit(PROJECT, resources), /is not the bundled one/)
})
