import { createServer, request as httpRequest, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { LIVE_ENGINE, expectNoAgentTurn, liveEngineOptions, requireLiveEngine } from '../fixtures/liveEngine'
import { coreApi } from '../fixtures/liveCinnaLink'
import { signIn, type LiveCinnaConfig } from '../fixtures/liveCinna'
import {
  arrangeAgent, askAgent, coreDirectory, findFiles, liveSession, manifestOf, openAddons, picker, type DirectoryEntry
} from '../fixtures/livePlugins'

/**
 * @live — **the core admin's addon controls (core K5) reach Cinna Desktop,
 * against the developer's real local cinna-core.** The e2e account is the
 * core's first superuser, so the spec is the admin over the API and the user
 * in the app.
 *
 * - **A1 a banned plugin.** `playground` is pinned, then banned on core
 *   (`PUT /llm-plugins/plugins/{id}/access`). The row reads "No longer
 *   available to you" and offers no Update; Update and a second Add are
 *   refused in main ("This plugin is no longer in a marketplace you can
 *   see."); the picker no longer lists it; and one turn still answers from
 *   the cached SKILL.md. Any engine.
 * - **A2 an allowlisted marketplace.** The `skills` marketplace goes to
 *   `allowlist` with only `pdf` allowed: the picker's `pdf` search keeps the
 *   `pdf` skill and the plugins of the other marketplace, and `docx` is gone.
 * - **F1 the policy flags**, one at a time, each read by the app when the
 *   picker opens: `addons_external_directories` off → no public registry
 *   section, Settings → MCP drops Add from Registry for one muted "Turned off
 *   by your admin" line; `addons_custom_mcp` off → no Custom connector…, a
 *   connector of the user's own is refused; `addons_stdio_mcp` off →
 *   desktop-commander's running Node server is disconnected (policyFollow)
 *   while a hand-made local connector keeps running, and a directory stdio
 *   connector is refused. **Then core goes away**: the profile was linked
 *   through a loopback forwarder, which is closed, the flags are put back on
 *   core, and the app restarts — the stored policy still applies.
 * - **H1 plugin hooks** (Claude): a chat is given
 *   `explanatory-output-style`'s SessionStart context; with
 *   `addons_plugin_hooks` off the Hooks switch reads "Blocked by your admin",
 *   the next session's wrapper has no hooks link and a new chat answers NONE.
 *
 * ## Shared state on core
 *
 * Every change is recorded first (the flag's, mode's or entry access's value
 * before) and put back in `afterEach`, which also runs after a failure, then
 * read back and compared. Nothing is synced, edited or deleted.
 *
 * ## Cost
 *
 * A1 one short turn, H1 two (Claude). A2 and F1 run no turn and run with the
 * OpenCode and Claude passes:
 * `make e2e-one SPEC=e2e/specs/live-addon-admin.spec.ts LIVE_ENGINE=opencode`,
 * and `CINNA_E2E_CLAUDE_AUTH=api_key … LIVE_ENGINE=claude` for H1.
 *
 * ## What it does not prove
 *
 * The admin UI on core (the API is driven directly); a ban seen by a
 * non-superuser account; a policy change noticed without a directory read
 * (the app reads the policy only with the directory); a skill (rather than a
 * plugin) banned; hooks blocked on an engine other than Claude.
 */

test.use(liveEngineOptions())
test.beforeEach(() => requireLiveEngine())

const PLAYGROUND = 'playground'
/** In its SKILL.md: "`templates/document-critique.md` — Document review". */
const PLAYGROUND_FACT = 'document-critique.md'
const COMMANDER = 'desktop-commander'
const STYLE = 'explanatory-output-style'
const STYLE_MODE = 'explanatory'
const SKILLS_MARKETPLACE = 'skills'

const NOT_VISIBLE = 'This plugin is no longer in a marketplace you can see.'
const CUSTOM_REFUSED = 'Your admin does not allow adding your own connectors.'
const STDIO_REFUSED = 'Your admin does not allow adding local MCP servers.'
const ADMIN_OFF = 'Turned off by your admin'

/* ------------------------------------------------------- core admin, restored */

type Flag = 'addons_external_directories' | 'addons_custom_mcp' | 'addons_plugin_hooks' | 'addons_stdio_mcp'
const FLAGS: readonly Flag[] = ['addons_external_directories', 'addons_custom_mcp', 'addons_plugin_hooks', 'addons_stdio_mcp']

/** What this test changed on core, as it was before: put back by {@link restoreCore}. */
const before = {
  config: null as LiveCinnaConfig | null,
  flags: new Map<Flag, boolean>(),
  modes: new Map<string, string>(),
  /** plugin row id → { marketplace id, access before } */
  access: new Map<string, { marketplaceId: string; access: string }>()
}

async function adminCall(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const config = before.config
  if (!config) throw new Error('no core configured for the admin calls')
  return coreApi(config, await signIn(config), path, init)
}

async function readFlags(): Promise<Record<Flag, boolean>> {
  const read = await adminCall('/admin/server-config')
  expect(read.status, 'core serves /admin/server-config to the superuser').toBe(200)
  return Object.fromEntries(FLAGS.map((flag) => [flag, read.body[flag]])) as Record<Flag, boolean>
}

async function setFlags(config: LiveCinnaConfig, flags: Partial<Record<Flag, boolean>>): Promise<void> {
  before.config = config
  const current = await readFlags()
  for (const flag of Object.keys(flags) as Flag[]) if (!before.flags.has(flag)) before.flags.set(flag, current[flag])
  const put = await adminCall('/admin/server-config', { method: 'PUT', body: flags })
  expect(put.status, `PUT server-config ${JSON.stringify(flags)}`).toBe(200)
  for (const [flag, value] of Object.entries(flags)) expect(put.body[flag]).toBe(value)
}

async function marketplaces(): Promise<Array<{ id: string; name: string; access_mode: string }>> {
  const read = await adminCall('/llm-plugins/marketplaces')
  expect(read.status).toBe(200)
  return (read.body.data ?? read.body) as Array<{ id: string; name: string; access_mode: string }>
}

/** One marketplace entry as the admin sees it, by exact name. */
async function adminEntry(marketplaceId: string, name: string): Promise<{ id: string; name: string; access: string }> {
  const read = await adminCall(`/llm-plugins/marketplaces/${marketplaceId}/entries?limit=100&search=${encodeURIComponent(name)}`)
  expect(read.status).toBe(200)
  const row = (read.body.data as Array<{ id: string; name: string; access: string }>).find((entry) => entry.name === name)
  expect(row, `the marketplace lists ${name}`).toBeTruthy()
  return row!
}

async function setEntryAccess(config: LiveCinnaConfig, marketplaceId: string, name: string, access: 'default' | 'allowed' | 'banned'): Promise<string> {
  before.config = config
  const entry = await adminEntry(marketplaceId, name)
  if (!before.access.has(entry.id)) before.access.set(entry.id, { marketplaceId, access: entry.access })
  const put = await adminCall(`/llm-plugins/plugins/${entry.id}/access`, { method: 'PUT', body: { access, reason: 'cinna-desktop e2e live-addon-admin' } })
  expect(put.status, `PUT access ${access} on ${name}`).toBe(200)
  return entry.id
}

async function setAccessMode(config: LiveCinnaConfig, marketplaceId: string, mode: 'allow_all' | 'allowlist'): Promise<void> {
  before.config = config
  const current = (await marketplaces()).find((row) => row.id === marketplaceId)
  if (!before.modes.has(marketplaceId)) before.modes.set(marketplaceId, current!.access_mode)
  const put = await adminCall(`/llm-plugins/marketplaces/${marketplaceId}/access-mode`, { method: 'PUT', body: { access_mode: mode, dry_run: false } })
  expect(put.status, `PUT access-mode ${mode}`).toBe(200)
  expect(put.body).toMatchObject({ access_mode: mode, applied: true })
}

/** Put back every recorded value, then read each back; throws when core does not hold them. */
async function restoreCore(): Promise<string | null> {
  if (!before.config) return null
  const problems: string[] = []
  const attempt = async (what: string, call: () => Promise<{ status: number }>): Promise<void> => {
    try {
      const answer = await call()
      if (answer.status !== 200) problems.push(`${what}: HTTP ${answer.status}`)
    } catch (error) {
      problems.push(`${what}: ${String(error)}`)
    }
  }
  for (const [id, mode] of before.modes) {
    await attempt(`mode ${id}`, () => adminCall(`/llm-plugins/marketplaces/${id}/access-mode`, { method: 'PUT', body: { access_mode: mode, dry_run: false } }))
  }
  for (const [id, { access }] of before.access) {
    await attempt(`access ${id}`, () => adminCall(`/llm-plugins/plugins/${id}/access`, { method: 'PUT', body: { access } }))
  }
  if (before.flags.size > 0) await attempt('flags', () => adminCall('/admin/server-config', { method: 'PUT', body: Object.fromEntries(before.flags) }))

  // Read back.
  const flags = await readFlags()
  for (const [flag, value] of before.flags) if (flags[flag] !== value) problems.push(`${flag} is ${flags[flag]}, was ${value}`)
  const modes = await marketplaces()
  for (const [id, mode] of before.modes) {
    const now = modes.find((row) => row.id === id)?.access_mode
    if (now !== mode) problems.push(`marketplace ${id} is ${now}, was ${mode}`)
  }
  for (const [id, { marketplaceId, access }] of before.access) {
    const rows = await adminCall(`/llm-plugins/marketplaces/${marketplaceId}/entries?limit=500&access=${access}`)
    if (!(rows.body?.data as Array<{ id: string }> | undefined)?.some((row) => row.id === id)) problems.push(`entry ${id} is not back to ${access}`)
  }
  const summary = `flags ${JSON.stringify(Object.fromEntries(before.flags))}, modes ${JSON.stringify(Object.fromEntries(before.modes))}, ` +
    `access ${JSON.stringify([...before.access].map(([id, { access }]) => [id, access]))}`
  if (problems.length > 0) return `core NOT restored (${summary}): ${problems.join('; ')}`
  console.log(`live-addon-admin restored and read back: ${summary}`)
  before.flags.clear()
  before.modes.clear()
  before.access.clear()
  return null
}

test.afterEach(async () => {
  const problem = await restoreCore()
  if (problem) throw new Error(problem)
})

/* -------------------------------------------------------------- app helpers */

/** Opens the picker (which re-reads core's directory and so its policy), waits for main to hold `expected`, closes it. */
async function readPolicyThroughPicker(cinna: CinnaApp, section: Locator, expected: Record<string, boolean>): Promise<void> {
  const { dialog } = picker(cinna)
  await section.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toBeVisible()
  await expect.poll(() => cinna.page.evaluate(() => window.api.addons.policy()), { message: 'main stores the policy core now sends', timeout: 30_000 })
    .toMatchObject(expected)
}

async function closePicker(cinna: CinnaApp): Promise<void> {
  const { dialog } = picker(cinna)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

/** Leave Settings for the chat shell (the user menu's Settings item toggles); copied from `agent-addons.spec.ts`. */
async function leaveSettings(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('button', { name: 'MCP Providers', exact: true })).toHaveCount(0)
}

/** The agent's Addons section, from wherever the window is (Settings is left first). */
async function addonsTab(cinna: CinnaApp): Promise<Locator> {
  if (await cinna.page.getByRole('button', { name: 'MCP Providers', exact: true }).isVisible()) await leaveSettings(cinna)
  return openAddons(cinna)
}

async function openMcpSettings(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  const nav = page.getByRole('button', { name: 'MCP Providers', exact: true })
  if (!(await nav.isVisible())) {
    const user = await page.evaluate(() => window.api.auth.getCurrent())
    await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
  }
  await nav.click()
  await expect(page.getByRole('heading', { name: 'MCP Providers', exact: true })).toBeVisible()
}

async function directoryPlugin(name: string): Promise<{ config: LiveCinnaConfig; token: string; entry: DirectoryEntry }> {
  const { config, token } = await liveSession()
  const entry = (await coreDirectory(config, token)).find((row) => row.kind === 'plugin' && row.name === name)
  test.skip(!entry, `core lists no ${name} plugin`)
  return { config, token, entry: entry as DirectoryEntry }
}

/** The app's ref for a core plugin entry (main files plugins under their own source, not core's `core-marketplace`). */
async function appRef(cinna: CinnaApp, agentId: string, entry: DirectoryEntry): Promise<{ source: string; id: string }> {
  const listed = await cinna.page.evaluate((id) => window.api.addons.directory(id, { refresh: true }), agentId)
  const row = listed.ok ? listed.entries.find((candidate) => candidate.kind === 'plugin' && candidate.ref.id === entry.ref.id) : undefined
  expect(row, `the app's directory lists ${entry.name}`).toBeTruthy()
  return { source: row!.ref.source, id: row!.ref.id }
}

/** Pins `entry` over IPC with the picker's Add path, and checks the pin. */
async function pinPlugin(cinna: CinnaApp, agent: { id: string; path: string }, entry: DirectoryEntry): Promise<void> {
  const ref = await appRef(cinna, agent.id, entry)
  const added = await cinna.page.evaluate(({ agentId, ref }) => window.api.addons.add(agentId, ref), { agentId: agent.id, ref })
  expect(added, `${entry.name} is added: ${JSON.stringify(added)}`).toMatchObject({ ok: true })
  const pins = (manifestOf(agent.path).marketplace_plugins ?? []) as Array<Record<string, unknown>>
  expect(pins.map((pin) => pin.name)).toContain(entry.name)
}

/** `<userData>/cinna-plugins/agents/<key>-plugins/<plugin>`: the Claude wrapper (`agentPluginWrappers.ts`). */
function wrapperDir(cinna: CinnaApp, agentId: string, plugin: string): string {
  return join(cinna.sandbox.userData, 'cinna-plugins', 'agents', `${createHash('sha256').update(agentId).digest('hex').slice(0, 16)}-plugins`, plugin)
}

async function providerState(cinna: CinnaApp, id: string): Promise<{ status?: string; error?: string | null } | undefined> {
  return cinna.page.evaluate(async (pid) => {
    const row = (await window.api.mcp.list()).find((p) => p.id === pid)
    return row ? { status: row.status, error: row.error ?? null } : undefined
  }, id)
}

/**
 * A loopback forwarder to core: the profile is linked through it, so closing
 * it makes core unreachable while the account (`<profile>@<origin>`), and so
 * its stored policy, stays the same.
 */
async function coreForwarder(target: string): Promise<{ url: string; close(): Promise<void> }> {
  const upstream = new URL(target)
  const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest
  const server: Server = createServer((req, res) => {
    const out = send(
      { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: { ...req.headers, host: upstream.host } },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(res)
      }
    )
    out.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(out)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  let closed = false
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      if (closed) return
      closed = true
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

/** A stdio MCP server with no dependencies (newline-delimited JSON-RPC, one tool): the user's own local connector. */
const HAND_MADE_MJS = `
import { createInterface } from 'node:readline'
const common = { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const rpc = JSON.parse(line)
  if (rpc.id === undefined) return
  if (rpc.method === 'initialize') return reply(rpc.id, { protocolVersion: rpc.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hand-made', version: '1.0.0' } })
  if (rpc.method === 'server/discover') return reply(rpc.id, { ...common, supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, serverInfo: { name: 'hand-made', version: '1.0.0' } })
  if (rpc.method === 'tools/list') return reply(rpc.id, { ...common, tools: [{ name: 'note_count', description: 'How many notes.', inputSchema: { type: 'object', properties: {} } }] })
  if (rpc.method === 'tools/call') return reply(rpc.id, { resultType: 'complete', content: [{ type: 'text', text: '3' }] })
  reply(rpc.id, {})
})
`

/* ---------------------------------------------------------------------- A1 */

test('@live A1 a pinned plugin the admin bans reads No longer available to you, refuses Update and re-add, and still works from cache', async ({ cinna }) => {
  test.setTimeout(8 * 60_000)
  const { config, token, entry } = await directoryPlugin(PLAYGROUND)
  const official = (await coreApi(config, token, '/llm-plugins/marketplaces')).body
  const marketplaceId = ((official.data ?? official) as Array<{ id: string; name: string }>).find((row) => row.name === 'claude-plugins-official')?.id
  test.skip(!marketplaceId, 'core has no claude-plugins-official marketplace')

  const agent = await arrangeAgent(cinna, config, token)
  const pluginRef = await appRef(cinna, agent.id, entry)
  await pinPlugin(cinna, agent, entry)
  expect(findFiles(join(cinna.sandbox.userData, 'marketplace-plugins'), join(PLAYGROUND, 'SKILL.md')), 'the snapshot is cached').toHaveLength(1)

  const section = await addonsTab(cinna)
  const row = section.locator(`[data-plugin-row="${PLAYGROUND}"]`)
  await test.step('before the ban, the row has no availability issue', async () => {
    await expect(row.locator('[data-plugin-summary]')).toHaveText('1 skill')
    await expect(row.getByText('No longer available to you', { exact: true })).toHaveCount(0)
  })

  await setEntryAccess(config, marketplaceId!, PLAYGROUND, 'banned')

  await test.step('the admin bans it: the row reads No longer available to you, with no Update', async () => {
    const reopened = await addonsTab(cinna)
    const banned = reopened.locator(`[data-plugin-row="${PLAYGROUND}"]`)
    await expect(banned.getByText('No longer available to you', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(banned.getByRole('button', { name: new RegExp(`^Update ${PLAYGROUND}`) })).toHaveCount(0)
    const status = await cinna.page.evaluate((agentId) => window.api.addons.pluginStatus(agentId), agent.id)
    expect(status.ok && status.plugins.map((plugin) => [plugin.name, plugin.availability, plugin.cache])).toEqual([[PLAYGROUND, 'unavailable', 'ready']])
  })

  await test.step('Update and a second Add are refused in main', async () => {
    const update = await cinna.page.evaluate((agentId) => window.api.addons.updatePlugin(agentId, 'playground'), agent.id)
    expect(update).toMatchObject({ ok: false, message: NOT_VISIBLE })
    const again = await cinna.page.evaluate(({ agentId, ref }) => window.api.addons.add(agentId, ref), { agentId: agent.id, ref: pluginRef })
    expect(again).toMatchObject({ ok: false, code: 'not_found', message: NOT_VISIBLE })
    // The pin and its cached copy stay.
    expect(((manifestOf(agent.path).marketplace_plugins ?? []) as Array<{ name: string }>).map((pin) => pin.name)).toEqual([PLAYGROUND])
  })

  await test.step('the picker no longer lists it', async () => {
    const reopened = await addonsTab(cinna)
    const { dialog, search, tile } = picker(cinna)
    await reopened.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(dialog).toBeVisible()
    // A plugin core still lists for "pdf" shows the directory has answered.
    await search.fill('pdf')
    await expect(tile('carbone-skill')).toBeVisible({ timeout: 30_000 })
    await search.fill(PLAYGROUND)
    await expect(dialog.locator(`[data-addon-results] [data-addon-tile="${pluginRef.source}:${pluginRef.id}"]`)).toHaveCount(0)
    await expect(tile(PLAYGROUND)).toHaveCount(0)
    await closePicker(cinna)
  })

  await test.step('a turn still answers from the cached SKILL.md', async () => {
    const prompt = 'Use your playground skill: which template file does it tell you to load for a document review playground? Reply with only the file name.'
    expect(prompt).not.toContain(PLAYGROUND_FACT)
    const { turn } = await askAgent(cinna, agent.path, prompt)
    expect(turn.errors).toEqual([])
    expect(turn.reply).toContain(PLAYGROUND_FACT)
  })
})

/* ---------------------------------------------------------------------- A2 */

test('@live A2 a marketplace set to allowlist leaves only its allowed entries in the picker', async ({ cinna }) => {
  test.skip(!['claude', 'opencode'].includes(LIVE_ENGINE.name), 'A2 runs no turn; it runs with the Claude and OpenCode passes')
  test.setTimeout(5 * 60_000)
  expectNoAgentTurn()
  const { config, token } = await liveSession()
  const listed = (await coreApi(config, token, '/llm-plugins/marketplaces')).body
  const skills = ((listed.data ?? listed) as Array<{ id: string; name: string }>).find((row) => row.name === SKILLS_MARKETPLACE)
  test.skip(!skills, `core has no ${SKILLS_MARKETPLACE} marketplace`)

  await arrangeAgent(cinna, config, token)
  const section = await addonsTab(cinna)
  const { dialog, search, tile } = picker(cinna)

  await test.step('before: "pdf" lists the pdf and docx skills', async () => {
    await section.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(dialog).toBeVisible()
    await search.fill('pdf')
    for (const name of ['pdf', 'docx', 'carbone-skill']) await expect(tile(name), `${name} is listed`).toBeVisible({ timeout: 30_000 })
    await closePicker(cinna)
  })

  await setEntryAccess(config, skills!.id, 'pdf', 'allowed')
  await setAccessMode(config, skills!.id, 'allowlist')

  await test.step('after: the picker keeps pdf and the other marketplace’s plugins, and docx is gone', async () => {
    await section.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(dialog).toBeVisible()
    await search.fill('pdf')
    await expect(tile('docx'), 'docx is not allowed in the allowlist marketplace').toHaveCount(0, { timeout: 30_000 })
    await expect(tile('pdf')).toBeVisible()
    await expect(tile('pdf').locator('[data-addon-kind]')).toHaveText('Skill')
    await expect(tile('carbone-skill'), 'another marketplace is untouched').toBeVisible()
    // Another unallowed skill: carbone-skill (whose description names XLSX) answers the search, the xlsx skill does not.
    await search.fill('xlsx')
    await expect(tile('carbone-skill')).toBeVisible()
    await expect(tile('xlsx')).toHaveCount(0)
    await closePicker(cinna)
  })
})

/* ---------------------------------------------------------------------- F1 */

test('@live F1 each policy flag takes its option away, stops the plugin’s local server, and still applies after a restart with core unreachable', async ({ cinna }) => {
  test.skip(!['claude', 'opencode'].includes(LIVE_ENGINE.name), 'F1 runs no turn; it runs with the Claude and OpenCode passes')
  test.setTimeout(12 * 60_000)
  expectNoAgentTurn()
  const { config, token, entry: commander } = await directoryPlugin(COMMANDER)
  const forwarder = await coreForwarder(config.serverUrl)
  try {
    const agent = await arrangeAgent(cinna, { ...config, serverUrl: forwarder.url }, token)
    const page = cinna.page

    // The user's own local connector, made before any flag changes.
    mkdirSync(join(cinna.sandbox.root, 'hand-made'), { recursive: true })
    const script = join(cinna.sandbox.root, 'hand-made', 'server.mjs')
    writeFileSync(script, HAND_MADE_MJS)
    const handMade = await page.evaluate((args) => window.api.mcp.upsert({ name: 'hand-made-notes', transportType: 'stdio', command: 'node', args, enabled: true }), [script])
    expect(handMade).toMatchObject({ success: true })
    await expect.poll(async () => (await providerState(cinna, handMade.id))?.status, { message: 'the hand-made connector connects', timeout: 60_000 }).toBe('connected')

    let managedId = ''
    await test.step(`${COMMANDER} is added and its Node server runs`, async () => {
      await pinPlugin(cinna, agent, commander)
      const managed = (await page.evaluate(() => window.api.mcp.list())).filter((p) => (p.managedBy ?? '').startsWith(`plugin:${commander.ref.id}@`))
      expect(managed).toHaveLength(1)
      managedId = managed[0].id
      await expect.poll(async () => (await providerState(cinna, managedId))?.status, { message: 'the plugin’s server connects (a cold npx -y)', timeout: 180_000, intervals: [2000] })
        .toBe('connected')
    })

    let section = await addonsTab(cinna)
    const { dialog, search } = picker(cinna)
    const registry = dialog.locator('[data-addon-registry]')

    await test.step('before: the registry section, Custom connector… and every Settings → MCP button are offered', async () => {
      await section.getByRole('button', { name: 'Add', exact: true }).click()
      await search.fill('notes')
      await expect(registry).toBeVisible({ timeout: 30_000 })
      await expect(dialog.getByRole('button', { name: 'Custom connector…', exact: true })).toBeVisible()
      await closePicker(cinna)
      await openMcpSettings(cinna)
      for (const name of ['Add from Registry', 'Add Custom MCP', 'Add Local MCP']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
      await expect(page.getByTestId('mcp-add-off')).toHaveCount(0)
    })

    await setFlags(config, { addons_external_directories: false })
    await test.step('external directories off: no public registry in the picker, Add from Registry turned off in Settings → MCP', async () => {
      section = await addonsTab(cinna)
      await readPolicyThroughPicker(cinna, section, { externalDirectories: false, customMcp: true, stdioMcp: true })
      await search.fill('notes')
      // Core's own entries still answer; the public registry is neither listed nor searched.
      await expect(dialog.locator('[data-addon-results]')).toBeVisible()
      await expect(registry).toHaveCount(0)
      await expect(dialog.getByRole('button', { name: 'Custom connector…', exact: true })).toBeVisible()
      await closePicker(cinna)
      await openMcpSettings(cinna)
      await expect(page.getByTestId('mcp-add-off')).toHaveText(`${ADMIN_OFF}: Add from Registry`)
      await expect(page.getByRole('button', { name: 'Add from Registry', exact: true })).toHaveCount(0)
      for (const name of ['Add Custom MCP', 'Add Local MCP']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
    })

    await setFlags(config, { addons_custom_mcp: false })
    await test.step('custom connectors off: no Custom connector…, and a connector of the user’s own is refused', async () => {
      section = await addonsTab(cinna)
      await readPolicyThroughPicker(cinna, section, { externalDirectories: false, customMcp: false, stdioMcp: true })
      await expect(dialog.getByRole('button', { name: 'Custom connector…', exact: true })).toHaveCount(0)
      await closePicker(cinna)
      const refused = await page.evaluate(() => window.api.mcp.upsert({ name: 'my-own', transportType: 'streamable-http', url: 'https://example.invalid/mcp', enabled: false }))
      expect(refused).toMatchObject({ ok: false, code: 'policy', message: CUSTOM_REFUSED })
      expect((await page.evaluate(() => window.api.mcp.list())).map((p) => p.name)).not.toContain('my-own')
      await openMcpSettings(cinna)
      await expect(page.getByTestId('mcp-add-off')).toHaveText(`${ADMIN_OFF}: Add from Registry, Add Custom MCP, Add Local MCP`)
      for (const name of ['Add from Registry', 'Add Custom MCP', 'Add Local MCP']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0)
    })

    await setFlags(config, { addons_stdio_mcp: false })
    await test.step('local servers off: the plugin’s running server is stopped, the hand-made one keeps running', async () => {
      section = await addonsTab(cinna)
      await readPolicyThroughPicker(cinna, section, { externalDirectories: false, customMcp: false, stdioMcp: false })
      await closePicker(cinna)
      await expect.poll(async () => (await providerState(cinna, managedId))?.status, { message: `${COMMANDER}'s server is disconnected`, timeout: 30_000 })
        .not.toBe('connected')
      expect((await providerState(cinna, handMade.id))?.status, 'the hand-made local connector keeps running').toBe('connected')
      // Nothing is deleted: the managed row and the pin stay.
      expect(await providerState(cinna, managedId)).toBeTruthy()
      section = await addonsTab(cinna)
      await expect(section.locator(`[data-plugin-row="${COMMANDER}"]`).getByText(`${COMMANDER}: blocked by your admin`, { exact: true })).toBeVisible({ timeout: 30_000 })
      const directoryStdio = await page.evaluate(() => window.api.mcp.upsert({
        name: 'directory-local', transportType: 'stdio', command: 'npx', args: ['-y', 'some-server@1.0.0'], enabled: false,
        registryRef: { source: 'core-mcp-directory', id: '00000000-0000-0000-0000-000000000000' }
      }))
      expect(directoryStdio, 'a new local server from a directory is refused').toMatchObject({ ok: false, code: 'policy', message: STDIO_REFUSED })
    })

    await test.step('core unreachable, flags back on core, restart: the stored policy still applies', async () => {
      // Core itself now allows everything again; only the app's stored copy says otherwise.
      const problem = await restoreCore()
      if (problem) throw new Error(problem)
      await forwarder.close()
      await cinna.relaunch()
      await cinna.skipOnboarding()
      await cinna.page.evaluate(() => window.api.localAgents.rescan())
      expect(await cinna.page.evaluate(() => window.api.addons.policy())).toEqual({ externalDirectories: false, customMcp: false, pluginHooks: true, stdioMcp: false })
      await openMcpSettings(cinna)
      await expect(cinna.page.getByTestId('mcp-add-off')).toHaveText(`${ADMIN_OFF}: Add from Registry, Add Custom MCP, Add Local MCP`)
      const refused = await cinna.page.evaluate(() => window.api.mcp.upsert({ name: 'my-own', transportType: 'streamable-http', url: 'https://example.invalid/mcp', enabled: false }))
      expect(refused).toMatchObject({ ok: false, code: 'policy', message: CUSTOM_REFUSED })
      await expect.poll(async () => (await providerState(cinna, handMade.id))?.status, { message: 'the hand-made connector starts with the app', timeout: 60_000 }).toBe('connected')
      const managed = await providerState(cinna, managedId)
      console.log(`live-addon-admin F1 managed after restart: ${JSON.stringify(managed)}`)
      expect(managed?.status).not.toBe('connected')
      const tab = await addonsTab(cinna)
      await expect(tab.locator(`[data-plugin-row="${COMMANDER}"]`).getByText(`${COMMANDER}: blocked by your admin`, { exact: true })).toBeVisible({ timeout: 30_000 })
    })
  } finally {
    await forwarder.close()
  }
})

/* ---------------------------------------------------------------------- H1 */

test('@live H1 with plugin hooks turned off by the admin, the Hooks switch reads Blocked by your admin and the next session runs no hook', async ({ cinna }) => {
  test.skip(LIVE_ENGINE.name !== 'claude', 'hooks are delivered to Claude only')
  test.setTimeout(10 * 60_000)
  const { config, token, entry } = await directoryPlugin(STYLE)
  const agent = await arrangeAgent(cinna, config, token)
  await pinPlugin(cinna, agent, entry)

  const question = (n: number): string =>
    `(${n}) Does any context you were given at session start (for example from a hook) say you are in a particular output style mode? ` +
    'If it does, reply with only the name of that mode, one word, as written there. If it does not, reply with only NONE. Do not run any tool.'
  expect(question(1).toLowerCase()).not.toContain(STYLE_MODE)

  await test.step('control: with hooks allowed, a chat is given the hook’s context', async () => {
    const { turn } = await askAgent(cinna, agent.path, question(1))
    expect(turn.errors).toEqual([])
    expect(lstatSync(join(wrapperDir(cinna, agent.id, STYLE), 'hooks')).isSymbolicLink()).toBe(true)
    expect(turn.reply.toLowerCase()).toContain(STYLE_MODE)
  })

  await setFlags(config, { addons_plugin_hooks: false })

  await test.step('the Hooks switch reads Blocked by your admin', async () => {
    let section = await addonsTab(cinna)
    await readPolicyThroughPicker(cinna, section, { pluginHooks: false })
    await closePicker(cinna)
    section = await addonsTab(cinna)
    const row = section.locator(`[data-plugin-row="${STYLE}"]`)
    await row.getByRole('button', { expanded: false }).click()
    const hooks = row.locator(`section[aria-label="Hooks of ${STYLE}"]`)
    const toggle = hooks.getByRole('switch', { name: 'Hooks', exact: true })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(toggle).toBeDisabled()
    await expect(toggle).toHaveAttribute('title', 'Blocked by your admin')
    await expect(hooks.getByText('Blocked by your admin', { exact: true })).toBeVisible()
    // The user's own switch is untouched: only the admin's policy holds it off.
    expect((manifestOf(agent.path).marketplace_plugins as Array<{ disabled?: unknown }>)[0].disabled ?? null).toBeNull()
  })

  await test.step('the next session has no hooks link and no hook context', async () => {
    const { turn } = await askAgent(cinna, agent.path, question(2))
    expect(turn.errors).toEqual([])
    expect(existsSync(join(wrapperDir(cinna, agent.id, STYLE), 'hooks')), 'the wrapper links no hooks/').toBe(false)
    expect(turn.reply.toLowerCase()).not.toContain(STYLE_MODE)
    expect(turn.reply.trim()).toMatch(/^NONE\.?$/)
  })
})
