import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareCodexConductorPolicy, type CodexConductorPolicyDeps } from './codexConductorPolicy'
import type { AcpLaunchPlan } from './acpLaunchers'
import adapterPatch from './codexAdapterPatch.json'
import { RUNTIME_PINS } from '../../../../shared/runtimePins'

/** What the pinned CLI prints for `--version`; the policy accepts exactly this. */
const PINNED = RUNTIME_PINS.codex.versionOutput

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const model = (slug = 'verified-model') => ({ slug, display_name: 'Verified', shell_type: 'unified_exec',
  apply_patch_tool_type: 'freeform', experimental_supported_tools: ['read_file'], node_repl_disabled: false,
  supports_search_tool: true, tool_mode: 'code', use_responses_lite: true,
  multi_agent_version: 'v2', multi_agent_reasoning_effort: 'high', custom_metadata: { retained: true } })
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

async function subject() {
  const root = await mkdtemp(join(tmpdir(), "codex policy ' "))
  roots.push(root)
  const configuration = join(root, 'generated')
  const personal = join(root, 'personal')
  await mkdir(personal)
  await writeFile(join(personal, 'config.toml'), 'model = "personal-model"\n')
  await writeFile(join(personal, 'auth.json'), '{"fixture":"unchanged"}')
  const plan: AcpLaunchPlan = {
    spec: { command: '/runtime/node', args: ['/pinned/adapter.js'], key: 'original', cwd: root,
      env: { PATH: '/usr/bin:/bin', HOME: personal, CODEX_HOME: personal, AUTH_SENTINEL: 'keep',
        CODEX_PATH: join(root, "real ' $(touch injected) binary"),
        CODEX_CONFIG: JSON.stringify({ model: 'verified-model', developer_instructions: 'Keep my instructions', features: { unrelated: true }, mcp_servers: { 'local;$(touch injected)': { command: 'never-copy-me' } } }) } },
    init: { protocolVersion: 1 }, session: { mcpServers: [] },
    setup: { modeId: 'read-only', configOptions: [{ configId: 'collaboration_mode', value: 'plan' }] }
  }
  const deps: CodexConductorPolicyDeps = {
    platform: 'darwin', adapterDigest: vi.fn(async () => adapterPatch.patchedSha256),
    run: vi.fn(async (_input, args) => args[0] === '--version' ? `${PINNED}\n` : JSON.stringify({ models: [model()] })),
    discover: vi.fn(async () => ({ model: 'effective-model', mcpNames: ['cinna', 'mail.with.dots', "quote'\nname"], defaultModel: null }))
  }
  return { root, configuration, personal, plan, deps,
    prepare: () => prepareCodexConductorPolicy(plan, configuration, { deps }) }
}

describe('sealed Codex conductor policy', () => {
  it('shares a restricted process while keeping exact instructions in each session', async () => {
    const s = await subject()
    const first = await s.prepare()
    s.plan.spec.env.CODEX_CONFIG = JSON.stringify({ ...JSON.parse(s.plan.spec.env.CODEX_CONFIG), developer_instructions: 'Different function prompt' })
    s.plan.spec.key = 'launcher-key-changes-with-instructions'
    const second = await s.prepare()
    expect(second.spec).toEqual(first.spec)
    expect(first.session.meta).toMatchObject({ cinna: { systemPrompt: 'Keep my instructions' } })
    expect(second.session.meta).toMatchObject({ cinna: { systemPrompt: 'Different function prompt' } })
  })
  it('maps verified metadata and feature flags, denies inherited MCPs, and preserves authentication without copying it', async () => {
    const s = await subject()
    const prepared = await s.prepare()
    expect(prepared.conductorPolicy).toBe('no-native-tools')
    const config = JSON.parse(prepared.spec.env.CODEX_CONFIG)
    expect(config).toMatchObject({ model: 'verified-model', web_search: 'disabled',
      features: { unrelated: true, shell_tool: false, unified_exec: false, multi_agent: false, multi_agent_v2: false, default_mode_request_user_input: false, apps: false, plugins: false },
      mcp_servers: { cinna: { enabled: false }, 'mail.with.dots': { enabled: false }, "quote'\nname": { enabled: false }, 'local;$(touch injected)': { enabled: false } } })
    expect(config.features).not.toHaveProperty('guardian_approval')
    expect(config).not.toHaveProperty('developer_instructions')
    expect(prepared.session.meta).toMatchObject({ cinna: { systemPrompt: 'Keep my instructions' } })
    expect(config.features).not.toHaveProperty('enable_request_compression')
    expect(prepared.spec.env).toMatchObject({ HOME: s.personal, CODEX_HOME: s.personal, AUTH_SENTINEL: 'keep', DISABLE_MCP_CONFIG_FILTERING: 'true' })
    expect(s.plan.spec.key).toBe('original')
    expect(JSON.parse(s.plan.spec.env.CODEX_CONFIG).features.shell_tool).toBeUndefined()
    expect(prepared.setup.configOptions).toEqual([{ configId: 'collaboration_mode', value: 'default' }])
    const catalogPath = join(prepared.spec.env.CODEX_PATH, '..', 'models.json')
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
    expect(catalog.models[0]).toEqual({ ...model(), apply_patch_tool_type: null, experimental_supported_tools: [], node_repl_disabled: true,
      supports_search_tool: false, tool_mode: null, use_responses_lite: false, multi_agent_version: null, multi_agent_reasoning_effort: null })
    expect((await stat(prepared.spec.env.CODEX_PATH)).mode & 0o777).toBe(0o700)
    expect((await stat(catalogPath)).mode & 0o777).toBe(0o600)
    expect((await stat(join(catalogPath, '..'))).mode & 0o777).toBe(0o700)
    expect(await readdir(s.personal)).toEqual(['auth.json', 'config.toml'])
    expect(await readFile(join(s.personal, 'auth.json'), 'utf8')).toBe('{"fixture":"unchanged"}')
    const files = await readdir(s.configuration, { recursive: true })
    expect(files.filter((name) => name.endsWith('auth.json') || name.endsWith('config.toml'))).toEqual([])
    expect(JSON.stringify(catalog)).not.toContain('Keep my instructions')
    expect(await readFile(prepared.spec.env.CODEX_PATH, 'utf8')).not.toContain('never-copy-me')
  })

  it('executes the actual wrapper with exact quoted executable/path/argv and duplicates thread restrictions at startup', async () => {
    const s = await subject()
    await writeFile(s.plan.spec.env.CODEX_PATH,
      `#!/bin/sh\nexec ${quote(process.execPath)} -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$@"\n`, { mode: 0o700 })
    const prepared = await s.prepare()
    const args = ['app-server', "a'b", '$(touch injected)', '; exit 99', 'line\nbreak']
    const output = await promisify(execFile)(prepared.spec.env.CODEX_PATH, args, { env: prepared.spec.env, cwd: s.root })
    const catalogPath = join(prepared.spec.env.CODEX_PATH, '..', 'models.json')
    const actual = JSON.parse(output.stdout) as string[]
    expect(actual.slice(0, args.length)).toEqual(args)
    const flags = actual.slice(args.length)
    expect(flags.filter((_arg, index) => index % 2 === 0).every((arg) => arg === '-c')).toBe(true)
    const overrides = flags.filter((_arg, index) => index % 2 === 1)
    expect(overrides).toContain(`model_catalog_json=${JSON.stringify(catalogPath)}`)
    expect(overrides).toContain('web_search="disabled"')
    const config = JSON.parse(prepared.spec.env.CODEX_CONFIG)
    for (const [name, enabled] of Object.entries(config.features)) {
      if (enabled === false) expect(overrides).toContain(`features.${name}=false`)
    }
    expect(overrides).toContain(`mcp_servers={${Object.keys(config.mcp_servers).sort().map((name) => `${JSON.stringify(name)}={enabled=false}`).join(',')}}`)
    expect(overrides.some((value) => /guardian_approval|enable_request_compression/.test(value))).toBe(false)
    expect(await readdir(s.root)).not.toContain('injected')
  })

  it('uses immutable generations and changes the process key with the model, catalog, and prior configuration', async () => {
    const s = await subject()
    const first = await s.prepare()
    const firstBytes = await readFile(first.spec.env.CODEX_PATH, 'utf8')
    expect((await s.prepare()).spec).toEqual(first.spec)
    vi.mocked(s.deps.run).mockImplementation(async (_input, args) => args[0] === '--version'
      ? PINNED : JSON.stringify({ models: [model(), model('another')] }))
    s.plan.spec.env.CODEX_CONFIG = JSON.stringify({ model: 'another', developer_instructions: 'Keep my instructions' })
    const changed = await s.prepare()
    expect(changed.spec.key).not.toBe(first.spec.key)
    expect(changed.spec.env.CODEX_PATH).not.toBe(first.spec.env.CODEX_PATH)
    expect(await readFile(first.spec.env.CODEX_PATH, 'utf8')).toBe(firstBytes)
  })

  it.each(['effective', 'default'])('resolves a missing model using the CLI %s selection without guessing', async (kind) => {
    const s = await subject()
    s.plan.spec.env.CODEX_CONFIG = '{"developer_instructions":"Function prompt"}'
    vi.mocked(s.deps.discover).mockResolvedValue({ model: kind === 'effective' ? 'verified-model' : null, mcpNames: [], defaultModel: kind === 'default' ? 'verified-model' : null })
    expect(JSON.parse((await s.prepare()).spec.env.CODEX_CONFIG).model).toBe('verified-model')
    expect(s.deps.discover).toHaveBeenCalledWith(expect.anything(), true)
  })

  it.each(['version', 'model', 'catalog', 'adapter', 'windows', 'cinna-stdio'])('fails closed on an unsupported %s without generating artifacts', async (kind) => {
    const s = await subject()
    if (kind === 'version') vi.mocked(s.deps.run).mockResolvedValue('codex-cli 99.0.0')
    if (kind === 'model') s.plan.spec.env.CODEX_CONFIG = '{"model":"unknown"}'
    if (kind === 'catalog') vi.mocked(s.deps.run).mockImplementation(async (_input, args) => args[0] === '--version' ? PINNED : '{"models":[{"slug":"verified-model"}]}')
    if (kind === 'adapter') vi.mocked(s.deps.adapterDigest).mockResolvedValue('unpatched')
    if (kind === 'windows') s.deps.platform = 'win32'
    if (kind === 'cinna-stdio') vi.mocked(s.deps.discover).mockResolvedValue({ model: null, mcpNames: ['cinna'], defaultModel: null, cinnaStdio: true })
    await expect(s.prepare()).rejects.toThrow('Codex cannot enforce the chat tool policy')
    await expect(stat(s.configuration)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('bounds a stalled inspection and cancels before probing', async () => {
    const s = await subject()
    vi.mocked(s.deps.run).mockImplementation(() => new Promise(() => {}))
    await expect(prepareCodexConductorPolicy(s.plan, s.configuration, { deps: s.deps, timeoutMs: 20 })).rejects.toThrow('timed out')
    vi.mocked(s.deps.run).mockClear()
    const controller = new AbortController(); controller.abort()
    await expect(prepareCodexConductorPolicy(s.plan, s.configuration, { deps: s.deps, signal: controller.signal })).rejects.toThrow('canceled')
    expect(s.deps.run).not.toHaveBeenCalled()
  })

  it('never exposes a config-reader error containing a credential', async () => {
    const s = await subject()
    vi.mocked(s.deps.discover).mockRejectedValue(new Error('secret-fixture-token'))
    await expect(s.prepare()).rejects.toThrow('policy inspection failed')
  })

  it('discovers effective MCP names and the default model over the actual bounded app-server protocol without prompting', async () => {
    const s = await subject()
    const requests = join(s.root, 'requests.jsonl')
    const program = join(s.root, 'fixture.cjs')
    await writeFile(program, `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') console.log(${JSON.stringify(PINNED)});
else if (args[0] === 'debug') console.log(${JSON.stringify(JSON.stringify({ models: [model()] }))});
else {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    fs.appendFileSync(${JSON.stringify(requests)}, line + '\\n');
    if (!request.id) return;
    const result = request.method === 'config/read'
      ? { config: { model: null, mcp_servers: { personal: { command: 'private-command' } }, secret: 'private-secret' } }
      : request.method === 'model/list' ? { data: [{ id: 'verified-model', isDefault: true }] } : {};
    process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
  });
}
`)
    await writeFile(s.plan.spec.env.CODEX_PATH, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)} "$@"\n`, { mode: 0o700 })
    s.plan.spec.env.CODEX_CONFIG = '{"developer_instructions":"Function prompt"}'
    const prepared = await prepareCodexConductorPolicy(s.plan, s.configuration, {
      deps: { adapterDigest: s.deps.adapterDigest }, timeoutMs: 5_000
    })
    const messages = (await readFile(requests, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(messages.map((message) => message.method)).toEqual(['initialize', 'initialized', 'config/read', 'model/list'])
    expect(messages[2].params).toEqual({ includeLayers: false, cwd: s.root })
    expect(JSON.parse(prepared.spec.env.CODEX_CONFIG)).toMatchObject({ model: 'verified-model', mcp_servers: { personal: { enabled: false } } })
    expect(prepared.spec.env.CODEX_CONFIG).not.toMatch(/private-command|private-secret/)
    expect(await readdir(s.personal)).toEqual(['auth.json', 'config.toml'])
  })

  it('kills a stalled configuration child when the caller cancels', async () => {
    const s = await subject()
    const pidPath = join(s.root, 'reader.pid')
    const program = join(s.root, 'stalled.cjs')
    await writeFile(program, `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`)
    await writeFile(s.plan.spec.env.CODEX_PATH, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)} "$@"\n`, { mode: 0o700 })
    const controller = new AbortController()
    const pending = prepareCodexConductorPolicy(s.plan, s.configuration, {
      deps: { adapterDigest: s.deps.adapterDigest, run: s.deps.run }, signal: controller.signal, timeoutMs: 5_000
    })
    const rejected = expect(pending).rejects.toThrow('canceled')
    let pid = 0
    await vi.waitFor(async () => { pid = Number(await readFile(pidPath, 'utf8')); expect(pid).toBeGreaterThan(0) })
    controller.abort()
    await rejected
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
    await expect(stat(s.configuration)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
