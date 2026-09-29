const { readFileSync, writeFileSync, renameSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createHash } = require('node:crypto')
const policy = require('../src/main/agents/drivers/acp/codexAdapterPatch.json')

// The pinned adapter discarded explicit per-server restrictions whenever an
// ACP client injected a server. Preserve those entries, then let the explicit
// session descriptor win. Session-owned developer instructions let fresh
// utility sessions share a process without inheriting a chat's prompt.
// The prompt response's `_meta.quota` also carries the session's running
// token total (`total_token_count`, which the adapter keeps but never sent),
// so a turn's tokens are the growth of that total rather than its last
// request's. The user's Codex executable is never modified.
const original = '"mcp_servers": Object.fromEntries(serversToConfigure.map((mcp) => [mcp.name, this.createMcpSeverConfig(mcp.server)]))'
const replacement = '"mcp_servers": { ...configWithWorkspaceRoots.mcp_servers, ...Object.fromEntries(serversToConfigure.map((mcp) => [mcp.name, { enabled: true, ...this.createMcpSeverConfig(mcp.server) }])) }'
const quotaAnchor = '        token_count: sessionState.lastTokenUsage,\n        model_usage: modelUsage\n'
const quotaReplacement = '        token_count: sessionState.lastTokenUsage,\n        total_token_count: sessionState.totalTokenUsage,\n        model_usage: modelUsage\n'
const instructions = '\n      ...(typeof request._meta?.cinna?.systemPrompt === "string" ? { developerInstructions: request._meta.cinna.systemPrompt } : {}),'
const digest = (content) => createHash('sha256').update(content).digest('hex')

/**
 * Earlier reviewed patches of the same pinned adapter, by the digest of the
 * file they produced, each with the exact reversal of its replacements. An
 * existing checkout carrying one is restored to the original (verified by
 * digest) and patched again; anything else is still refused.
 */
const earlierPatches = {
  // The session-configuration and session-instruction patch, before the
  // quota's running token total was added.
  bf3f889fbad28a1304b0e358a3d4cb099cf95ffe317e80b529ceecf7bd76fc95: (content) => {
    if (content.split(instructions).length !== 4 || content.split(replacement).length !== 2) return null
    return content.replaceAll(instructions, '').replace(replacement, original)
  }
}

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
  let content = readFileSync(path, 'utf8')
  if (digest(content) === policy.patchedSha256) return
  const unpatch = earlierPatches[digest(content)]
  if (unpatch) {
    const restored = unpatch(content)
    if (restored === null || digest(restored) !== policy.originalSha256) {
      throw new Error('Codex ACP earlier patch could not be reversed to the reviewed pinned adapter; refusing to patch')
    }
    content = restored
  }
  if (digest(content) !== policy.originalSha256 || content.split(original).length !== 2) {
    throw new Error('Codex ACP source differs from the reviewed pinned adapter; refusing to patch')
  }
  let patched = content.replace(original, replacement)
  for (const [method, count] of [['threadStart', 1], ['threadResume', 2]]) {
    const anchor = `const response = await this.codexClient.${method}({`
    if (patched.split(anchor).length !== count + 1) throw new Error('Codex ACP session-instruction patch target changed')
    patched = patched.replaceAll(anchor, anchor + instructions)
  }
  if (patched.split(quotaAnchor).length !== 2) throw new Error('Codex ACP quota patch target changed')
  patched = patched.replace(quotaAnchor, quotaReplacement)
  if (digest(patched) !== policy.patchedSha256) throw new Error('Codex ACP patch output does not match reviewed content')
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, patched, { mode: 0o644 })
  renameSync(temporary, path)
  verifyCodexAcpPatch(root)
}

module.exports = { patchCodexAcp, verifyCodexAcpPatch }
if (require.main === module) patchCodexAcp(resolve(__dirname, '..'))
