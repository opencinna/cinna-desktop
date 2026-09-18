import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { AcpLaunchPlan } from './acpLaunchers'
import adapterPatch from './codexAdapterPatch.json'

const SUPPORTED_VERSION = 'codex-cli 0.154.0-alpha.6.2'
const MAX_OUTPUT = 8 * 1024 * 1024
const FEATURES_DISABLED = [
  'shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'multi_agent_v2',
  'apps', 'plugins', 'remote_plugin', 'image_generation', 'browser_use',
  'browser_use_external', 'computer_use', 'in_app_browser', 'code_mode',
  'code_mode_only', 'code_mode_host', 'goals', 'sleep_tool', 'skill_search',
  'tool_suggest', 'workspace_dependencies', 'hooks', 'shell_snapshot',
  'default_mode_request_user_input'
]
const CATALOG_POLICY = {
  apply_patch_tool_type: null, experimental_supported_tools: [], node_repl_disabled: true,
  supports_search_tool: false, tool_mode: null, use_responses_lite: false,
  multi_agent_version: null, multi_agent_reasoning_effort: null
}
const remedy = 'Choose Claude or OpenCode for this chat, or use the verified Codex CLI version.'
const failure = (reason: string): Error => new Error(`Codex cannot enforce the chat tool policy: ${reason}. ${remedy}`)
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

interface ProbeInput { binary: string; env: Record<string, string>; cwd: string; signal: AbortSignal }
export interface CodexConductorPolicyDeps {
  platform: NodeJS.Platform
  adapterDigest(path: string): Promise<string>
  run(input: ProbeInput, args: string[]): Promise<string>
  /** Returns only model IDs and MCP names. Never returns credentials/config layers. */
  discover(input: ProbeInput, needsDefault: boolean): Promise<{ model: string | null; mcpNames: string[]; defaultModel: string | null; cinnaStdio?: boolean }>
}
export interface CodexConductorPolicyOptions {
  signal?: AbortSignal
  timeoutMs?: number
  deps?: Partial<CodexConductorPolicyDeps>
}

function run(input: ProbeInput, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(input.binary, args, { cwd: input.cwd, env: input.env, signal: input.signal,
      encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, windowsHide: true },
    (error, stdout) => error ? reject(failure('CLI inspection failed')) : resolve(stdout))
  })
}

/** Read effective configuration without starting a thread, prompt, or authentication flow. */
async function discover(input: ProbeInput, needsDefault: boolean): Promise<{ model: string | null; mcpNames: string[]; defaultModel: string | null; cinnaStdio: boolean }> {
  input.signal.throwIfAborted()
  const child = spawn(input.binary, ['app-server'], { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let nextId = 0
  let buffer = ''
  let total = 0
  let ended = false
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const fail = (): void => {
    ended = true
    for (const request of pending.values()) request.reject(failure('effective configuration could not be inspected'))
    pending.clear()
  }
  const abort = (): void => { fail(); child.kill('SIGKILL') }
  input.signal.addEventListener('abort', abort, { once: true })
  child.on('error', fail)
  child.on('exit', fail)
  child.stdin.on('error', fail)
  // Configuration errors may contain secrets. Drain stderr without retaining it.
  child.stderr.resume()
  child.stdout.on('data', (chunk: Buffer) => {
    total += chunk.length
    if (total > MAX_OUTPUT) { abort(); return }
    buffer += chunk.toString('utf8')
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      let message: unknown
      try { message = JSON.parse(line) } catch { abort(); return }
      if (!object(message)) { abort(); return }
      if (typeof message.id !== 'number') continue
      const request = pending.get(message.id)
      if (!request) continue
      pending.delete(message.id)
      if ('error' in message) request.reject(failure('effective configuration was refused'))
      else if ('result' in message) request.resolve(message.result)
      else { request.reject(failure('effective configuration response was malformed')); abort() }
    }
  })
  const rpc = (method: string, params: unknown): Promise<unknown> => {
    input.signal.throwIfAborted()
    if (ended) return Promise.reject(failure('configuration reader exited'))
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }
  try {
    await rpc('initialize', { clientInfo: { name: 'cinna-policy-inspection', version: '1' }, capabilities: { experimentalApi: true } })
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
    const response = await rpc('config/read', { includeLayers: false, cwd: input.cwd })
    if (!object(response) || !object(response.config)) throw failure('effective configuration response was malformed')
    const config = response.config
    if (config.model !== null && config.model !== undefined && (typeof config.model !== 'string' || !config.model)) throw failure('effective model was malformed')
    if (config.mcp_servers !== null && config.mcp_servers !== undefined && !object(config.mcp_servers)) throw failure('inherited MCP configuration was malformed')
    const model = typeof config.model === 'string' ? config.model : null
    const mcpNames = object(config.mcp_servers) ? Object.keys(config.mcp_servers) : []
    const cinna = object(config.mcp_servers) ? config.mcp_servers.cinna : undefined
    const cinnaStdio = object(cinna) && 'command' in cinna
    let defaultModel: string | null = null
    if (needsDefault && !model) {
      const models = await rpc('model/list', { includeHidden: true })
      if (!object(models) || !Array.isArray(models.data)) throw failure('default model discovery was malformed')
      const defaults = models.data.filter((item): item is Record<string, unknown> => object(item) && item.isDefault === true)
      if (defaults.length !== 1 || typeof defaults[0].id !== 'string' || !defaults[0].id) throw failure('the CLI did not identify a default model')
      defaultModel = defaults[0].id
    }
    return { model, mcpNames, defaultModel, cinnaStdio }
  } finally {
    input.signal.removeEventListener('abort', abort)
    fail()
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy()
    child.kill('SIGKILL')
  }
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(failure('policy inspection was canceled or timed out'))
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
  })
}

/** Artifacts are content-addressed; never rewrite a file a running process may be reading. */
async function immutableFile(path: string, content: string, mode: number): Promise<void> {
  try {
    if (await readFile(path, 'utf8') !== content) throw failure('generated policy artifact was changed')
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { mode, flag: 'wx' })
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => {}) }
}

/** Requires the pinned ACP adapter's MCP merge patch; ordinary folder agents never use this. */
export async function prepareCodexConductorPolicy(plan: AcpLaunchPlan, configRoot: string, options: CodexConductorPolicyOptions = {}): Promise<AcpLaunchPlan> {
  const deps = { platform: process.platform, run, discover,
    adapterDigest: async (path: string): Promise<string> => {
      const bytes = await readFile(path)
      if (bytes.length > MAX_OUTPUT) throw failure('the ACP adapter is too large to verify')
      return createHash('sha256').update(bytes).digest('hex')
    }, ...options.deps }
  if (deps.platform === 'win32') throw failure('Windows startup isolation is not supported')
  const binary = plan.spec.env.CODEX_PATH
  if (!binary || !isAbsolute(binary) || !isAbsolute(configRoot)) throw failure('an absolute executable and private configuration directory are required')
  let config: unknown
  try { config = JSON.parse(plan.spec.env.CODEX_CONFIG ?? '{}') } catch { throw failure('runtime configuration was malformed') }
  if (!object(config)) throw failure('runtime configuration was malformed')
  if (config.model !== undefined && config.model !== null && (typeof config.model !== 'string' || !config.model)) throw failure('the requested model was malformed')
  if (config.features !== undefined && !object(config.features)) throw failure('runtime feature configuration was malformed')
  if (config.mcp_servers !== undefined && !object(config.mcp_servers)) throw failure('runtime MCP configuration was malformed')
  const controller = new AbortController()
  const aborted = (): void => controller.abort()
  options.signal?.addEventListener('abort', aborted, { once: true })
  if (options.signal?.aborted) aborted()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
  timer.unref?.()
  const input = { binary, env: { ...plan.spec.env }, cwd: plan.spec.cwd, signal: controller.signal }
  try {
    controller.signal.throwIfAborted()
    const adapter = plan.spec.args.at(-1)
    if (!adapter || !isAbsolute(adapter) || await abortable(deps.adapterDigest(adapter), controller.signal) !== adapterPatch.patchedSha256) throw failure('the verified ACP adapter patch is missing; reinstall Cinna Desktop')
    if ((await abortable(deps.run(input, ['--version']), controller.signal)).trim() !== SUPPORTED_VERSION) throw failure(`only ${SUPPORTED_VERSION} has been verified`)
    let catalog: unknown
    try { catalog = JSON.parse(await abortable(deps.run(input, ['debug', 'models', '--bundled']), controller.signal)) } catch { throw failure('the bundled model catalog could not be read') }
    if (!object(catalog) || !Array.isArray(catalog.models) || !catalog.models.length) throw failure('the bundled model catalog was malformed')
    const slugs = new Set<string>()
    const models = catalog.models.map((model: unknown) => {
      if (!object(model) || typeof model.slug !== 'string' || !model.slug || slugs.has(model.slug) || typeof model.display_name !== 'string' || typeof model.shell_type !== 'string') throw failure('the bundled model catalog was malformed')
      slugs.add(model.slug)
      return { ...model, ...CATALOG_POLICY }
    })
    const effective = await abortable(deps.discover(input, !config.model), controller.signal)
    const localCinna = object(config.mcp_servers) ? config.mcp_servers.cinna : undefined
    if (effective.cinnaStdio || (object(localCinna) && 'command' in localCinna)) throw failure('a personal stdio MCP named cinna conflicts with the chat connector; rename that MCP server')
    const model = typeof config.model === 'string' ? config.model : effective.model ?? effective.defaultModel
    if (!model || !slugs.has(model)) throw failure('the selected model is absent from the verified bundled catalog')
    const names = new Set([...effective.mcpNames, ...Object.keys(object(config.mcp_servers) ? config.mcp_servers : {})])
    const { developer_instructions: systemPrompt, ...processConfig } = config
    if (typeof systemPrompt !== 'string') throw failure('session instructions were missing')
    const isolated = { ...processConfig, model, web_search: 'disabled',
      features: { ...(object(config.features) ? config.features : {}), ...Object.fromEntries(FEATURES_DISABLED.map((name) => [name, false])) },
      mcp_servers: Object.fromEntries([...names].sort().map((name) => [name, { enabled: false }])) }
    const catalogText = JSON.stringify({ ...catalog, models })
    const startupPolicy = [
      'web_search="disabled"',
      ...FEATURES_DISABLED.map((name) => `features.${name}=false`),
      `mcp_servers={${[...names].sort().map((name) => `${JSON.stringify(name)}={enabled=false}`).join(',')}}`
    ]
    const processEnv = { ...plan.spec.env, CODEX_CONFIG: JSON.stringify(isolated) }
    const processKey = hash(JSON.stringify([plan.spec.command, plan.spec.args, plan.spec.cwd,
      Object.entries(processEnv).sort(([a], [b]) => a.localeCompare(b))]))
    const generation = hash(JSON.stringify([SUPPORTED_VERSION, binary, catalogText, isolated, startupPolicy, processKey]))
    const directory = join(configRoot, 'codex-conductor', generation)
    controller.signal.throwIfAborted()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const catalogPath = join(directory, 'models.json')
    const wrapper = join(directory, 'codex')
    await immutableFile(catalogPath, catalogText, 0o600)
    // Auxiliary requests use startup configuration, while ACP thread/start
    // applies CODEX_CONFIG. Both layers must deny native tools and inherited MCPs.
    const startup = [
      `model_catalog_json=${JSON.stringify(catalogPath)}`,
      ...startupPolicy
    ]
    await immutableFile(wrapper, `#!/bin/sh\nexec ${quote(binary)} "$@" ${startup.map((override) => `-c ${quote(override)}`).join(' ')}\n`, 0o700)
    controller.signal.throwIfAborted()
    return { ...plan, conductorPolicy: 'no-native-tools',
      session: { ...plan.session, meta: { ...plan.session.meta, cinna: { systemPrompt } } },
      spec: { ...plan.spec, key: hash(JSON.stringify([processKey, generation, wrapper])),
      env: { ...plan.spec.env, CODEX_PATH: wrapper, CODEX_CONFIG: JSON.stringify(isolated), DISABLE_MCP_CONFIG_FILTERING: 'true' } },
      setup: { ...plan.setup, configOptions: [...(plan.setup.configOptions ?? []).filter((option) => option.configId !== 'collaboration_mode'),
        { configId: 'collaboration_mode', value: 'default' }] } }
  } catch (error) {
    if (controller.signal.aborted) throw failure('policy inspection was canceled or timed out')
    // Never expose raw subprocess output or effective configuration values.
    if (error instanceof Error && error.message.startsWith('Codex cannot enforce the chat tool policy:')) throw error
    throw failure('policy inspection failed')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', aborted)
  }
}
