import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomBytes, randomInt } from 'node:crypto'
import type { Locator } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { LIVE_ENGINE, expectNoAgentTurn, liveEngineOptions, requireLiveEngine } from '../fixtures/liveEngine'
import { coreApi } from '../fixtures/liveCinnaLink'
import { signIn, type LiveCinnaConfig } from '../fixtures/liveCinna'
import {
  AGENT, ENGINE_LABEL, ENGINE_ORDER, arrangeAgent, askAgent, coreDirectory, findFiles, liveSession, manifestOf, openAddons, openTile, picker, toolText,
  type DirectoryEntry
} from '../fixtures/livePlugins'

/**
 * @live — **the unified addons story against the developer's real
 * cinna-core.** A kit folder agent on a profile linked to the local core
 * opens Addons → Add, and the one picker lists skills and plugins from core's
 * `/addons/directory` side by side: `pdf` finds the `pdf` skill and the
 * `carbone-skill` and `desktop-commander` plugins, and `docx`, whose
 * description (not its summary) says PDF: the search reads both.
 * No marketplace on core is synced, edited or deleted; L3 adds its own MCP
 * directory fixtures and deletes them (below).
 *
 * - **L1 `carbone-skill`** (one skill, `carbone`): its `plugin.json` says
 *   `"skills": "./carbone"`, a declared path the desktop reads as core does;
 *   the row reads `1 skill` and the engine is handed it, as L1b proves.
 * - **L1b `playground`** (one skill, in `skills/playground/`). The detail
 *   lists the skill under What it adds and every engine under Works with as
 *   `everything`, the agent's own first; Add pins it, the snapshot is cached,
 *   the tab shows one Plugin row whose open parts list the skill. One real
 *   turn asks which template the skill names for document review
 *   (`document-critique.md`, only in the cached SKILL.md); the reply holds it
 *   and every tool path naming the skill is inside the sandbox. Any engine.
 * - **L2 `desktop-commander`** (a Node stdio MCP server plus six skills).
 *   Add reads `Add — runs code on this computer`; the managed connector is
 *   nested in the row, not a row of its own. Add starts it (a cold `npx -y`
 *   takes a while) and the row then says Connected. One turn lists a folder with the server's
 *   `list_directory`, relayed by Cinna's `cinna` MCP server (its `tool_call`
 *   row: provider `desktop-commander`, answer `[FILE] <name>`, a name no
 *   prompt holds). The connector's switch off → `disabled.mcp_servers`, the
 *   agent holds no connector, and a new chat relays no such call; Remove →
 *   no `marketplace_plugins` entry, no connector on the agent.
 * - **L2c** — after the switch off, Remove deletes the managed row too: it
 *   is gone from Settings → MCP. No turn.
 * - **L3 a no-auth HTTP server from core's MCP directory.** The spec runs a
 *   tiny streamable-HTTP MCP server on 127.0.0.1 over TLS (core takes only
 *   https:// URLs; the app trusts a throwaway CA through
 *   `NODE_EXTRA_CA_CERTS`) and adds it to core's directory as a fixture. Add
 *   reads Ready in the next chat with no setup step, the connector connects
 *   with no credential sent and no browser opened, `mcp_servers[]` gets the
 *   URL with `auth: none`, Detach drops it. No turn.
 * - **L3o an OAuth entry core already lists** (`rovo`, `granola`), added
 *   without signing in: the sign-in step shows, no browser opens, the
 *   requirement is written and Detach drops it. No turn.
 * - **L3b an npm stdio entry** (`@modelcontextprotocol/server-everything@1.0.0`)
 *   and **L3c a PyPI one** (`mcp-server-time==2026.10.19`), each a core
 *   fixture: Add installs and starts it through `npx -y` / the managed `uvx`
 *   in the sandbox, `mcp_servers[]` gets the portable `npx` / `uvx`, and one
 *   turn calls `get-sum` / `get_current_time` through Cinna's `cinna` server;
 *   the relayed answer and the reply carry a value no prompt holds.
 *
 * Core fixtures (L3, L3b, L3c) are created as core's superuser over
 * `/mcp-directory/entries`, each with a unique name and a marker
 * description, and deleted in `afterEach` (which runs after a failure too)
 * only when the id, the exact name and the marker match; the directory is
 * read back to prove them gone.
 *
 * Engine: `CINNA_E2E_LIVE_ENGINE` (`opencode` default, `claude` — with
 * `CINNA_E2E_CLAUDE_AUTH=api_key` for the .env key —, `codex`,
 * `antigravity`). L2, L2c and L3* run with Claude and OpenCode only. Needs
 * `CINNA_E2E_SERVER_URL` / `_EMAIL` / `_PASSWORD`.
 *
 * ## Cost
 *
 * L1b one short turn, L2 two, L3b and L3c one each. Run deliberately:
 * `make e2e-one SPEC=e2e/specs/live-marketplace-plugins.spec.ts LIVE_ENGINE=<engine>`.
 *
 * ## What it does not prove
 *
 * That the agent would pick the skill or the tool unprompted (the prompts
 * name them); a plugin's first chat without the arranged connect; commands,
 * agents, hooks or LSP (neither plugin has any; commands and hooks are
 * `live-plugin-commands-hooks.spec.ts`); Update against a real
 * marketplace sync; an OAuth directory server signed in; an HTTP directory
 * server used in a turn (L3 stops at connected); a stdio entry with env
 * settings, or an OCI (Docker) one.
 */

test.use(liveEngineOptions())
test.beforeEach(() => requireLiveEngine())

const CARBONE = 'carbone-skill'
const CARBONE_SKILL = 'carbone'
/** In the snapshot's SKILL.md: "array search and lookup since v5.7.0". */
const CARBONE_FACT = '5.7.0'
/** Anthropic's skills-only plugin, its one skill under skills/playground/. */
const PLAYGROUND = 'playground'
/** In its SKILL.md: "`templates/document-critique.md` — Document review". */
const PLAYGROUND_FACT = 'document-critique.md'
const COMMANDER = 'desktop-commander'
const COMMANDER_SKILLS = ['ai-tools-setup', 'computer-health-check', 'desktop-commander-overview', 'knowledge-base', 'obsidian-vault', 'terminal']

/* ---------------------------------------------------------------- L1 */

interface SkillPlugin {
  plugin: string
  skill: string
  /** A fact in the cached SKILL.md that no prompt holds. */
  fact: string
  /** The SKILL.md line that carries it, checked in the cache. */
  factInSkill: string
  question: string
}

/**
 * A skills-only plugin, already open in the picker's detail: what it adds,
 * Works with, Add, the cached snapshot, the Plugin row and its skill, one
 * turn that answers from the skill, and where the skill was read from.
 */
async function skillPluginStory(cinna: CinnaApp, agent: { id: string; path: string }, section: Locator, entry: DirectoryEntry, story: SkillPlugin): Promise<void> {
  const { dialog, detail } = picker(cinna)

  await test.step(`${story.plugin}'s detail: what it adds, and every engine, this agent's first`, async () => {
    await expect(detail.getByRole('heading', { level: 4, name: 'What it adds', exact: true })).toBeVisible()
    await expect(detail.getByText(`1 skill: ${story.skill}`, { exact: true })).toBeVisible()
    const own = LIVE_ENGINE.name
    const order = [own, ...ENGINE_ORDER.filter((engine) => engine !== own)]
    // Skills work on every engine: each line says "everything".
    await expect(detail.locator('[data-addon-works-with] li')).toHaveText(order.map((engine) => `${ENGINE_LABEL[engine]}: everything`))
    await expect(detail.locator('[data-addon-works-with] li').first()).toHaveAttribute('data-engine', own)
  })

  await test.step('Add pins the plugin; its snapshot is cached with the fact', async () => {
    // No connector, no code: the plain Add.
    await detail.getByRole('button', { name: `Add to ${AGENT}`, exact: true }).click()
    await expect(detail.getByText('Ready in the next chat', { exact: true })).toBeVisible({ timeout: 90_000 })
    const pins = (manifestOf(agent.path).marketplace_plugins ?? []) as Array<Record<string, unknown>>
    console.log(`live-marketplace-plugins pin: ${JSON.stringify(pins)}`)
    expect(pins).toHaveLength(1)
    expect(pins[0]).toMatchObject({ entry_uuid: entry.ref.id, name: story.plugin, marketplace_name: 'claude-plugins-official', archive_sha256: entry.digest?.replace(/^sha256:/, '') })
    const skillMds = findFiles(join(cinna.sandbox.userData, 'marketplace-plugins'), join(story.skill, 'SKILL.md'))
    expect(skillMds, 'the snapshot is cached').toHaveLength(1)
    expect(readFileSync(skillMds[0], 'utf8')).toContain(story.factInSkill)
    await detail.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  await test.step('the tab shows one Plugin row whose parts list the skill', async () => {
    const row = section.locator(`[data-plugin-row="${story.plugin}"]`)
    await expect(row.locator('[data-addon-kind]')).toHaveText('Plugin')
    await expect(row.getByRole('button', { name: `Show the files of ${story.plugin}`, exact: true })).toBeVisible({ timeout: 30_000 })
    const status = await cinna.page.evaluate((agentId) => window.api.addons.pluginStatus(agentId), agent.id)
    console.log(`live-marketplace-plugins status: ${JSON.stringify(status)}`)
    await expect(row.locator('[data-plugin-summary]'), 'the row counts the plugin’s skill').toHaveText('1 skill')
    await row.getByRole('button', { expanded: false }).click()
    const skill = row.locator('[data-plugin-parts]').getByRole('switch', { name: story.skill, exact: true })
    await expect(skill, 'the open row lists the skill with its switch').toHaveAttribute('aria-checked', 'true')
  })

  const prompt = `Use your ${story.skill} skill: ${story.question}`
  expect(prompt).not.toContain(story.fact)
  const { turn, asks } = await askAgent(cinna, agent.path, prompt)
  test.info().annotations.push({ type: 'asks', description: JSON.stringify(asks) })

  await test.step('the transcript opens the plugin’s skill from this sandbox, without an error', async () => {
    expect(turn.errors).toEqual([])
    const touched = turn.tools.filter((tool) => toolText(turn, tool).includes(story.skill))
    expect(touched.length, `a tool call opens or reads the ${story.skill} skill`).toBeGreaterThan(0)
    const roots = [cinna.sandbox.userData, realpathSync(cinna.sandbox.userData), agent.path, realpathSync(agent.path)]
    const paths = touched
      // File paths only: a URL's path (the skill's docs at https://carbone.io/…) is not a read from disk,
      // nor is the tail of a glob (`find ~ -path '*/carbone/SKILL.md'`).
      .flatMap((tool) => toolText(turn, tool).match(/(?<![\w.~:/*-])~?(?:\/[\w.@~+%-]+)+/g) ?? [])
      .filter((path) => path.includes(`/${story.skill}`))
    console.log(`live-marketplace-plugins skill paths: ${JSON.stringify([...new Set(paths)])}`)
    // Only a path that exists can have been read. Codex sometimes mistypes the cached copy's long path
    // (the e2e home's `~/.cinna-e2e-codex-A` prefix on userData's `…/userData/…`), the
    // read fails and it searches the home with find/rg before reading the right path. A copy outside
    // the sandbox, such as one in the real `~/.codex/skills`, exists and is still caught.
    const outside = paths.filter((path) => !roots.some((root) => path.startsWith(root)) && existsSync(path.replace(/^~(?=\/)/, homedir())))
    expect(outside, `no tool read a ${story.skill} skill from outside the sandbox`).toEqual([])
  })

  await test.step('the reply carries the fact from the plugin’s SKILL.md', async () => {
    expect(turn.reply).toContain(story.fact)
  })
}

test('@live L1 a folder agent answers from carbone-skill, a plugin added through the one addon picker', async ({ cinna }) => {
  // Product defect: readPluginTree (src/main/services/pluginTree.ts) reads skills only from skills/<name>/SKILL.md;
  // carbone-skill's plugin.json says "skills": "./carbone", so the pin reports no skill and no engine is handed it
  // (the row has no "1 skill" summary; on OpenCode the agent asked to web-search instead).
  test.setTimeout(8 * 60_000)
  const { config, token } = await liveSession()
  const directory = await coreDirectory(config, token)
  const carbone = directory.find((entry) => entry.kind === 'plugin' && entry.name === CARBONE)
  test.skip(!carbone, `core lists no ${CARBONE} plugin`)
  for (const [kind, name] of [['skill', 'pdf'], ['skill', 'docx'], ['plugin', COMMANDER]] as const) {
    expect(directory.find((row) => row.kind === kind && row.name === name), `core lists the ${kind} ${name}`).toBeTruthy()
  }

  const agent = await arrangeAgent(cinna, config, token)
  const section = await openAddons(cinna)
  const { dialog, tile, search } = picker(cinna)

  await test.step('Add → "pdf" lists skills and plugins side by side', async () => {
    await expect(section.getByText('No addons yet.', { exact: true })).toBeVisible()
    await section.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(dialog).toBeVisible()
    // docx's summary never says PDF; its description does, and the search reads descriptions too.
    await search.fill('pdf')
    for (const [name, kind] of [['pdf', 'Skill'], ['docx', 'Skill'], [CARBONE, 'Plugin'], [COMMANDER, 'Plugin']]) {
      await expect(tile(name), `${name} is listed for "pdf"`).toBeVisible({ timeout: 30_000 })
      await expect(tile(name).locator('[data-addon-kind]')).toHaveText(kind)
    }
    await expect(tile(CARBONE)).toHaveAttribute('data-addon-state', 'addable')
    await tile(CARBONE).click()
  })

  await skillPluginStory(cinna, agent, section, carbone as DirectoryEntry, {
    plugin: CARBONE,
    skill: CARBONE_SKILL,
    fact: CARBONE_FACT,
    factInSkill: `since v${CARBONE_FACT}`,
    question: 'since which Carbone version does array search (outside a loop) match values loosely? Reply with only the version number.'
  })
})

test('@live L1b a folder agent answers from playground, a skills-only plugin in the standard skills/ layout', async ({ cinna }) => {
  test.setTimeout(8 * 60_000)
  const { config, token } = await liveSession()
  const directory = await coreDirectory(config, token)
  const playground = directory.find((entry) => entry.kind === 'plugin' && entry.name === PLAYGROUND)
  test.skip(!playground, `core lists no ${PLAYGROUND} plugin`)

  const agent = await arrangeAgent(cinna, config, token)
  const section = await openAddons(cinna)
  await openTile(cinna, section, PLAYGROUND, PLAYGROUND, 'Plugin')
  await skillPluginStory(cinna, agent, section, playground as DirectoryEntry, {
    plugin: PLAYGROUND,
    skill: PLAYGROUND,
    fact: PLAYGROUND_FACT,
    factInSkill: `templates/${PLAYGROUND_FACT}`,
    question: 'which template file does it tell you to load for a document review playground? Reply with only the file name.'
  })
})

/* ---------------------------------------------------------------- L2 */

test('@live L2 desktop-commander’s connector reaches the turn through Cinna, its switch takes it away, Remove drops the plugin', async ({ cinna }) => {
  test.skip(!['claude', 'opencode'].includes(LIVE_ENGINE.name), 'L2 runs on Claude and OpenCode; Codex and Antigravity run L1 only')
  test.setTimeout(12 * 60_000)
  const { config, token } = await liveSession()
  const directory = await coreDirectory(config, token)
  const commander = directory.find((entry) => entry.kind === 'plugin' && entry.name === COMMANDER)
  test.skip(!commander, `core lists no ${COMMANDER} plugin`)
  const entry = commander as DirectoryEntry

  const agent = await arrangeAgent(cinna, config, token)
  const section = await openAddons(cinna)
  const { dialog, detail } = picker(cinna)
  const page = cinna.page

  await test.step(`${COMMANDER}'s detail: its connector and skills, Node.js, and the runs-code Add`, async () => {
    await openTile(cinna, section, 'pdf', COMMANDER, 'Plugin')
    await expect(detail.getByText(`6 skills: ${COMMANDER_SKILLS.join(', ')}`, { exact: true })).toBeVisible()
    await expect(detail.getByText(`1 connector: ${COMMANDER} (Node.js)`, { exact: true })).toBeVisible()
    await expect(detail.getByText('Node.js on this computer', { exact: true })).toBeVisible()
    await expect(detail.locator('[data-addon-works-with] li').first()).toHaveText(`${ENGINE_LABEL[LIVE_ENGINE.name as 'claude' | 'opencode']}: everything`)
  })

  let providerId = ''
  await test.step('Add — runs code on this computer: pinned, and its connector attached and connected', async () => {
    await detail.getByRole('button', { name: 'Add — runs code on this computer', exact: true }).click()
    await expect(detail.getByText('Ready in the next chat', { exact: true })).toBeVisible({ timeout: 120_000 })
    const pins = (manifestOf(agent.path).marketplace_plugins ?? []) as Array<Record<string, unknown>>
    expect(pins).toHaveLength(1)
    expect(pins[0]).toMatchObject({ entry_uuid: entry.ref.id, name: COMMANDER })
    const managed = (await page.evaluate(() => window.api.mcp.list())).filter((p) => (p.managedBy ?? '').startsWith(`plugin:${entry.ref.id}@`))
    console.log(`live-marketplace-plugins managed: ${JSON.stringify(managed.map((p) => ({ name: p.name, command: p.command, args: p.args, status: p.status, error: p.error })))}`)
    expect(managed).toHaveLength(1)
    expect(managed[0]).toMatchObject({ name: COMMANDER, transportType: 'stdio', command: 'npx' })
    providerId = managed[0].id
    expect(await page.evaluate((agentId) => window.api.localAgents.listMcpProviders(agentId), agent.id)).toEqual([providerId])
    await detail.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  const connectors = section.locator(`[data-plugin-row="${COMMANDER}"] section[aria-label="Connectors of ${COMMANDER}"]`)
  await test.step('the row nests the connector, with its skills', async () => {
    const row = section.locator(`[data-plugin-row="${COMMANDER}"]`)
    await expect(row.locator('[data-plugin-summary]')).toHaveText('6 skills · 1 connector')
    await expect(section.locator(`[data-mcp-row="${providerId}"]`)).toHaveCount(0)
    await row.getByRole('button', { expanded: false }).click()
    await expect(connectors.getByRole('switch', { name: COMMANDER, exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(connectors.getByText('Runs on this computer', { exact: true })).toBeVisible()
    // Main connects a plugin's server when a session first asks for it, not at Add: until then its glyph says so.
    console.log(`live-marketplace-plugins connector glyph before a chat: ${await connectors.getByRole('img').first().getAttribute('aria-label')}`)
    for (const skill of COMMANDER_SKILLS) {
      await expect(row.locator(`section[aria-label="Skills of ${COMMANDER}"]`).getByRole('switch', { name: skill, exact: true })).toHaveAttribute('aria-checked', 'true')
    }
  })

  const witness = `witness-${randomBytes(4).toString('hex')}.txt`
  mkdirSync(join(agent.path, 'dc-probe'), { recursive: true })
  writeFileSync(join(agent.path, 'dc-probe', witness), 'harmless\n')
  const prompt = (n: number): string =>
    `(${n}) Use the list_directory tool (it comes from the ${COMMANDER} connector and is served by the "cinna" MCP server) to list the folder ${join(agent.path, 'dc-probe')} ` +
    `and reply with only the file name you find there. If you have no such tool, reply NO TOOL and do not list it another way. ${LIVE_ENGINE.toolNote}`

  await test.step('Add starts the connector by itself, and the row says Connected', async () => {
    // Nothing is connected by hand: Add starts a plugin's servers (a cold `npx -y` in the sandbox HOME takes a while).
    await expect.poll(async () => (await page.evaluate(() => window.api.mcp.list())).find((p) => p.id === providerId)?.status, {
      message: 'the managed connector connects', timeout: 180_000, intervals: [2000]
    }).toBe('connected')
    await expect(connectors.getByRole('img', { name: 'Connected', exact: true })).toBeVisible({ timeout: 30_000 })
  })

  await test.step('a turn lists the folder through desktop-commander’s tool, via the cinna MCP server', async () => {
    const { turn } = await askAgent(cinna, agent.path, prompt(1))
    expect(turn.errors).toEqual([])
    // Cinna's `cinna` server relayed the call to desktop-commander, and its answer names the file.
    const relayed = turn.bridged.filter((call) => /list_directory$/.test(call.toolName ?? ''))
    expect(relayed.length, 'a list_directory call relayed by Cinna’s MCP server').toBeGreaterThan(0)
    expect(relayed.some((call) => !call.toolError && call.content.includes(`[FILE] ${witness}`)), `it answered "[FILE] ${witness}" without an error`).toBe(true)
    // The answer came back to the agent: the reply names the file, which no prompt does. (Claude's transcript
    // keeps no tool_result part for an MCP call, so the engine's own parts are not the witness here.)
    expect(turn.reply).toContain(witness)
  })

  await test.step('turning the connector off for this agent takes the tool away from a new chat', async () => {
    const section2 = await openAddons(cinna)
    const row = section2.locator(`[data-plugin-row="${COMMANDER}"]`)
    await row.getByRole('button', { expanded: false }).click()
    const toggle = row.locator(`section[aria-label="Connectors of ${COMMANDER}"]`).getByRole('switch', { name: COMMANDER, exact: true })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => (manifestOf(agent.path).marketplace_plugins as Array<{ disabled?: unknown }>)[0].disabled).toEqual({ mcp_servers: [COMMANDER] })
    const status = await page.evaluate((agentId) => window.api.addons.pluginStatus(agentId), agent.id)
    console.log(`live-marketplace-plugins status after off: ${JSON.stringify(status)}`)
    expect(status.ok && status.plugins[0].mcpServers.map((s) => s.disabled)).toEqual([true])
    expect(await page.evaluate((agentId) => window.api.localAgents.listMcpProviders(agentId), agent.id)).toEqual([])

    const { turn } = await askAgent(cinna, agent.path, prompt(2))
    expect(turn.errors).toEqual([])
    expect(turn.bridged.filter((call) => /list_directory$/.test(call.toolName ?? '')), 'no list_directory relayed in the new chat').toEqual([])
    expect(turn.results.filter((result) => result.text.includes(`[FILE] ${witness}`)), 'no desktop-commander listing in the new chat').toEqual([])
  })

  await test.step('Remove drops the pin and the managed connector', async () => {
    const section3 = await openAddons(cinna)
    const row = section3.locator(`[data-plugin-row="${COMMANDER}"]`)
    await row.getByRole('button', { name: `Remove ${COMMANDER}`, exact: true }).click()
    await row.getByRole('group', { name: `Remove ${COMMANDER}`, exact: true }).getByRole('button', { name: 'Remove', exact: true }).click()
    await expect.poll(() => manifestOf(agent.path).marketplace_plugins ?? []).toEqual([])
    await expect(section3.locator(`[data-plugin-row="${COMMANDER}"]`)).toHaveCount(0)
    expect(await page.evaluate((agentId) => window.api.localAgents.listMcpProviders(agentId), agent.id)).toEqual([])
    // That the managed row itself goes too is L2c's (a known defect when the connector was off at Remove).
    console.log(`live-marketplace-plugins managed row after Remove: ${JSON.stringify((await page.evaluate(() => window.api.mcp.list())).filter((p) => p.id === providerId).map((p) => ({ name: p.name, managedBy: p.managedBy, status: p.status })))}`)
    await expect(section3.getByText('No addons yet.', { exact: true })).toBeVisible()
  })
})

test('@live L2c removing desktop-commander while its connector is off removes the managed connector too', async ({ cinna }) => {
  test.skip(!['claude', 'opencode'].includes(LIVE_ENGINE.name), 'L2c runs no turn; it runs with the Claude and OpenCode passes')
  // Product defect: the switch off detaches the managed row but keeps it (the pin still references its snapshot,
  // pluginMcpProviders.ts release()); Remove's sync then walks only the agent's attached rows, and
  // collectUnreferenced() has no caller, so the row stays in Settings → MCP, where Delete is refused as managed.
  test.setTimeout(5 * 60_000)
  expectNoAgentTurn()
  const { config, token } = await liveSession()
  const commander = (await coreDirectory(config, token)).find((entry) => entry.kind === 'plugin' && entry.name === COMMANDER)
  test.skip(!commander, `core lists no ${COMMANDER} plugin`)
  const agent = await arrangeAgent(cinna, config, token)
  const page = cinna.page
  const section = await openAddons(cinna)
  const { dialog, detail } = picker(cinna)
  await openTile(cinna, section, COMMANDER, COMMANDER, 'Plugin')
  await detail.getByRole('button', { name: 'Add — runs code on this computer', exact: true }).click()
  await expect(detail.getByText('Ready in the next chat', { exact: true })).toBeVisible({ timeout: 120_000 })
  await detail.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const providerId = (await page.evaluate((agentId) => window.api.localAgents.listMcpProviders(agentId), agent.id))[0]
  expect(providerId).toBeTruthy()

  const row = section.locator(`[data-plugin-row="${COMMANDER}"]`)
  await row.getByRole('button', { expanded: false }).click()
  const toggle = row.locator(`section[aria-label="Connectors of ${COMMANDER}"]`).getByRole('switch', { name: COMMANDER, exact: true })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect.poll(() => page.evaluate((agentId) => window.api.localAgents.listMcpProviders(agentId), agent.id)).toEqual([])

  await row.getByRole('button', { name: `Remove ${COMMANDER}`, exact: true }).click()
  await row.getByRole('group', { name: `Remove ${COMMANDER}`, exact: true }).getByRole('button', { name: 'Remove', exact: true }).click()
  await expect.poll(() => manifestOf(agent.path).marketplace_plugins ?? []).toEqual([])
  await expect(section.locator(`[data-plugin-row="${COMMANDER}"]`)).toHaveCount(0)
  const left = (await page.evaluate(() => window.api.mcp.list())).filter((p) => p.id === providerId)
  console.log(`live-marketplace-plugins L2c left: ${JSON.stringify(left.map((p) => ({ name: p.name, managedBy: p.managedBy })))}`)
  expect(left, 'the plugin’s managed connector is gone from Settings → MCP').toEqual([])
})

/* ---------------------------------------------------------------- L3 */

/**
 * Core MCP directory fixtures (L3, L3b, L3c): created as core's superuser over
 * `/mcp-directory/entries` with a unique name and this marker as the
 * description, and deleted in `afterEach` only when both match exactly.
 */
const L3_MARKER = 'cinna-desktop e2e live-marketplace-plugins L3 fixture; deleted by exact name after the test'
const l3 = { config: null as LiveCinnaConfig | null, created: [] as Array<{ id: string; name: string }> }

interface CoreMcpRow { id: string; name: string; title: string; description: string | null }

async function adminMcp(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  if (!l3.config) throw new Error('no core configured for the MCP directory calls')
  return coreApi(l3.config, await signIn(l3.config), path, init)
}

async function coreMcpRows(): Promise<CoreMcpRow[]> {
  const listed = await adminMcp('/mcp-directory/entries')
  expect(listed.status, 'core lists its MCP directory to the superuser').toBe(200)
  return listed.body.data as CoreMcpRow[]
}

/**
 * One no-auth entry in core's MCP directory, then the app-facing directory
 * row it becomes (`/addons/directory`, by its exact name).
 */
async function createCoreMcp(
  config: LiveCinnaConfig,
  token: string,
  label: string,
  connect: { transport: 'http'; url: string } | { transport: 'stdio'; package: { registry: 'npm' | 'pypi'; name: string; version: string } }
): Promise<DirectoryEntry> {
  l3.config = config
  const suffix = randomBytes(3).toString('hex')
  const name = `cinna-e2e-l3-${label.toLowerCase()}-${suffix}`
  const title = `E2E ${label} ${suffix}`
  const made = await adminMcp('/mcp-directory/entries', {
    method: 'POST',
    body: { name, title, description: L3_MARKER, auth: 'none', ...connect }
  })
  expect(made.status, `POST /mcp-directory/entries ${name}: ${JSON.stringify(made.body)}`).toBe(200)
  l3.created.push({ id: made.body.id as string, name })
  let entry: DirectoryEntry | undefined
  await expect.poll(async () => {
    entry = (await coreDirectory(config, token)).find((row) => row.kind === 'mcp' && row.name === name)
    return entry?.status ?? 'absent'
  }, { message: `${name} is in /addons/directory`, timeout: 30_000 }).toBe('ready')
  console.log(`live-marketplace-plugins L3 fixture: ${JSON.stringify({ name, ref: entry!.ref, install: entry!.install, runsCode: (entry as unknown as { runs_code?: unknown }).runs_code })}`)
  return entry!
}

/** Deletes this test's fixtures by exact name and marker, then reads the directory back; the problem, or null. */
async function deleteCoreMcpFixtures(): Promise<string | null> {
  const problems: string[] = []
  const rows = await coreMcpRows()
  for (const fixture of l3.created) {
    const row = rows.find((candidate) => candidate.name === fixture.name)
    if (!row) continue
    if (row.id !== fixture.id || row.description !== L3_MARKER) {
      problems.push(`${fixture.name} on core is not this test's fixture; left alone`)
      continue
    }
    const gone = await adminMcp(`/mcp-directory/entries/${row.id}`, { method: 'DELETE' })
    if (gone.status !== 200) problems.push(`DELETE ${fixture.name}: ${gone.status}`)
  }
  const after = await coreMcpRows()
  for (const fixture of l3.created) if (after.some((row) => row.name === fixture.name)) problems.push(`${fixture.name} is still on core`)
  console.log(`live-marketplace-plugins L3 fixtures deleted: ${JSON.stringify(l3.created.map((fixture) => fixture.name))}${problems.length ? `; ${problems.join('; ')}` : ''}`)
  l3.created = []
  return problems.length ? problems.join('; ') : null
}

test.afterEach(async () => {
  if (l3.created.length === 0) return
  expect(await deleteCoreMcpFixtures(), 'the core MCP directory fixtures are gone').toBeNull()
})

/** Never a browser from the test: a sign-in would open one. Read back with {@link openedUrls}. */
async function stubBrowser(cinna: CinnaApp): Promise<void> {
  await cinna.electronApp.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { __opened?: string[] }).__opened = opened
    shell.openExternal = async (url: string) => { opened.push(url) }
  })
}

async function openedUrls(cinna: CinnaApp): Promise<string[]> {
  return cinna.electronApp.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])
}

/** Opens `entry`'s tile, Add, Ready in the next chat with no setup step; the attached provider's id. */
async function addDirectoryConnector(cinna: CinnaApp, agent: { id: string; path: string }, section: Locator, entry: DirectoryEntry, readyTimeout: number): Promise<string> {
  const { dialog, detail } = picker(cinna)
  await openTile(cinna, section, entry.title, entry.title, 'Connector')
  await detail.getByRole('button', { name: `Add to ${AGENT}`, exact: true }).click()
  await expect(detail.getByText('Ready in the next chat', { exact: true })).toBeVisible({ timeout: readyTimeout })
  await expect(detail.locator('[data-addon-setup]'), 'no sign-in, key or settings step').toHaveCount(0)
  const attached = await cinna.page.evaluate((agentId) => window.api.localAgents.listMcpProviders(agentId), agent.id)
  expect(attached).toHaveLength(1)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  return attached[0]
}

async function expectConnected(cinna: CinnaApp, providerId: string, timeout: number): Promise<void> {
  await expect.poll(async () => {
    const row = (await cinna.page.evaluate(() => window.api.mcp.list())).find((p) => p.id === providerId)
    return row?.status === 'error' ? `error: ${row.error}` : row?.status
  }, { message: 'the directory connector connects', timeout, intervals: [2000] }).toBe('connected')
}

/** The requirement written into `cinna-agent.json` for `entry`. */
function requirementOf(agentPath: string, entry: DirectoryEntry): Record<string, unknown> {
  const requirements = (manifestOf(agentPath).mcp_servers ?? []) as Array<Record<string, unknown>>
  console.log(`live-marketplace-plugins mcp_servers: ${JSON.stringify(requirements)}`)
  expect(requirements).toHaveLength(1)
  expect(requirements[0].ref).toMatchObject({ id: entry.ref.id })
  return requirements[0]
}

/* --------------------------------------------------- L3 no-auth HTTP */

/**
 * Core takes only https:// URLs, so the host server is TLS with a throwaway
 * CA the app is told to trust (`NODE_EXTRA_CA_CERTS`, read by main's Node).
 */
const TLS_DIR = join(tmpdir(), `cinna-e2e-l3-tls-${process.pid}`)
const TLS_CA = join(TLS_DIR, 'ca.pem')
const L3_TOOL = 'ledger_balance'

function makeTls(): void {
  mkdirSync(TLS_DIR, { recursive: true })
  const run = (...args: string[]): void => { execFileSync('openssl', args, { cwd: TLS_DIR, stdio: 'pipe' }) }
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=cinna-e2e-l3-ca',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
  run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=127.0.0.1')
  writeFileSync(join(TLS_DIR, 'server.ext'), 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n')
  run('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'server.ext')
}

/** A streamable-HTTP MCP server with no auth on 127.0.0.1 over TLS: one tool, and the methods it was asked. */
async function httpsMcp(): Promise<{ url: string; methods: string[]; authHeaders: string[]; close: () => Promise<void> }> {
  const methods: string[] = []
  const authHeaders: string[] = []
  const server = createHttpsServer({ key: readFileSync(join(TLS_DIR, 'server.key')), cert: readFileSync(join(TLS_DIR, 'server.pem')) }, (req, res) => {
    if (req.headers.authorization) authHeaders.push(req.headers.authorization)
    if (req.method !== 'POST') { res.writeHead(req.method === 'DELETE' ? 204 : 405); res.end(); return }
    let body = ''
    req.on('data', (chunk) => { body += String(chunk) })
    req.on('end', () => {
      const rpc = JSON.parse(body) as { id?: string | number; method: string; params?: { protocolVersion?: string } }
      methods.push(rpc.method)
      if (rpc.id === undefined) { res.writeHead(202); res.end(); return }
      const common = { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
      const info = { name: 'cinna-e2e-l3', version: '1.0.0' }
      const result =
        rpc.method === 'initialize' ? { protocolVersion: rpc.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: info }
          : rpc.method === 'server/discover' ? { ...common, supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, serverInfo: info }
            : rpc.method === 'tools/list' ? { ...common, tools: [{ name: L3_TOOL, description: 'The ledger balance.', inputSchema: { type: 'object', properties: {} } }] }
              : rpc.method === 'tools/call' ? { resultType: 'complete', content: [{ type: 'text', text: '42' }] }
                : {}
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    methods,
    authHeaders,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  }
}

test.describe('L3 no-auth HTTP', () => {
  test.use({ env: { NODE_EXTRA_CA_CERTS: TLS_CA } })
  test.beforeAll(() => makeTls())
  test.afterAll(() => rmSync(TLS_DIR, { recursive: true, force: true }))

  test('@live L3 a no-auth HTTP connector from core’s MCP directory connects with no sign-in, is written into mcp_servers[], and Detach drops it', async ({ cinna }) => {
    test.skip(!['claude', 'opencode'].includes(LIVE_ENGINE.name), 'L3 runs no turn; it runs with the Claude and OpenCode passes')
    test.setTimeout(5 * 60_000)
    expectNoAgentTurn()
    const { config, token } = await liveSession()
    const server = await httpsMcp()
    try {
      const entry = await createCoreMcp(config, token, 'HTTP', { transport: 'http', url: server.url })
      expect(entry.install?.mcp).toMatchObject({ transport: 'http', url: server.url, auth: 'none' })
      const agent = await arrangeAgent(cinna, config, token)
      await stubBrowser(cinna)
      const section = await openAddons(cinna)
      const page = cinna.page

      let providerId = ''
      await test.step(`Add ${entry.title}: Ready, no sign-in, connected, written into mcp_servers[]`, async () => {
        providerId = await addDirectoryConnector(cinna, agent, section, entry, 60_000)
        await expectConnected(cinna, providerId, 60_000)
        expect(server.methods, 'the app listed the server’s tools').toContain('tools/list')
        expect(server.authHeaders, 'no credential was sent').toEqual([])
        expect(requirementOf(agent.path, entry)).toMatchObject({ transport: 'http', url: server.url, auth: 'none' })
        expect(await openedUrls(cinna), 'no browser was opened').toEqual([])
      })

      await test.step('Detach drops the requirement', async () => {
        const name = (await page.evaluate(() => window.api.mcp.list())).find((p) => p.id === providerId)!.name
        await section.getByRole('button', { name: `Detach ${name} from this agent`, exact: true }).click()
        await section.getByRole('group', { name: `Detach ${name} from this agent`, exact: true }).getByRole('button', { name: 'Detach', exact: true }).click()
        await expect.poll(() => manifestOf(agent.path).mcp_servers ?? []).toEqual([])
        expect(await page.evaluate((agentId) => window.api.localAgents.listMcpProviders(agentId), agent.id)).toEqual([])
      })
    } finally {
      await server.close()
    }
  })
})

/* ------------------------------------------------------ L3o OAuth, not signed in */

test('@live L3o an OAuth connector from core’s MCP directory is written into mcp_servers[] without a sign-in, and Detach drops it', async ({ cinna }) => {
  test.skip(!['claude', 'opencode'].includes(LIVE_ENGINE.name), 'L3o runs no turn; it runs with the Claude and OpenCode passes')
  test.setTimeout(5 * 60_000)
  expectNoAgentTurn()
  const { config, token } = await liveSession()
  const target = (await coreDirectory(config, token))
    .find((entry) => entry.kind === 'mcp' && entry.status === 'ready' && entry.install?.mcp?.transport === 'http' && entry.install.mcp.auth === 'oauth')
  test.skip(!target, 'core’s MCP directory lists no ready OAuth HTTP server')
  const entry = target as DirectoryEntry
  test.info().annotations.push({ type: 'L3o entry', description: entry.title })

  const agent = await arrangeAgent(cinna, config, token)
  await stubBrowser(cinna)
  const section = await openAddons(cinna)
  const { dialog, detail } = picker(cinna)
  const page = cinna.page

  let providerId = ''
  await test.step(`Add ${entry.title}: attached, the sign-in step shown, written into mcp_servers[]`, async () => {
    await openTile(cinna, section, entry.title, entry.title, 'Connector')
    await detail.getByRole('button', { name: `Add to ${AGENT}`, exact: true }).click()
    // The add's connect is non-interactive: the step waits for the user, no browser opens.
    await expect(detail.locator('[data-addon-setup="oauth"]')).toContainText(`Sign in to ${entry.title} to finish.`, { timeout: 60_000 })
    const attached = await page.evaluate((agentId) => window.api.localAgents.listMcpProviders(agentId), agent.id)
    expect(attached).toHaveLength(1)
    providerId = attached[0]
    expect(requirementOf(agent.path, entry)).toMatchObject({ url: entry.install?.mcp?.url })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  await test.step('Detach drops the requirement', async () => {
    const name = (await page.evaluate(() => window.api.mcp.list())).find((p) => p.id === providerId)!.name
    await section.getByRole('button', { name: `Detach ${name} from this agent`, exact: true }).click()
    await section.getByRole('group', { name: `Detach ${name} from this agent`, exact: true }).getByRole('button', { name: 'Detach', exact: true }).click()
    await expect.poll(() => manifestOf(agent.path).mcp_servers ?? []).toEqual([])
    expect(await page.evaluate((agentId) => window.api.localAgents.listMcpProviders(agentId), agent.id)).toEqual([])
    expect(await openedUrls(cinna)).toEqual([])
  })
})

/* ------------------------------------------------- L3b / L3c stdio packages */

interface StdioStory {
  label: string
  package: { registry: 'npm' | 'pypi'; name: string; version: string }
  /** The portable command written into mcp_servers[], and its first argument. */
  command: 'npx' | 'uvx'
  arg: string
  tool: string
  prompt: (title: string) => string
  /** What the relayed call's answer must hold. */
  answer: string | RegExp
  /** What the reply must hold, from the relayed answer (never in the prompt). */
  replyFact: (content: string) => string
}

/** A relayed call's content (`[{type:'text',text}]` as JSON) as its text. */
function relayedText(content: string): string {
  try {
    const parts = JSON.parse(content) as Array<{ text?: unknown }>
    if (Array.isArray(parts)) return parts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('\n')
  } catch { /* not JSON: as stored */ }
  return content
}

/** A core MCP directory stdio entry: Add installs and starts it, mcp_servers[] gets the portable command, one turn calls its tool through Cinna. */
async function stdioStory(cinna: CinnaApp, story: StdioStory): Promise<void> {
  test.skip(!['claude', 'opencode'].includes(LIVE_ENGINE.name), 'L3b and L3c run on Claude and OpenCode')
  test.setTimeout(10 * 60_000)
  const { config, token } = await liveSession()
  const entry = await createCoreMcp(config, token, story.label, { transport: 'stdio', package: story.package })
  expect(entry.install?.mcp).toMatchObject({ transport: 'stdio', auth: 'none', package: { registry: story.package.registry, name: story.package.name, version: story.package.version } })
  const agent = await arrangeAgent(cinna, config, token)
  await stubBrowser(cinna)
  const section = await openAddons(cinna)

  let providerId = ''
  await test.step(`Add ${entry.title}: installed through ${story.command}, connected, written into mcp_servers[] as ${story.command}`, async () => {
    // A cold `npx -y` / managed `uvx` downloads the server (and uv itself) on the first start.
    providerId = await addDirectoryConnector(cinna, agent, section, entry, 240_000)
    await expectConnected(cinna, providerId, 240_000)
    const provider = (await cinna.page.evaluate(() => window.api.mcp.list())).find((p) => p.id === providerId)!
    console.log(`live-marketplace-plugins L3 provider: ${JSON.stringify({ name: provider.name, transportType: provider.transportType, command: provider.command, args: provider.args, status: provider.status })}`)
    expect(provider.transportType).toBe('stdio')
    if (story.command === 'npx') expect(provider.command).toBe('npx')
    else expect(provider.command, 'the managed uvx, inside the sandbox').toMatch(new RegExp(`^${cinna.sandbox.userData.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/.*uvx$`))
    expect(provider.args).toContain(story.arg)
    expect(requirementOf(agent.path, entry)).toMatchObject({ transport: 'stdio', command: story.command, args: expect.arrayContaining([story.arg]) })
    expect(await openedUrls(cinna)).toEqual([])
  })

  await test.step(`a turn calls ${story.tool}, relayed by Cinna’s MCP server`, async () => {
    const prompt = story.prompt(entry.title)
    const { turn } = await askAgent(cinna, agent.path, prompt)
    expect(turn.errors).toEqual([])
    const relayed = turn.bridged.filter((call) => new RegExp(`${story.tool.replace(/[-]/g, '\\-')}$`).test(call.toolName ?? ''))
    expect(relayed.length, `a ${story.tool} call relayed by Cinna’s MCP server`).toBeGreaterThan(0)
    const answered = relayed.map((call) => ({ ...call, text: relayedText(call.content) }))
      .find((call) => !call.toolError && (typeof story.answer === 'string' ? call.text.includes(story.answer) : story.answer.test(call.text)))
    expect(answered, `it answered ${story.answer} without an error`).toBeTruthy()
    const fact = story.replyFact(answered!.text)
    expect(prompt).not.toContain(fact)
    expect(turn.reply).toContain(fact)
  })
}

test('@live L3b an npm stdio connector from core’s MCP directory installs through npx, and a turn calls its tool', async ({ cinna }) => {
  const a = 300 + randomInt(600)
  const b = 1300 + randomInt(600)
  await stdioStory(cinna, {
    label: 'Sum',
    package: { registry: 'npm', name: '@modelcontextprotocol/server-everything', version: '1.0.0' },
    command: 'npx',
    arg: '@modelcontextprotocol/server-everything@1.0.0',
    tool: 'get-sum',
    prompt: (title) =>
      `Use the get-sum tool (it comes from the ${title} connector and is served by the "cinna" MCP server) to add ${a} and ${b}, ` +
      `and reply with only the number it returns. If you have no such tool, reply NO TOOL and do not add them another way. ${LIVE_ENGINE.toolNote}` +
      // OpenCode's code mode: `tools.cinna.get-sum` is not JavaScript, and the agent once gave up on it.
      (LIVE_ENGINE.name === 'opencode' ? ' The name has a hyphen, so in code write tools.cinna["get-sum"]({ a, b }).' : ''),
    answer: `The sum of ${a} and ${b} is ${a + b}.`,
    replyFact: () => String(a + b)
  })
})

test('@live L3c a PyPI stdio connector from core’s MCP directory installs through the managed uvx, and a turn calls its tool', async ({ cinna }) => {
  const zone = 'Pacific/Chatham'
  await stdioStory(cinna, {
    label: 'Time',
    package: { registry: 'pypi', name: 'mcp-server-time', version: '2026.10.19' },
    command: 'uvx',
    arg: 'mcp-server-time==2026.10.19',
    tool: 'get_current_time',
    prompt: (title) =>
      `Use the get_current_time tool (it comes from the ${title} connector and is served by the "cinna" MCP server) for the timezone ${zone}, ` +
      `and reply with only the datetime value it returns, exactly as returned. If you have no such tool, reply NO TOOL. ${LIVE_ENGINE.toolNote}`,
    answer: new RegExp(`"timezone":\\s*"${zone}"`),
    // The tool's "HH:MM" in Chatham time (UTC+12:45/+13:45): the clock from the answer, which no prompt holds.
    replyFact: (content) => {
      const datetime = /"datetime":\s*"([^"]+)"/.exec(content)?.[1] ?? ''
      expect(datetime, 'the answer carries a datetime').toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d/)
      return datetime.slice(11, 16)
    }
  })
})
