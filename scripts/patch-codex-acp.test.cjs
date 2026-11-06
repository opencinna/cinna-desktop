const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const {
  patchCodexAcp, verifyCodexAcpPatch, original: mcpOriginal, replacement: mcpReplacement, instructions, instructionAnchors, airClientAnchor, airClientOff, commandEndAnchor, commandEndWhole,
  childrenAnchor, interruptChildren, cancelAnchor, cancelChildren
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
    .replace(commandEndWhole, () => commandEndAnchor).replace(interruptChildren, () => '').replace(cancelChildren, () => cancelAnchor)
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
  // session/load and session/resume both resume through the one helper, which hands its params to thread/resume as they are
  // unless an ACP systemPrompt changes (Cinna sends none); upstream's own developerInstructions spread follows ours.
  assert.match(applied, /async resumeThreadWithInstructions\(params, request, previous\) \{\n\s+if \(!changesSystemPrompt\(request, previous\)\) return this\.resumeThread\(params\);/)
  assert.match(applied, /async resumeThread\(params\) \{\n[^\n]*\n\s+const response = await this\.codexClient\.threadResume\(params\);/)
  assert.match(applied, /function changesSystemPrompt\(request, previous\) \{\n\s+const text = clientSystemPromptText\(request\.systemPrompt\);\n[^\n]*\n\s+return text !== void 0 &&/)
  assert.equal(applied.split(`${instructionAnchors[1][0]}${instructions}
      excludeTurns: true,`).length, 3)
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
  // Five readers: the capability object (ACP v1 and v2), the two question paths, and the subagent protocol.
  assert.equal(applied.match(/isAirClient\(/g).length, 6)
  assert.match(applied, /static from\(capabilities\) \{\n\s+const airClient = isAirClient\(capabilities\);\n[^\n]*\n\s+return new _ClientCapabilities\(\{\n\s+airClient,\n\s+airToolCallContract: airClient,/)
  assert.equal(applied.split('airClient: isAirClient(capabilities),').length, 2)
  assert.equal(applied.split('const airClient = isAirClient(this.clientCapabilities);').length, 3)
  assert.equal(applied.split('const air = isAirClient(capabilities);').length, 2)
  // Nothing else reads the client's `_meta` for itself: clientSupportsAirCapability, the two terminal flags, and
  // the ACP v2 capability view copying `_meta` through (twice).
  assert.equal(applied.match(/capabilities\?\._meta/g).length, 5)
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

/*
 * `session/cancel` interrupts the root thread's turn only; the patched cancel
 * goes on to the in-progress turn of every subagent thread the subscriptions
 * discovered under the session, and to nothing else.
 */
test('cancel interrupts the in-progress turn of every subagent thread under the session, and ends its commands', async (t) => {
  const f = fixture(t)
  patchCodexAcp(f.root)
  const applied = readFileSync(f.path, 'utf8')
  assert.equal(applied.split(interruptChildren + childrenAnchor).length, 2)
  assert.equal(applied.split(cancelChildren).length, 2)
  // The method sits in the class that owns the discovered children, which CodexAcpClient holds as `subagents`.
  assert.match(applied, /var CodexSubagentSubscriptions = class \{[\s\S]*?async interruptChildren\(rootSessionId\)[\s\S]*?\n\};\n/)
  assert.match(applied, /this\.subagents = new CodexSubagentSubscriptions\(codexClient\);/)
  assert.match(applied, /async cancel\(params\) \{\n\s+const child = this\.subagentAssociations\.get\(params\.sessionId\);/)
  // The adapter's own child interrupt (2.4+) is for the standard subagent protocol only, which Cinna does not get.
  assert.match(applied, /async interruptStandardChildren\(session\) \{\n\s+if \(!\(session\.subagents instanceof StandardSubagentEventRouter\)\) return;/)

  const calls = []
  const turns = { busy: { id: 'turn-b', status: 'inProgress' }, idle: { id: 'turn-i', status: 'completed' } }
  const client = {
    threadTurnsList: async (params) => { calls.push(['list', params]); return { data: params.threadId === 'gone' ? [] : [turns[params.threadId]] } },
    turnInterrupt: async (params) => { calls.push(['interrupt', params]); if (params.threadId === 'flaky') throw new Error('no turn') },
    threadBackgroundTerminalsList: async (params) => {
      calls.push(['terminals', params])
      if (params.threadId === 'idle' && params.cursor === null) return { data: [{ processId: 'p1' }], nextCursor: 'next' }
      if (params.threadId === 'idle') return { data: [{ processId: 'p2' }], nextCursor: null }
      if (params.threadId === 'flaky') return { data: [{ processId: 'pf' }], nextCursor: null }
      return { data: params.threadId === 'busy' ? [{ processId: 'p0' }] : [], nextCursor: null }
    },
    threadBackgroundTerminalsTerminate: async (params) => { calls.push(['terminate', params]); return { terminated: true } }
  }
  turns.flaky = { id: 'turn-f', status: 'inProgress' }
  const logged = []
  const Subscriptions = new Function('logger', `return class { ${interruptChildren} }`)({ error: (...args) => logged.push(args) })
  const subscriptions = Object.assign(new Subscriptions(), {
    client,
    sessions: new Map([['root', { children: new Set(['busy', 'idle', 'gone', 'flaky']) }], ['other', { children: new Set(['elsewhere']) }]])
  })
  await subscriptions.interruptChildren('root')
  assert.deepEqual(calls.filter(([kind]) => kind === 'interrupt').map(([, params]) => params), [
    { threadId: 'busy', turnId: 'turn-b' }, { threadId: 'flaky', turnId: 'turn-f' }
  ])
  assert.deepEqual(calls.find(([kind]) => kind === 'list')[1], { threadId: 'busy', cursor: null, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })
  // An interrupted turn leaves its commands running: every page of each thread's background terminals is terminated, a finished
  // thread's too, and a thread whose interrupt threw (a closed thread) still has its commands ended.
  assert.deepEqual(calls.filter(([kind]) => kind === 'terminate').map(([, params]) => params).sort((a, b) => a.processId.localeCompare(b.processId)), [
    { threadId: 'busy', processId: 'p0' }, { threadId: 'idle', processId: 'p1' }, { threadId: 'idle', processId: 'p2' }, { threadId: 'flaky', processId: 'pf' }
  ])
  assert.ok(calls.findIndex(([kind, params]) => kind === 'interrupt' && params.threadId === 'busy') < calls.findIndex(([kind, params]) => kind === 'terminals' && params.threadId === 'busy'))
  assert.equal(logged.length, 1)
  const before = calls.length
  await subscriptions.interruptChildren('unknown')
  assert.equal(calls.length, before)
})

test('an adapter carrying a patch reviewed on an earlier version is refused and left as it is', (t) => {
  const f = fixture(t)
  // Edits 1-4 without the subagent cancel, the shape of the first 2.2.2 patch: no reversal at 2.5.0.
  let previous = f.original.replace(mcpOriginal, () => mcpReplacement)
  for (const [anchor] of instructionAnchors) previous = previous.replaceAll(anchor, () => anchor + instructions)
  previous = previous.replace(airClientAnchor, () => airClientOff).replace(commandEndAnchor, () => commandEndWhole)
  writeFileSync(f.path, previous)
  assert.throws(() => patchCodexAcp(f.root), /differs/)
  assert.equal(readFileSync(f.path, 'utf8'), previous)
})

/*
 * 2.3+ also picks the subagent protocol with `isAirClient`. Cinna declares
 * `asyncTasks` only (codexLauncher.ts), and neither `subagents` nor
 * `nativeSubagentSessions`, so it gets "hidden" whether the adapter takes it
 * for AIR or not: subagent events stay attributed to the root session.
 */
test('the subagent protocol Cinna gets is the same with the AIR client off', (t) => {
  const f = fixture(t)
  patchCodexAcp(f.root)
  const applied = readFileSync(f.path, 'utf8')
  const source = (text, name) => /\nfunction [\s\S]*?\n\}\n/.exec(text.slice(text.indexOf(`\nfunction ${name}(`)))[0]
  const declared = { elicitation: { form: {} }, _meta: { jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } } }
  const keys = ['JETBRAINS_META_KEY', 'AIR_META_KEY', 'AIR_EXTENSION_VERSION_KEY', 'AIR_EXTENSION_VERSION', 'AIR_EXTENSION_CAPABILITIES_KEY', 'AIR_NATIVE_SUBAGENT_SESSIONS_KEY']
  const protocol = (text) => new Function(
    ...keys,
    `${source(text, 'asRecord')}${source(text, 'isAirClient')}${source(text, 'clientSupportsAirCapability')}${source(text, 'subagentProtocol')}; return subagentProtocol`
  )(...keys.map((name) => new Function(`${new RegExp(`\\nvar ${name} = [^;]*;`).exec(applied)[0]}; return ${name}`)()))
  assert.equal(protocol(applied)(declared, 1), 'hidden')
  assert.equal(protocol(f.original)(declared, 1), 'hidden')
  // The declaration that would change it: nativeSubagentSessions.
  const native = { _meta: { jetbrains: { air: { version: 1, capabilities: ['asyncTasks', 'nativeSubagentSessions'] } } } }
  assert.equal(protocol(applied)(native, 1), 'air')
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
