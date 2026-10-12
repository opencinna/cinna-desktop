const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const {
  patchCodexAcp, verifyCodexAcpPatch, original: mcpOriginal, replacement: mcpReplacement, instructions, instructionAnchors, airClientAnchor, airClientOff, commandEndAnchor, commandEndWhole
} = require('./patch-codex-acp.cjs')
const policy = require('../src/main/agents/drivers/acp/codexAdapterPatch.json')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cinna-adapter-patch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'node_modules/@agentclientprotocol/codex-acp')
  mkdirSync(join(directory, 'dist'), { recursive: true })
  const manifest = join(directory, 'package.json')
  writeFileSync(manifest, JSON.stringify({ version: policy.version }))
  const path = join(directory, 'dist/index.js')
  // The installed copy is patched by postinstall; take the patch back out.
  const installed = readFileSync(join(__dirname, '../node_modules/@agentclientprotocol/codex-acp/dist/index.js'), 'utf8')
  const original = installed.replaceAll(instructions, '').replace(mcpReplacement, () => mcpOriginal).replace(airClientOff, () => airClientAnchor)
    .replace(commandEndWhole, () => commandEndAnchor)
  assert.equal(createHash('sha256').update(original).digest('hex'), policy.originalSha256)
  writeFileSync(path, original)
  return { root, path, manifest, original }
}

test('patches the exact pinned adapter once and packaging rejects the pristine adapter', (t) => {
  const f = fixture(t)
  assert.throws(() => verifyCodexAcpPatch(f.root), /missing or changed/)
  patchCodexAcp(f.root)
  const applied = readFileSync(f.path)
  assert.equal(createHash('sha256').update(applied).digest('hex'), policy.patchedSha256)
  patchCodexAcp(f.root)
  assert.deepEqual(readFileSync(f.path), applied)
  assert.doesNotThrow(() => verifyCodexAcpPatch(f.root))
})

test('the session instructions reach thread start and both resume paths', (t) => {
  const f = fixture(t)
  patchCodexAcp(f.root)
  const applied = readFileSync(f.path, 'utf8')
  assert.equal(applied.split(instructions).length, 4)
  for (const [anchor, count] of instructionAnchors) assert.equal(applied.split(anchor + instructions).length, count + 1)
  // session/load and session/resume both resume through the one helper, which hands its params to thread/resume as they are.
  assert.match(applied, /async resumeThread\(params\) \{\n[^\n]*\n\s+const response = await this\.codexClient\.threadResume\(params\);/)
})

/*
 * Every AIR-UI decision reads `isAirClient`, directly or through
 * `ClientCapabilities.airClient`; the negotiated AIR capabilities are read by
 * `clientSupportsAirCapability`. If a release decides "AIR UI" anywhere else,
 * this fails and the new branch needs reading.
 */
test('isAirClient answers false and is the only place the AIR UI is decided', (t) => {
  const f = fixture(t)
  patchCodexAcp(f.root)
  const applied = readFileSync(f.path, 'utf8')
  assert.equal(applied.split(airClientOff).length, 2)
  // What acpActivity.ts `airClientMeta(['asyncTasks'])` declares.
  const declared = { elicitation: { form: {} }, _meta: { jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } } }
  assert.equal(new Function(`${airClientOff}; return isAirClient`)()(declared), false)
  // The pristine function says true for the same declaration.
  const asRecord = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {})
  assert.equal(new Function('asRecord', 'JETBRAINS_META_KEY', 'AIR_META_KEY', `${airClientAnchor}; return isAirClient`)(asRecord, 'jetbrains', 'air')(declared), true)
  // Three readers: the capability object and the two question paths.
  assert.equal(applied.match(/isAirClient\(/g).length, 4)
  assert.equal(applied.split('airClient: isAirClient(capabilities),').length, 2)
  assert.equal(applied.split('const airClient = isAirClient(this.clientCapabilities);').length, 3)
  // Nothing else reads the client's `_meta` for itself: clientSupportsAirCapability and the two terminal flags.
  assert.equal(applied.match(/capabilities\?\._meta/g).length, 3)
  // Async tasks stay negotiated from the raw capabilities.
  assert.match(applied, /new CodexBackgroundTerminalTasks\(\n\s+clientSupportsAirCapability\(this\.clientCapabilities, AIR_ASYNC_TASKS_KEY\),/)
})

test('the completing update of every command carries its whole output', (t) => {
  const f = fixture(t)
  patchCodexAcp(f.root)
  const applied = readFileSync(f.path, 'utf8')
  assert.equal(applied.split(commandEndWhole).length, 2)
  // Read once, by the renderer of a client that is not AIR, which assigns it as `rawOutput`.
  assert.equal(applied.match(/commandEndRawOutput\(/g).length, 2)
  assert.match(applied, /const rawOutput = this\.commandEndRawOutput\(end\);\n\s+if \(rawOutput !== void 0\) rendered\["rawOutput"\] = rawOutput;/)
  const method = new Function(`return { ${commandEndWhole} }`)()
  for (const terminal of [true, false]) {
    assert.deepEqual(method.commandEndRawOutput({ terminal, exitCode: 0, output: 'head\ntail\n', streamed: true }), { exit_code: 0, formatted_output: 'head\ntail\n' })
  }
})

test('refuses an adapter carrying only part of a reviewed patch', (t) => {
  const f = fixture(t)
  // The pristine source with only the MCP-server patch applied: neither the
  // original nor any reviewed result, so it is refused and left as it is.
  const partial = f.original.replace(mcpOriginal, () => mcpReplacement)
  writeFileSync(f.path, partial)
  assert.throws(() => patchCodexAcp(f.root), /differs/)
  assert.equal(readFileSync(f.path, 'utf8'), partial)
})

test('rejects unexpected source and version without modifying the package', (t) => {
  const f = fixture(t)
  const changed = `${f.original}\n// different distribution\n`
  writeFileSync(f.path, changed)
  assert.throws(() => patchCodexAcp(f.root), /differs/)
  assert.equal(readFileSync(f.path, 'utf8'), changed)
  writeFileSync(f.manifest, JSON.stringify({ version: '2.2.3' }))
  assert.throws(() => patchCodexAcp(f.root), /version/)
  assert.throws(() => verifyCodexAcpPatch(f.root), /version/)
})
