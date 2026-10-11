const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const {
  patchClaudeAgentAcp, verifyClaudeAgentAcpPatch, CONTEXT_USAGE_METHOD, contextUsageHandlerSource, contextUsageRoute, contextUsageRouteAnchor,
  airClientAnchor, airClientOff
} = require('./patch-claude-agent-acp.cjs')
const policy = require('../src/main/agents/drivers/acp/claudeAdapterPatch.json')

const sha = (content) => createHash('sha256').update(content).digest('hex')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cinna-claude-adapter-patch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'node_modules/@agentclientprotocol/claude-agent-acp')
  mkdirSync(join(directory, 'dist'), { recursive: true })
  const manifest = join(directory, 'package.json')
  writeFileSync(manifest, JSON.stringify({ version: policy.version }))
  const path = join(directory, 'dist/acp-agent.js')
  // The installed copy is patched by postinstall; take the patch back out.
  const installed = readFileSync(join(__dirname, '../node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js'), 'utf8')
  const original = installed.replace(contextUsageRoute, () => contextUsageRouteAnchor).replace(contextUsageHandlerSource, '')
    .replace(airClientOff, () => airClientAnchor)
  assert.equal(sha(original), policy.originalSha256)
  writeFileSync(path, original)
  return { root, path, manifest, original }
}

test('patches the exact pinned adapter once and packaging rejects the pristine adapter', (t) => {
  const f = fixture(t)
  assert.throws(() => verifyClaudeAgentAcpPatch(f.root), /missing or changed/)
  patchClaudeAgentAcp(f.root)
  const applied = readFileSync(f.path)
  assert.equal(sha(applied), policy.patchedSha256)
  patchClaudeAgentAcp(f.root)
  assert.deepEqual(readFileSync(f.path), applied)
  assert.doesNotThrow(() => verifyClaudeAgentAcpPatch(f.root))
  const text = applied.toString('utf8')
  // Registered once, on the adapter's own request builder, beside its goal method.
  assert.equal(text.split(`.onRequest("${CONTEXT_USAGE_METHOD}"`).length, 2)
  assert.match(text, /\.onRequest\(GOAL_CONTROL_METHOD, [^\n]+\n\s+\.onRequest\("_cinna\/contextUsage"/)
  // The goal route ended the chain; ours ends it now, so the chain stays one statement.
  assert.match(text, /agent\.goal\(ctx\.params\)\)\n\s+\.onRequest\("_cinna\/contextUsage", [^\n]+\)\);\n\s+return sessionIndex\.onSessionIndexRequests\(app, \(\) => agent\);\n/)
  assert.equal(text.split('async function cinnaContextUsage(agent, params)').length, 2)
  // `air.client` is forced off once, directly after `initialize` decides it, and nothing else assigns the capabilities.
  assert.equal(text.split('this.toolCallCapabilities.air = { ...this.toolCallCapabilities.air, client: false };').length, 2)
  assert.match(text, /this\.toolCallCapabilities = ToolCallClientCapabilities\.from\(request\.clientCapabilities, \{\n\s+v2: this\.v2,\n\s+\}\);\n\s+\/\/ Cinna Desktop[^\n]*\n\s+this\.toolCallCapabilities\.air = \{ \.\.\.this\.toolCallCapabilities\.air, client: false \};\n\s+this\.sessionIndex\.negotiate\(/)
  assert.equal(text.match(/this\.toolCallCapabilities(\.air)? = /g)?.length, 2)
})

test('rejects unexpected source and version without modifying the package', (t) => {
  const f = fixture(t)
  const changed = `${f.original}\n// different distribution\n`
  writeFileSync(f.path, changed)
  assert.throws(() => patchClaudeAgentAcp(f.root), /differs/)
  assert.equal(readFileSync(f.path, 'utf8'), changed)
  writeFileSync(f.manifest, JSON.stringify({ version: '0.77.0' }))
  assert.throws(() => patchClaudeAgentAcp(f.root), /version/)
  assert.throws(() => verifyClaudeAgentAcpPatch(f.root), /version/)
})

/* The inserted `air.client` statement, run on the adapter's own capability and renderer classes. */
test('the inserted statement turns the AIR UI shapes off and keeps the rest of the negotiation', async () => {
  const dist = join(__dirname, '../node_modules/@agentclientprotocol/claude-agent-acp/dist')
  const { ClientCapabilities } = await import(pathToFileURL(join(dist, 'tool-calls/client-capabilities.js')).href)
  const { AcpToolCallRenderer } = await import(pathToFileURL(join(dist, 'tool-calls/renderer.js')).href)
  const { clientSupportsAirCapability } = await import(pathToFileURL(join(dist, 'air-extension.js')).href)
  // What acpActivity.ts `airClientMeta` declares, plus two AIR flags the statement must leave as negotiated.
  const clientCapabilities = { _meta: { jetbrains: { air: { version: 1, capabilities: ['asyncTasks', 'nativeSubagentSessions', 'rawInputRendering', 'planFile'] } } } }
  const agent = { toolCallCapabilities: ClientCapabilities.from(clientCapabilities) }
  const edit = { id: 'toolu_1', name: 'Edit', input: { file_path: '/w/a.txt', old_string: 'before', new_string: 'after' } }
  // The adapter alone takes the declaration for the AIR UI and strips the edit's text.
  assert.equal(agent.toolCallCapabilities.air.client, true)
  assert.deepEqual(new AcpToolCallRenderer(agent.toolCallCapabilities).refinement(edit, '/w').rawInput, { file_path: '/w/a.txt' })
  new Function(airClientOff.slice(airClientAnchor.length)).call(agent)
  assert.deepEqual(agent.toolCallCapabilities.air, { client: false, rawInputRendering: true, planFile: true })
  assert.deepEqual(new AcpToolCallRenderer(agent.toolCallCapabilities).refinement(edit, '/w').rawInput, edit.input)
  // Async tasks and subagents are read from the raw capabilities, which the statement does not touch.
  assert.equal(clientSupportsAirCapability(clientCapabilities, 'asyncTasks'), true)
  assert.equal(clientSupportsAirCapability(clientCapabilities, 'nativeSubagentSessions'), true)
})

/* The injected handler itself, evaluated as injected, with a stand-in for the SDK's RequestError. */
class RequestError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data }
  static invalidParams(data, detail) { return new RequestError(-32602, `Invalid params${detail ? `: ${detail}` : ''}`, data) }
  static internalError(data, detail) { return new RequestError(-32603, `Internal error${detail ? `: ${detail}` : ''}`, data) }
}
const injected = new Function('RequestError', `${contextUsageHandlerSource}\nreturn { cinnaContextUsage, cinnaContextUsageParams }`)(RequestError)

const SDK_ANSWER = {
  categories: [{ name: 'System prompt', tokens: 3100, color: 'promptBorder' }, { name: 'MCP tools', tokens: 900, color: 'x', isDeferred: true }],
  totalTokens: 18000, maxTokens: 200000, rawMaxTokens: 200000, percentage: 9,
  gridRows: [[{ color: 'x', isFilled: true, categoryName: 'System prompt', tokens: 3100, percentage: 1, squareFullness: 1 }]],
  model: 'claude-sonnet-5',
  memoryFiles: [{ path: '/home/someone/project/CLAUDE.md', type: 'Project', tokens: 120 }],
  mcpTools: [{ name: 'mcp__cinna__probe', serverName: 'cinna', tokens: 80, isLoaded: true }],
  deferredBuiltinTools: [{ name: 'WebSearch', tokens: 10, isLoaded: false }],
  systemTools: [{ name: 'Bash', tokens: 400 }],
  systemPromptSections: [{ name: 'Environment', tokens: 200 }],
  agents: [{ agentType: 'helper', source: 'sdk', tokens: 30 }],
  slashCommands: { totalCommands: 12, includedCommands: 10, tokens: 150 },
  skills: { totalSkills: 3, includedSkills: 2, tokens: 60, skillFrontmatter: [{ name: 'pdf', source: 'user', tokens: 20 }] },
  isAutoCompactEnabled: true,
  messageBreakdown: { toolCallTokens: 1, toolResultTokens: 1, attachmentTokens: 0, assistantMessageTokens: 1, userMessageTokens: 1, redirectedContextTokens: 0, unattributedTokens: 0, toolCallsByType: [], attachmentsByType: [] },
  apiUsage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
}

test('the handler answers a trimmed context usage, never the grid', async () => {
  let asked = 0
  let options
  const agent = { sessions: { s1: { activeTurn: null, query: { getContextUsage: async (o) => { asked++; options = o; return SDK_ANSWER } } } } }
  const answer = await injected.cinnaContextUsage(agent, injected.cinnaContextUsageParams({ sessionId: 's1', extra: 1 }))
  assert.equal(asked, 1)
  // The categories need the full breakdown; the adapter's own background call asks for `summary`.
  assert.deepEqual(options, { detail: 'full' })
  assert.deepEqual(answer, {
    categories: [{ name: 'System prompt', tokens: 3100 }, { name: 'MCP tools', tokens: 900, isDeferred: true }],
    totalTokens: 18000, maxTokens: 200000, rawMaxTokens: 200000, percentage: 9, model: 'claude-sonnet-5',
    memoryFiles: [{ path: '/home/someone/project/CLAUDE.md', type: 'Project', tokens: 120 }],
    mcpTools: [{ name: 'mcp__cinna__probe', serverName: 'cinna', tokens: 80, isLoaded: true }],
    agents: [{ agentType: 'helper', source: 'sdk', tokens: 30 }],
    systemTools: [{ name: 'Bash', tokens: 400 }],
    systemPromptSections: [{ name: 'Environment', tokens: 200 }],
    skills: { totalSkills: 3, includedSkills: 2, tokens: 60 },
    slashCommands: { totalCommands: 12, includedCommands: 10, tokens: 150 }
  })
})

test('the handler refuses a bad request, an unknown session and a session mid-turn without asking the SDK', async () => {
  let asked = 0
  const query = { getContextUsage: async () => { asked++; return SDK_ANSWER } }
  const agent = { sessions: { busy: { activeTurn: { promptUuid: 'p' }, query } } }
  assert.throws(() => injected.cinnaContextUsageParams(undefined), (err) => err.code === -32602)
  assert.throws(() => injected.cinnaContextUsageParams({ sessionId: '' }), (err) => err.code === -32602)
  await assert.rejects(injected.cinnaContextUsage(agent, { sessionId: 'nope' }), (err) => err.code === -32602 && /unknown session/.test(err.message))
  await assert.rejects(injected.cinnaContextUsage(agent, { sessionId: 'busy' }), (err) => err.data?.reason === 'busy' && /busy/.test(err.message))
  assert.equal(asked, 0)
})

test('the handler refuses a prompt queued before activation as busy, and an ended query as closed', async () => {
  let asked = 0
  const query = { getContextUsage: async () => { asked++; return SDK_ANSWER } }
  const agent = { sessions: {
    queued: { activeTurn: null, turnQueue: [{ promptUuid: 'p', settled: false }], query },
    settled: { activeTurn: null, turnQueue: [{ promptUuid: 'p', settled: true }], query },
    closed: { activeTurn: null, queryClosed: true, query }
  } }
  await assert.rejects(injected.cinnaContextUsage(agent, { sessionId: 'queued' }), (err) => err.data?.reason === 'busy')
  await assert.rejects(injected.cinnaContextUsage(agent, { sessionId: 'closed' }), (err) => err.data?.reason === 'closed' && /closed/.test(err.message))
  assert.equal(asked, 0)
  // A queue of settled turns is between turns.
  await injected.cinnaContextUsage(agent, { sessionId: 'settled' })
  assert.equal(asked, 1)
})
