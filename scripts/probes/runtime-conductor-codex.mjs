// Real Codex ACP contract probe. Every model response and MCP result is local
// deterministic data. No login, API credentials, or real profile is used.
// Run: node --experimental-strip-types scripts/probes/runtime-conductor-codex.mjs /path/to/codex
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { ConductorMcpServer } from '../../src/main/services/conductorMcpServer.ts'
import { TITLE_SYSTEM_PROMPT } from '../../src/main/services/aiFunctionPrompts.ts'
// Shared with the contract tests (src/main/agents/drivers/acp/contracts/): one
// copy of the isolated environment, the tool-name flattening and the way the
// production policy helper is loaded outside the app's bundler.
import { baseEnv as isolatedEnv, loadProductionPolicy, providerRequestKind, toolNames } from '../../src/main/agents/drivers/acp/contracts/codexHarness.ts'

const binary = process.argv[2]
if (!binary) throw new Error('Pass an absolute path to the Codex executable.')
assert(binary.startsWith('/'), 'This probe supports macOS/Linux absolute executable paths.')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const adapter = join(repo, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js')
const baseEnv = isolatedEnv()
const featuresDisabled = [
  'shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'multi_agent_v2',
  'apps', 'plugins', 'remote_plugin', 'image_generation', 'browser_use',
  'browser_use_external', 'computer_use', 'in_app_browser', 'code_mode',
  'code_mode_only', 'code_mode_host', 'goals', 'sleep_tool', 'skill_search',
  'tool_suggest', 'workspace_dependencies', 'hooks', 'shell_snapshot',
  'default_mode_request_user_input'
]
const catalogTransforms = {
  apply_patch_tool_type: null, experimental_supported_tools: [],
  node_repl_disabled: true, supports_search_tool: false, tool_mode: null,
  use_responses_lite: false, multi_agent_version: null, multi_agent_reasoning_effort: null
}
const quoteShell = value => `'${value.replaceAll("'", "'\\''")}'`
const adapterPatchAnchor = '"mcp_servers": Object.fromEntries(serversToConfigure.map((mcp) => [mcp.name, this.createMcpSeverConfig(mcp.server)]))'
const adapterPatch = '"mcp_servers": { ...configWithWorkspaceRoots.mcp_servers, ...Object.fromEntries(serversToConfigure.map((mcp) => [mcp.name, { enabled: true, ...this.createMcpSeverConfig(mcp.server) }])) }'
const promptPatchInsertion = '\n      ...(typeof request._meta?.cinna?.systemPrompt === "string" ? { developerInstructions: request._meta.cinna.systemPrompt } : {}),'
// The repository may already have applied its maintained patch. Both variants
// run from scratch copies so the comparison remains reproducible either way.
const installedAdapterSource = readFileSync(adapter, 'utf8')
const baselineAdapterSource = installedAdapterSource.replace(adapterPatch, adapterPatchAnchor).replaceAll(promptPatchInsertion, '')
assert.equal(baselineAdapterSource.split(adapterPatchAnchor).length, 2, 'Pinned adapter patch anchor changed')

const discoveryHome = mkdtempSync(join(tmpdir(), 'cinna-codex-catalog-'))
let catalog, binaryVersion
try {
  const options = { cwd: discoveryHome, env: { ...baseEnv, HOME: discoveryHome,
    CODEX_HOME: join(discoveryHome, 'codex') }, encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 }
  const version = spawnSync(binary, ['--version'], options)
  assert.equal(version.status, 0, 'Codex version discovery failed')
  binaryVersion = version.stdout.trim()
  const models = spawnSync(binary, ['debug', 'models', '--bundled'], options)
  assert.equal(models.status, 0, 'Codex bundled catalog discovery failed')
  catalog = JSON.parse(models.stdout)
  assert(Array.isArray(catalog.models) && catalog.models.length, 'Unknown catalog shape')
} finally { rmSync(discoveryHome, { recursive: true, force: true }) }

async function runCase(spec) {
  const home = mkdtempSync(join(tmpdir(), 'cinna-codex-probe-'))
  const cwd = join(home, 'work'), codexHome = join(home, 'codex')
  mkdirSync(cwd); mkdirSync(codexHome)
  const evidence = { case: spec.name, model: spec.model ?? 'gpt-5.5', mcpCalls: 0,
    requests: [], clientRequests: [], toolCalls: [], errors: [] }
  const mcp = new ConductorMcpServer()
  let child, lines, modelServer
  const pending = new Map()
  try {
    const provider = name => ({ getProviders: () => [{ providerType: 'mcp', displayName: name,
      getTools: () => [{ name, description: 'Return literal OK.', inputSchema: { type: 'object', properties: {} },
        providerType: 'mcp', mcpProviderId: name }],
      callTool: async () => { evidence.mcpCalls++; return { content: 'OK' } }
    }] })
    const endpoint = await mcp.ensureSession('cinna', provider('probe'))
    const unwanted = spec.inherited ? await mcp.ensureSession('unwanted', provider('unwanted')) : null
    modelServer = createServer(async (req, res) => {
      try {
        let raw = ''; for await (const part of req) raw += part
        const body = JSON.parse(raw)
        // Store schemas and our deterministic tool outputs, never prompt bodies.
        const outputs = (body.input ?? []).filter(item => item.type === 'function_call_output')
        const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
          ? content.map(block => typeof block.text === 'string' ? block.text : '').join('\n') : ''
        const systemText = [body.instructions ?? '', ...(body.input ?? [])
          .filter(item => item.role === 'developer' || item.role === 'system').map(item => textOf(item.content))].join('\n')
        const userText = (body.input ?? []).filter(item => item.role === 'user').map(item => textOf(item.content)).join('\n')
        evidence.requests.push({ model: body.model, kind: providerRequestKind(body), tools: toolNames(body.tools ?? []),
          outputs: outputs.map(item => item.output), ...(spec.promptMeta ? {
            chatPromptInSystem: systemText.includes('SESSION_CHAT_ONLY_PROMPT'),
            titlePromptInSystem: systemText.includes(TITLE_SYSTEM_PROMPT),
            titlePromptInUser: userText.includes(TITLE_SYSTEM_PROMPT),
            titleInput: userText.includes('FUNCTION_INPUT_title')
          } : {}) })
        const candidates = (body.tools ?? []).flatMap(tool => tool.type === 'namespace'
          ? tool.tools.map(item => ({ ...item, namespace: tool.name })) : [tool])
        const target = spec.fabricate ? { name: spec.fabricate } : candidates.find(tool => tool.name === 'probe')
        const lastUser = (body.input ?? []).findLastIndex(item => item.role === 'user')
        const lastOutput = (body.input ?? []).findLastIndex(item => item.type === 'function_call_output')
        const useTool = target && (outputs.length === 0 || lastUser > lastOutput)
        const args = target?.name === 'request_user_input' ? JSON.stringify({ questions: [{
          id: 'probe', header: 'Probe', question: 'Deterministic probe?', options: [
            { label: 'Yes', description: 'Accept' }, { label: 'No', description: 'Decline' }
          ]
        }] }) : '{}'
        const item = useTool ? { type: 'function_call', id: `fc_probe_${evidence.requests.length}`, call_id: `call_probe_${evidence.requests.length}`,
          name: target.name, ...(target.namespace ? { namespace: target.namespace } : {}),
          arguments: args, status: 'completed' } : { type: 'message', id: 'msg_probe', role: 'assistant',
          status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        event('response.created', { response: { id: 'resp_probe', object: 'response', created_at: 1, status: 'in_progress', output: [] } })
        event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', ...(useTool ? { arguments: '' } : { content: [] }) } })
        if (useTool) {
          event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: args })
          event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: args })
        } else {
          event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' })
          event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: 'OK' })
        }
        event('response.output_item.done', { output_index: 0, item })
        event('response.completed', { response: { id: 'resp_probe', object: 'response', created_at: 1,
          status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
        res.end()
      } catch { evidence.errors.push('Fake model request could not be decoded'); res.writeHead(400); res.end() }
    })
    await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve))
    const catalogPath = join(home, 'models.json')
    writeFileSync(catalogPath, JSON.stringify({ ...catalog,
      models: catalog.models.map(model => ({ ...model, ...catalogTransforms })) }))
    const config = [
      'model = "gpt-5.5"', 'model_provider = "probe"',
      ...(!spec.patched ? [`model_catalog_json = ${JSON.stringify(catalogPath)}`, 'web_search = "disabled"',
        '[features]', ...featuresDisabled.map(name => `${name} = false`)] : []),
      '[model_providers.probe]', 'name = "Loopback fake model"',
      `base_url = "http://127.0.0.1:${modelServer.address().port}/v1"`, 'wire_api = "responses"',
      'requires_openai_auth = false', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0'
    ]
    const inheritedName = spec.nameConflict ? 'cinna' : (spec.mcpName ?? 'unwanted')
    if (unwanted) {
      config.push(`[mcp_servers.${JSON.stringify(inheritedName)}]`, `enabled = ${spec.inherited !== 'file-disabled' && !spec.disabledConflict}`)
      if (spec.stdioConflict) config.push('command = "/usr/bin/false"')
      else config.push(`url = ${JSON.stringify(unwanted.descriptor.url)}`, `[mcp_servers.${JSON.stringify(inheritedName)}.http_headers]`,
        `Authorization = ${JSON.stringify(unwanted.descriptor.headers[0].value)}`)
    }
    writeFileSync(join(codexHome, 'config.toml'), config.join('\n') + '\n')
    const threadConfig = { model: evidence.model, model_provider: 'probe',
      ...(!spec.promptMeta || spec.production ? { developer_instructions: spec.promptMeta
        ? 'SESSION_CHAT_ONLY_PROMPT' : 'Call only the Cinna probe, then return OK.' } : {}) }
    if (spec.inherited === 'thread-empty') threadConfig.mcp_servers = {}
    if (spec.inherited === 'thread-disabled') threadConfig.mcp_servers = { unwanted: { enabled: false } }
    let executable = binary
    let adapterPath = join(home, 'codex-acp.mjs')
    let adapterSource = spec.patched ? baselineAdapterSource.replace(adapterPatchAnchor, adapterPatch) : baselineAdapterSource
    if (spec.promptMeta) {
      for (const method of ['threadStart', 'threadResume']) {
        const anchor = `const response = await this.codexClient.${method}({`
        assert(adapterSource.includes(anchor), 'Session instruction patch anchor changed')
        adapterSource = adapterSource.replaceAll(anchor, anchor + promptPatchInsertion)
      }
    }
    writeFileSync(adapterPath, adapterSource)
    symlinkSync(join(repo, 'node_modules'), join(home, 'node_modules'))
    if (spec.inherited === 'wrapper-disabled') {
      executable = join(home, 'codex-wrapper.sh')
      writeFileSync(executable, `#!/bin/sh\nexec ${quoteShell(binary)} "$@" -c 'mcp_servers.unwanted.enabled=false'\n`, { mode: 0o700 })
    }
    if (spec.patched && !spec.production) {
      // This is a scratch copy, never a mutation of the installed adapter.
      executable = join(home, 'catalog-wrapper.sh')
      const startupOverrides = [`model_catalog_json=${JSON.stringify(catalogPath)}`, 'web_search="disabled"',
        ...featuresDisabled.map(name => `features.${name}=false`),
        ...(unwanted ? [`mcp_servers={${JSON.stringify(inheritedName)}={enabled=false}}`] : [])]
      writeFileSync(executable, `#!/bin/sh\nexec ${quoteShell(binary)} "$@" ${startupOverrides.map(value => `-c ${quoteShell(value)}`).join(' ')}\n`, { mode: 0o700 })
      threadConfig.features = Object.fromEntries(featuresDisabled.map(name => [name, false]))
      threadConfig.web_search = 'disabled'
      threadConfig.mcp_servers = unwanted ? { [inheritedName]: { enabled: false } } : {}
    }
    let env = { ...baseEnv, HOME: home, CODEX_HOME: codexHome, CODEX_PATH: executable,
      ...(spec.patched && !spec.production ? { DISABLE_MCP_CONFIG_FILTERING: 'true' } : {}),
      INITIAL_AGENT_MODE: 'read-only', MODEL_PROVIDER: 'probe', CODEX_CONFIG: JSON.stringify(threadConfig) }
    let productionMeta, prepareProduction, productionPlan, preparedProduction
    if (spec.production) {
      // The helper reads its version and adapter digest from the pin manifest,
      // so both are transpiled side by side (see loadProductionPolicy).
      const prepareCodexConductorPolicy = loadProductionPolicy(repo, home)
      const plan = { spec: { command: process.execPath, args: [adapter], env, cwd, key: 'probe' },
        init: { protocolVersion: 1 }, session: { mcpServers: [] }, setup: { modeId: 'read-only' } }
      prepareProduction = candidate => prepareCodexConductorPolicy(candidate, join(home, 'policy-artifacts'))
      productionPlan = plan
      try {
        const prepared = await prepareProduction(plan)
        preparedProduction = prepared
        productionMeta = prepared.session.meta
        env = prepared.spec.env
        adapterPath = adapter
        evidence.productionHelper = { marker: prepared.conductorPolicy,
          defaultModeSetup: prepared.setup.configOptions.some(option => option.configId === 'collaboration_mode' && option.value === 'default') }
      } catch (error) {
        if (!spec.stdioConflict) throw error
        evidence.expectedFailClosed = true
        evidence.productionHelperRefusal = String(error.message).replaceAll(home, '<throwaway>')
        evidence.passed = /stdio MCP named cinna/.test(evidence.productionHelperRefusal)
        return evidence
      }
    }
    child = spawn(process.execPath, [adapterPath], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    let stderr = '', id = 0
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000) })
    lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      let message; try { message = JSON.parse(line) } catch { return }
      if (message.id !== undefined && (message.result !== undefined || message.error)) {
        const entry = pending.get(message.id)
        if (entry) { clearTimeout(entry.timer); pending.delete(message.id); entry.resolve(message) }
      } else if (message.method === 'session/update' && message.params?.update?.sessionUpdate === 'tool_call') {
        const update = message.params.update
        evidence.toolCalls.push(Object.fromEntries(['title', 'kind', 'rawInput', '_meta']
          .filter(key => update[key] !== undefined).map(key => [key, update[key]])))
      } else if (message.id !== undefined) {
        const allowed = message.method === 'session/request_permission' &&
          JSON.stringify(message.params?.toolCall ?? {}).includes('probe')
          ? message.params.options?.find(option => option.kind === 'allow_once') : null
        evidence.clientRequests.push({ method: message.method, allowedOnlyDeterministicProbe: !!allowed })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
          outcome: allowed ? { outcome: 'selected', optionId: allowed.optionId } : { outcome: 'cancelled' }
        } }) + '\n')
      }
    })
    function rpc(method, params) {
      const requestId = ++id
      return new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(requestId); resolve({ error: { code: 'timeout', message: method } }) }, 20000)
        pending.set(requestId, { resolve, timer })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
      })
    }
    const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cinna-probe', version: '1' } })
    assert(!init.error, 'ACP initialize failed')
    const session = await rpc('session/new', { cwd, mcpServers: spec.noMcp ? [] : [endpoint.descriptor],
      ...(productionMeta ? { _meta: productionMeta }
        : spec.promptMeta ? { _meta: { cinna: { systemPrompt: 'SESSION_CHAT_ONLY_PROMPT' } } } : {}) })
    if (session.error) {
      evidence.sessionError = { code: session.error.code,
        message: String(session.error.message).replaceAll(home, '<throwaway>')
          .replaceAll(endpoint.descriptor.headers[0].value, '<probe-token>') }
      if (spec.stdioConflict) {
        assert.equal(evidence.requests.length, 0)
        evidence.passed = true
        evidence.expectedFailClosed = true
        return evidence
      }
    }
    assert(!session.error, 'ACP session/new failed')
    const sessionId = session.result.sessionId
    evidence.initialCollaborationMode = session.result.configOptions?.find(option => option.id === 'collaboration_mode')?.currentValue
    const setDefault = await rpc('session/set_config_option', { sessionId, configId: 'collaboration_mode', value: 'default' })
    assert(!setDefault.error, 'Default collaboration mode setup failed')
    const sendPrompt = () => rpc('session/prompt', { sessionId,
      prompt: [{ type: 'text', text: 'Call the Cinna probe if available, then return OK.' }] })
    let prompt = await sendPrompt()
    if (spec.resume) {
      const setPlan = await rpc('session/set_config_option', { sessionId, configId: 'collaboration_mode', value: 'plan' })
      assert(!setPlan.error, 'Plan-mode fixture setup failed')
      const loaded = await rpc('session/load', { sessionId, cwd, mcpServers: spec.noMcp ? [] : [endpoint.descriptor],
        ...(productionMeta ? { _meta: productionMeta } : {}) })
      assert(!loaded.error, 'ACP session/load failed')
      evidence.resumedCollaborationMode = loaded.result.configOptions?.find(option => option.id === 'collaboration_mode')?.currentValue
      const reset = await rpc('session/set_config_option', { sessionId, configId: 'collaboration_mode', value: 'default' })
      assert(!reset.error, 'Resumed Default-mode reset failed')
      evidence.defaultReset = true
      prompt = await sendPrompt()
    }
    if (spec.modelChange) {
      const changed = await rpc('session/set_config_option', { sessionId, configId: 'model', value: 'gpt-6-astra' })
      assert(!changed.error, 'Model-change fixture setup failed')
      evidence.modelChangedTo = 'gpt-6-astra'
      const requestsBeforeChange = evidence.requests.length
      prompt = await sendPrompt()
      // Not `requests.at(-1)`, and not `some(...)` either — that still passes
      // with the conversation left on the old model. 0.155.0 sends requests of
      // its own around this turn (a thread title on gpt-5.6-luna; a compaction
      // on the model being LEFT), told apart by content in `providerRequestKind`
      // and pinned by the contract entry `codex.provider.auxiliary-request`.
      // Every conversation request from here on must be on the new model, and
      // there must be one; the tool-set check further down still covers every
      // request, the CLI's own included.
      const conversation = evidence.requests.slice(requestsBeforeChange).filter(request => request.kind === 'conversation')
      assert(conversation.length > 0, 'No conversation request followed the model change')
      assert.deepEqual(conversation.map(request => request.model), conversation.map(() => 'gpt-6-astra'),
        'A conversation request after the model change stayed on the old model')
    }
    if (spec.promptMeta) {
      const utilityCwd = join(home, 'utility'); mkdirSync(utilityCwd)
      let utilityMeta = { cinna: { systemPrompt: TITLE_SYSTEM_PROMPT } }
      if (spec.production) {
        const candidate = { ...productionPlan, spec: { ...productionPlan.spec,
          env: { ...productionPlan.spec.env, CODEX_CONFIG: JSON.stringify({ ...threadConfig, developer_instructions: TITLE_SYSTEM_PROMPT }) } } }
        const utilityPlan = await prepareProduction(candidate)
        assert.equal(utilityPlan.spec.key, preparedProduction.spec.key, 'Prompt change prevents warm process reuse')
        assert.equal(utilityPlan.spec.env.CODEX_PATH, preparedProduction.spec.env.CODEX_PATH, 'Prompt change changes process wrapper')
        utilityMeta = utilityPlan.session.meta
        evidence.productionHelper.warmCompatibleProcess = true
      }
      const utility = await rpc('session/new', { cwd: utilityCwd, mcpServers: [],
        _meta: utilityMeta })
      assert(!utility.error, 'Utility session/new failed')
      const utilityId = utility.result.sessionId
      const setup = await rpc('session/set_config_option', { sessionId: utilityId, configId: 'collaboration_mode', value: 'default' })
      assert(!setup.error, 'Utility Default-mode setup failed')
      const result = await rpc('session/prompt', { sessionId: utilityId,
        prompt: [{ type: 'text', text: 'FUNCTION_INPUT_title' }] })
      assert(!result.error, 'Utility prompt failed')
      const utilityRequests = evidence.requests.filter(request => request.titleInput)
      assert(utilityRequests.some(request => request.titlePromptInSystem), 'Exact title prompt absent from developer/system input')
      assert(utilityRequests.every(request => !request.chatPromptInSystem && !request.titlePromptInUser), 'Utility instructions leaked across sessions or into user input')
      assert(utilityRequests.every(request => request.tools.every(name => name === 'request_user_input')), 'Utility has usable tools')
      assert(evidence.requests.some(request => request.chatPromptInSystem && !request.titlePromptInSystem), 'Chat prompt isolation missing')
      evidence.sameProcessPromptIsolation = true
    }
    evidence.stopReason = prompt.result?.stopReason ?? null
    if (prompt.error) evidence.errors.push(`ACP prompt failed (${prompt.error.code})`)
    if (stderr) evidence.stderr = stderr.replaceAll(home, '<throwaway>').replaceAll(repo, '<repository>')
    const names = evidence.requests[0]?.tools ?? []
    assert(names.length, 'Fake provider received no tool catalog')
    const allowedTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates',
      'read_mcp_resource', 'request_user_input', 'mcp__cinna.probe', 'mcp__unwanted.unwanted'])
    assert(evidence.requests.every(request => request.tools.every(name => allowedTools.has(name))), 'Unexpected native tool exposed')
    if (spec.fabricate) {
      assert.equal(evidence.mcpCalls, 0)
      assert.match(JSON.stringify(evidence.requests.at(-1).outputs),
        spec.fabricate === 'request_user_input' ? /unavailable in Default mode/ : /unsupported call/)
    } else if (spec.noMcp) assert.equal(evidence.mcpCalls, 0)
    else assert.equal(evidence.mcpCalls, spec.resume || spec.modelChange ? 2 : 1)
    if (spec.inherited) assert.equal(names.some(name => name.endsWith('.unwanted')),
      !spec.patched && spec.inherited !== 'file-disabled')
    assert.equal(evidence.stopReason, 'end_turn')
    evidence.passed = true
    return evidence
  } catch (error) {
    evidence.passed = false
    evidence.errors.push(String(error.message).replaceAll(home, '<throwaway>'))
    return evidence
  } finally {
    for (const entry of pending.values()) clearTimeout(entry.timer)
    if (child) { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
    lines?.close()
    await mcp.dispose()
    if (modelServer) { modelServer.closeAllConnections(); await new Promise(resolve => modelServer.close(resolve)) }
    if (child && child.exitCode === null) {
      await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 1000).unref() })
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }
    rmSync(home, { recursive: true, force: true })
  }
}

const cases = [
  { name: 'cinna-tool' }, { name: 'astra-cinna-tool', model: 'gpt-6-astra' },
  { name: 'utility', noMcp: true },
  ...['exec_command', 'apply_patch', 'set_collaboration_mode'].map(fabricate => ({ name: `reject-${fabricate}`, fabricate })),
  { name: 'utility-reject-question', noMcp: true, fabricate: 'request_user_input' },
  ...['thread-empty', 'thread-disabled', 'file-disabled', 'wrapper-disabled'].map(inherited => ({ name: `inherited-${inherited}`, inherited })),
  ...catalog.models.map(model => ({ name: `patched-cinna-${model.slug}`, model: model.slug, patched: true, inherited: 'enabled' })),
  { name: 'patched-utility', patched: true, inherited: 'enabled', noMcp: true, fabricate: 'request_user_input' },
  { name: 'patched-name-conflict', patched: true, inherited: 'enabled', nameConflict: true },
  { name: 'patched-disabled-name-conflict', patched: true, inherited: 'enabled', nameConflict: true, disabledConflict: true },
  { name: 'patched-stdio-name-conflict', patched: true, inherited: 'enabled', nameConflict: true, stdioConflict: true },
  { name: 'patched-resume', patched: true, inherited: 'enabled', resume: true },
  { name: 'patched-resume-utility', patched: true, inherited: 'enabled', resume: true, noMcp: true, fabricate: 'request_user_input' },
  { name: 'patched-model-change', patched: true, inherited: 'enabled', modelChange: true },
  { name: 'patched-quoted-mcp-name', patched: true, inherited: 'enabled', modelChange: true, mcpName: 'native.with.dots-and-hyphens' },
  { name: 'patched-escaped-mcp-name', patched: true, inherited: 'enabled', modelChange: true, mcpName: 'native."quoted";semi\nnext' },
  { name: 'patched-session-prompts', patched: true, inherited: 'enabled', promptMeta: true },
  { name: 'production-helper-resume', patched: true, production: true, inherited: 'enabled', resume: true },
  { name: 'production-helper-model-change', patched: true, production: true, inherited: 'enabled', modelChange: true },
  { name: 'production-helper-stdio-refusal', patched: true, production: true, inherited: 'enabled', nameConflict: true, stdioConflict: true },
  { name: 'production-helper-session-prompts', patched: true, production: true, inherited: 'enabled', promptMeta: true },
  ...['exec_command', 'apply_patch', 'set_collaboration_mode'].map(fabricate => ({
    name: `patched-reject-${fabricate}`, patched: true, inherited: 'enabled', fabricate
  }))
]
const results = []
for (const spec of cases.filter(spec => !process.argv[3] || spec.name === process.argv[3])) results.push(await runCase(spec))
console.log(JSON.stringify({ binaryVersion, adapterVersion: JSON.parse(readFileSync(join(repo,
  'node_modules/@agentclientprotocol/codex-acp/package.json'), 'utf8')).version,
  isolatedHome: true, isolatedCwd: true, realProviderRequests: 0, apiCredentialEnvironmentInherited: false,
  rawCatalogOrPromptsRetained: false, catalogTransforms, featuresDisabled,
  scratchAdapterPatch: { anchor: adapterPatchAnchor, replacement: adapterPatch }, results }, null, 2))
if (results.some(result => !result.passed)) process.exitCode = 1
