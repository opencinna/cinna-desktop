const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const { patchCodexAcp, verifyCodexAcpPatch } = require('./patch-codex-acp.cjs')
const policy = require('../src/main/agents/drivers/acp/codexAdapterPatch.json')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cinna-adapter-patch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'node_modules/@agentclientprotocol/codex-acp')
  mkdirSync(join(directory, 'dist'), { recursive: true })
  const manifest = join(directory, 'package.json')
  writeFileSync(manifest, JSON.stringify({ version: policy.version }))
  const path = join(directory, 'dist/index.js')
  const installed = readFileSync(join(__dirname, '../node_modules/@agentclientprotocol/codex-acp/dist/index.js'), 'utf8')
  const original = installed.replaceAll('\n      ...(typeof request._meta?.cinna?.systemPrompt === "string" ? { developerInstructions: request._meta.cinna.systemPrompt } : {}),', '').replace(
    '"mcp_servers": { ...configWithWorkspaceRoots.mcp_servers, ...Object.fromEntries(serversToConfigure.map((mcp) => [mcp.name, { enabled: true, ...this.createMcpSeverConfig(mcp.server) }])) }',
    '"mcp_servers": Object.fromEntries(serversToConfigure.map((mcp) => [mcp.name, this.createMcpSeverConfig(mcp.server)]))'
  )
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

test('rejects unexpected source and version without modifying the package', (t) => {
  const f = fixture(t)
  const changed = `${f.original}\n// different distribution\n`
  writeFileSync(f.path, changed)
  assert.throws(() => patchCodexAcp(f.root), /differs/)
  assert.equal(readFileSync(f.path, 'utf8'), changed)
  writeFileSync(f.manifest, JSON.stringify({ version: '1.12.0' }))
  assert.throws(() => patchCodexAcp(f.root), /version/)
  assert.throws(() => verifyCodexAcpPatch(f.root), /version/)
})
