const { readFileSync, writeFileSync, renameSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createHash } = require('node:crypto')
const policy = require('../src/main/agents/drivers/acp/codexAdapterPatch.json')

// The pinned adapter discarded explicit per-server restrictions whenever an
// ACP client injected a server. Preserve those entries, then let the explicit
// session descriptor win. Session-owned developer instructions let fresh
// utility sessions share a process without inheriting a chat's prompt.
// The user's Codex executable is never modified.
const original = '"mcp_servers": Object.fromEntries(serversToConfigure.map((mcp) => [mcp.name, this.createMcpSeverConfig(mcp.server)]))'
const replacement = '"mcp_servers": { ...configWithWorkspaceRoots.mcp_servers, ...Object.fromEntries(serversToConfigure.map((mcp) => [mcp.name, { enabled: true, ...this.createMcpSeverConfig(mcp.server) }])) }'
const digest = (content) => createHash('sha256').update(content).digest('hex')

function adapter(root) {
  const directory = join(root, 'node_modules/@agentclientprotocol/codex-acp')
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (manifest.version !== policy.version) throw new Error('Codex ACP patch needs review for this adapter version')
  return join(directory, 'dist/index.js')
}

function verifyCodexAcpPatch(root) {
  if (digest(readFileSync(adapter(root))) !== policy.patchedSha256) {
    throw new Error('Codex ACP session-configuration patch is missing or changed')
  }
}

function patchCodexAcp(root) {
  const path = adapter(root)
  const content = readFileSync(path, 'utf8')
  if (digest(content) === policy.patchedSha256) return
  if (digest(content) !== policy.originalSha256 || content.split(original).length !== 2) {
    throw new Error('Codex ACP source differs from the reviewed pinned adapter; refusing to patch')
  }
  let patched = content.replace(original, replacement)
  for (const [method, count] of [['threadStart', 1], ['threadResume', 2]]) {
    const anchor = `const response = await this.codexClient.${method}({`
    if (patched.split(anchor).length !== count + 1) throw new Error('Codex ACP session-instruction patch target changed')
    patched = patched.replaceAll(anchor, anchor + '\n      ...(typeof request._meta?.cinna?.systemPrompt === "string" ? { developerInstructions: request._meta.cinna.systemPrompt } : {}),')
  }
  if (digest(patched) !== policy.patchedSha256) throw new Error('Codex ACP patch output does not match reviewed content')
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, patched, { mode: 0o644 })
  renameSync(temporary, path)
  verifyCodexAcpPatch(root)
}

module.exports = { patchCodexAcp, verifyCodexAcpPatch }
if (require.main === module) patchCodexAcp(resolve(__dirname, '..'))
