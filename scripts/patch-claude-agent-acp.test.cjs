const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const {
  patchClaudeAgentAcp, verifyClaudeAgentAcpPatch, CONTEXT_USAGE_METHOD, contextUsageHandlerSource, contextUsageRoute, contextUsageRouteAnchor,
  airClientAnchor, airClientOff, resumeKeyAnchor, resumeKey, resumeAliasAnchor, resumeAlias, resumeFinishAnchor, resumeFinish
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
  const subagentsPath = join(directory, 'dist/native-subagents.js')
  const subagentsOriginal = readFileSync(join(__dirname, '../node_modules/@agentclientprotocol/claude-agent-acp/dist/native-subagents.js'), 'utf8')
    .replace(resumeKey, () => resumeKeyAnchor).replace(resumeAlias, () => resumeAliasAnchor).replace(resumeFinish, () => resumeFinishAnchor)
  assert.equal(sha(subagentsOriginal), policy.subagentsOriginalSha256)
  writeFileSync(subagentsPath, subagentsOriginal)
  return { root, path, manifest, original, subagentsPath, subagentsOriginal }
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
  // The resume routing: keyed once in taskStarted, aliased once in openGeneration, guarded once in finishTask.
  const subagents = readFileSync(f.subagentsPath)
  assert.equal(sha(subagents), policy.subagentsPatchedSha256)
  const subagentsText = subagents.toString('utf8')
  assert.equal(subagentsText.split('parentToolUseId: previous?.parentToolUseId ?? task.toolUseId ?? undefined,').length, 2)
  assert.equal(subagentsText.split('if (child.resumeToolUseId) {').length, 2)
  assert.equal(subagentsText.split('if (child?.resumeToolUseId && toolUseId === child.parentToolUseId)').length, 2)
})

test('packaging rejects either file unpatched, and a refusal of one file leaves the other unwritten', (t) => {
  const f = fixture(t)
  patchClaudeAgentAcp(f.root)
  writeFileSync(f.subagentsPath, f.subagentsOriginal)
  assert.throws(() => verifyClaudeAgentAcpPatch(f.root), /resumed subagent routing\) is missing or changed/)
  writeFileSync(f.path, f.original)
  const changed = `${f.subagentsOriginal}\n// different distribution\n`
  writeFileSync(f.subagentsPath, changed)
  assert.throws(() => patchClaudeAgentAcp(f.root), /native-subagents\.js\) differs/)
  assert.equal(readFileSync(f.path, 'utf8'), f.original)
  assert.equal(readFileSync(f.subagentsPath, 'utf8'), changed)
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

/*
 * The resume routing, on the adapter's own NativeSubagentRuntime as patched in
 * node_modules. Recorded live on CLI 2.1.296: a
 * SendMessage resume's task_started names the SendMessage call, while the
 * resumed agent's frames still name the Agent call that spawned it.
 */
test('a resumed subagent is routed by the Agent call its frames name, outlives that call\'s late notification, and ends by its SendMessage call', async () => {
  const dist = join(__dirname, '../node_modules/@agentclientprotocol/claude-agent-acp/dist')
  const { NativeSubagentRuntime } = await import(pathToFileURL(join(dist, 'native-subagents.js')).href)
  const published = []
  const logs = []
  const runtime = new NativeSubagentRuntime(true, 'root', {}, async (n) => { published.push(n) }, { log: (line) => logs.push(line) })
  const deliver = async () => {}
  const agentCall = (id, parentToolUseId) => ({
    sessionId: 'root',
    update: {
      sessionUpdate: 'tool_call', toolCallId: id, rawInput: { description: id, prompt: 'go', subagent_type: 'worker' },
      _meta: { claudeCode: { toolName: 'Agent', ...(parentToolUseId ? { parentToolUseId } : {}) } }
    }
  })
  const states = () => published.filter((n) => n.update.sessionUpdate !== 'subagent_spawned')
    .map((n) => [n.sessionId, n.update.subagentSessionId, n.update.state])

  await runtime.route(agentCall('orig'), deliver)
  await runtime.taskStarted({ taskId: 'a1', toolUseId: 'orig', subagentType: 'worker', description: 'orchestrator', prompt: 'go' }, deliver)
  await runtime.finishTask('a1', 'completed', deliver, 'orig')
  // SendMessage resumes it: a new task_started for the same agent, under the SendMessage call.
  await runtime.taskStarted({ taskId: 'a1', toolUseId: 'send', subagentType: 'worker', description: 'orchestrator', prompt: 'more' }, deliver)
  assert.deepEqual(published.at(-1), {
    sessionId: 'root',
    update: { sessionUpdate: 'subagent_spawned', subagentSessionId: 'a1:generation:2', name: published.at(-1).update.name, task: published.at(-1).update.task, prompt: 'more', capabilities: {} }
  })

  // A late task_notification of generation 1 names the original Agent call: generation 2 runs on.
  await runtime.finishTask('a1', 'completed', deliver, 'orig')
  assert.deepEqual(states(), [['root', 'a1', 'completed']])

  // The resumed agent's frame names the original Agent call and reaches generation 2.
  const chunk = { sessionId: 'root', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' }, _meta: { claudeCode: { parentToolUseId: 'orig' } } } }
  assert.equal((await runtime.route(chunk, deliver))?.sessionId, 'a1:generation:2')
  assert.deepEqual(logs.filter((line) => line.includes('late update')), [])

  // A child it spawns is announced on generation 2's session.
  await runtime.route(agentCall('nested', 'orig'), deliver)
  await runtime.taskStarted({ taskId: 'b1', toolUseId: 'nested', subagentType: 'leaf', description: 'leaf', prompt: 'x' }, deliver)
  assert.deepEqual(published.filter((n) => n.update.subagentSessionId === 'b1').map((n) => n.sessionId), ['a1:generation:2'])
  await runtime.finishTask('b1', 'completed', deliver, 'nested')

  // Its task_notification names the SendMessage call, and ends generation 2.
  await runtime.finishTask('a1', 'completed', deliver, 'send')
  assert.deepEqual(states(), [
    ['root', 'a1', 'completed'],
    ['a1:generation:2', 'b1', 'completed'],
    ['root', 'a1:generation:2', 'completed']
  ])
})
