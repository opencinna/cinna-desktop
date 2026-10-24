import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { Locator } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { LIVE_ENGINE, expectNoAgentTurn, liveEngineOptions, requireLiveEngine, seedLiveModel, useLiveRuntime } from '../fixtures/liveEngine'
import { coreApi, linkLiveCinnaProfile, liveCoreSession } from '../fixtures/liveCinnaLink'
import type { LiveCinnaConfig } from '../fixtures/liveCinna'

/**
 * @live — **the unified addons story against the developer's real
 * cinna-core.** A kit folder agent on a profile linked to the local core
 * opens Addons → Add, and the one picker lists skills and plugins from core's
 * `/addons/directory` side by side: `pdf` finds the `pdf` skill and the
 * `carbone-skill` and `desktop-commander` plugins, and `docx`, whose
 * description (not its summary) says PDF: the search reads both.
 * Nothing on core is synced, edited or deleted.
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
 * - **L3 an MCP server from core's MCP directory.** A no-auth HTTP entry if
 *   core lists one, else an OAuth one added without signing in (the browser
 *   is stubbed in main; the add's connect is non-interactive): Add writes
 *   `mcp_servers[]` into `cinna-agent.json`, Detach drops it. No turn.
 *
 * Engine: `CINNA_E2E_LIVE_ENGINE` (`opencode` default, `claude` — with
 * `CINNA_E2E_CLAUDE_AUTH=api_key` for the .env key —, `codex`,
 * `antigravity`). L2, L2c and L3 run with Claude and OpenCode only. Needs
 * `CINNA_E2E_SERVER_URL` / `_EMAIL` / `_PASSWORD`.
 *
 * ## Cost
 *
 * L1b one short turn, L2 two. Run deliberately:
 * `make e2e-one SPEC=e2e/specs/live-marketplace-plugins.spec.ts LIVE_ENGINE=<engine>`.
 *
 * ## What it does not prove
 *
 * That the agent would pick the skill or the tool unprompted (the prompts
 * name them); a plugin's first chat without the arranged connect; commands,
 * agents, hooks or LSP (neither plugin has any); Update against a real
 * marketplace sync; an MCP directory server signed in or used in a turn.
 */

test.use(liveEngineOptions())
test.beforeEach(() => requireLiveEngine())

const AGENT = 'Doc Desk'
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

const ENGINE_ORDER = ['claude', 'opencode', 'codex', 'antigravity'] as const
const ENGINE_LABEL: Record<(typeof ENGINE_ORDER)[number], string> = { claude: 'Claude', opencode: 'OpenCode', codex: 'Codex', antigravity: 'Antigravity' }

interface DirectoryEntry {
  ref: { source: string; id: string }
  kind: 'skill' | 'plugin' | 'mcp'
  name: string
  title: string
  digest: string | null
  status: string
  install: { mcp?: { transport: string; url?: string | null; auth: string } } | null
}

async function coreDirectory(config: LiveCinnaConfig, token: string): Promise<DirectoryEntry[]> {
  const listed = await coreApi(config, token, '/addons/directory')
  expect(listed.status, 'core serves /addons/directory').toBe(200)
  return listed.body.data as DirectoryEntry[]
}

interface Turn {
  /** The chat still has a run going (`activeRunId`). */
  running: boolean
  reply: string
  errors: string[]
  tools: Array<{ toolId?: string; toolName?: string; toolInput?: unknown; text: string }>
  results: Array<{ toolId?: string; toolStream?: string; text: string }>
  /** The MCP calls Cinna's `cinna` server relayed in this turn (`tool_call` rows, `conductorBridge.ts`). */
  bridged: Array<{ toolName: string | null; toolProvider: string | null; toolError: unknown; content: string }>
}

async function turnOf(cinna: CinnaApp, prompt: string): Promise<Turn | null> {
  return cinna.page.evaluate(async (first) => {
    for (const row of await window.api.chat.list()) {
      const chat = await window.api.chat.get(row.id)
      if (chat?.messages.find((message) => message.role === 'user')?.content !== first) continue
      const assistant = chat.messages.filter((message) => message.role === 'assistant')
      const parts = assistant.flatMap((message) => message.parts ?? [])
      return {
        running: !!chat.activeRunId,
        reply: assistant.map((message) => message.content).join('\n'),
        errors: chat.messages.filter((message) => message.role === 'error').map((message) => message.content.slice(0, 500)),
        tools: parts.filter((part) => part.kind === 'tool')
          .map((part) => ({ toolId: part.toolId, toolName: part.toolName, toolInput: part.toolInput, text: part.text })),
        results: parts.filter((part) => part.kind === 'tool_result')
          .map((part) => ({ toolId: part.toolId, toolStream: part.toolStream, text: part.text })),
        bridged: chat.messages.filter((message) => message.role === 'tool_call').map((message) => {
          const row = message as unknown as { toolName?: string | null; toolProvider?: string | null; toolError?: unknown }
          return { toolName: row.toolName ?? null, toolProvider: row.toolProvider ?? null, toolError: row.toolError ?? null, content: message.content.slice(0, 1000) }
        })
      }
    }
    return null
  }, prompt)
}

/** A tool call and its paired results, as one string. */
function toolText(turn: Turn, tool: Turn['tools'][number]): string {
  const results = turn.results.filter((result) => tool.toolId !== undefined && result.toolId === tool.toolId)
  return [JSON.stringify(tool), ...results.map((result) => result.text)].join('\n')
}

function manifestOf(agentPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentPath, 'cinna-agent.json'), 'utf8')) as Record<string, unknown>
}

/** Every file under `root` whose path ends in `suffix`. */
function findFiles(root: string, suffix: string): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (path.endsWith(suffix)) found.push(path)
    }
  }
  walk(root)
  return found
}

/** A kit agent on this run's engine, on a profile linked to the real core, visible to every picker. */
async function arrangeAgent(cinna: CinnaApp, config: LiveCinnaConfig, token: string): Promise<{ id: string; path: string }> {
  await cinna.skipOnboarding()
  const model = await seedLiveModel(cinna)
  console.log(`live-marketplace-plugins model: ${model}`)
  test.info().annotations.push({ type: 'model', description: model })
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const root = await addAgentRoot(cinna)
  const created = await createFolderAgent(cinna, root, AGENT, 'Answers questions about documents and templates.')
  await useLiveRuntime(cinna, created.id)
  await linkLiveCinnaProfile(cinna, config, token)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  expect((await cinna.page.evaluate(() => window.api.auth.getCurrent()))?.type).toBe('cinna_user')
  return created
}

/** Agents → the agent → Settings → Addons, and its Addons section. */
async function openAddons(cinna: CinnaApp): Promise<Locator> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Addons/ }).click()
  return page
    .getByRole('tabpanel')
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 2, name: 'Addons', exact: true }) })
}

function picker(cinna: CinnaApp): { dialog: Locator; tile: (name: string) => Locator; detail: Locator; search: Locator } {
  const dialog = cinna.page.getByRole('dialog', { name: `Addons for ${AGENT}`, exact: true })
  const list = dialog.locator('[data-addon-list] [data-addon-results]')
  return {
    dialog,
    tile: (name) => list.getByRole('button', { name, exact: true }),
    detail: dialog.locator('[data-addon-detail]'),
    search: dialog.getByRole('textbox', { name: 'Search addons', exact: true })
  }
}

/** Opens the picker, searches `query`, opens `title`'s tile; the tile's kind is checked. */
async function openTile(cinna: CinnaApp, section: Locator, query: string, title: string, kind: string): Promise<void> {
  const { dialog, tile, search } = picker(cinna)
  await section.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toBeVisible()
  await search.fill(query)
  await expect(tile(title)).toBeVisible({ timeout: 30_000 })
  await expect(tile(title).locator('[data-addon-kind]')).toHaveText(kind)
  await tile(title).click()
}

/** The agent's composer, a new chat, the prompt sent; then the turn to its end. */
async function askAgent(cinna: CinnaApp, agentPath: string, prompt: string): Promise<{ turn: Turn; asks: string[] }> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(prompt)
  await input.press('Enter')
  await expect(page.getByRole('combobox', { name: 'Send a follow-up · Esc Esc to stop', exact: true })).toBeVisible({ timeout: 30_000 })

  let turn: Turn | null = null
  const asks: string[] = []
  // Antigravity asks before every command (its default approval); answer only commands run in the agent's own folder.
  const askable = LIVE_ENGINE.name === 'antigravity'
  const ask = page.locator('div').filter({ has: page.getByText(/^The agent is asking to /) }).filter({ has: page.getByRole('button', { name: 'Allow once', exact: true }) }).last()
  let outcome = 'running'
  await expect.poll(async () => {
    if ((await ask.count()) > 0) {
      const text = await ask.innerText()
      const cwd = /"cwd":"([^"]*)"/.exec(text)?.[1] ?? ''
      const inAgent = /^The agent is asking to run a command/.test(text) && [agentPath, realpathSync(agentPath)].includes(cwd)
      if (!askable || !inAgent || asks.length >= 4) return (outcome = `ask: ${text.slice(0, 500)}`)
      asks.push(text.slice(0, 500))
      await ask.getByRole('button', { name: 'Allow once', exact: true }).click()
      return (outcome = 'answered an ask')
    }
    turn = await turnOf(cinna, prompt)
    if (turn && turn.errors.length > 0) return (outcome = `error: ${turn.errors[0]}`)
    return (outcome = turn !== null && !turn.running && turn.reply.trim() !== '' ? 'done' : 'running')
  }, { message: 'the turn ends, or stops on an ask or an error', timeout: 4 * 60_000, intervals: [1000] }).toMatch(/^(done|ask: |error: )/)
  expect(outcome).toBe('done')
  const settled = turn as unknown as Turn
  const summary = JSON.stringify(settled.tools.map((tool) => ({ name: tool.toolName, input: tool.toolInput, text: tool.text.slice(0, 200) }))).slice(0, 3000)
  console.log(`live-marketplace-plugins ${LIVE_ENGINE.label} tools: ${summary}`)
  console.log(`live-marketplace-plugins reply: ${JSON.stringify(settled.reply.slice(0, 300))}`)
  console.log(`live-marketplace-plugins asks: ${JSON.stringify(asks)}`)
  console.log(`live-marketplace-plugins bridged: ${JSON.stringify(settled.bridged).slice(0, 1500)}`)
  test.info().annotations.push({ type: 'tool calls', description: summary }, { type: 'reply', description: settled.reply.slice(0, 500) })
  if (!askable) expect(asks).toEqual([])
  return { turn: settled, asks }
}

async function liveSession() {
  const session = await liveCoreSession()
  test.skip(!session.ok, session.ok ? '' : session.reason)
  if (!session.ok) throw new Error('unreachable')
  return session
}

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

test('@live L3 a connector from core’s MCP directory is written into mcp_servers[], and Detach drops it', async ({ cinna }) => {
  test.skip(!['claude', 'opencode'].includes(LIVE_ENGINE.name), 'L3 runs no turn; it runs with the Claude and OpenCode passes')
  test.setTimeout(5 * 60_000)
  expectNoAgentTurn()
  const { config, token } = await liveSession()
  const directory = await coreDirectory(config, token)
  const mcp = directory.filter((entry) => entry.kind === 'mcp' && entry.status === 'ready' && entry.install?.mcp?.transport === 'http')
  const target = mcp.find((entry) => entry.install?.mcp?.auth === 'none') ?? mcp.find((entry) => entry.install?.mcp?.auth === 'oauth')
  test.skip(!target, 'core’s MCP directory lists no ready HTTP server (no-auth or OAuth)')
  const entry = target as DirectoryEntry
  const auth = entry.install?.mcp?.auth
  console.log(`live-marketplace-plugins L3 entry: ${entry.title} (${entry.ref.id}), auth ${auth}, ${mcp.length} HTTP entries`)
  test.info().annotations.push({ type: 'L3 entry', description: `${entry.title} auth=${auth}` })

  const agent = await arrangeAgent(cinna, config, token)
  // Never a browser from the test: a sign-in would open one.
  await cinna.electronApp.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { __opened?: string[] }).__opened = opened
    shell.openExternal = async (url: string) => { opened.push(url) }
  })
  const section = await openAddons(cinna)
  const { dialog, detail } = picker(cinna)
  const page = cinna.page

  let providerId = ''
  await test.step(`Add ${entry.title}: attached, and written into mcp_servers[]`, async () => {
    await openTile(cinna, section, entry.title, entry.title, 'Connector')
    await detail.getByRole('button', { name: `Add to ${AGENT}`, exact: true }).click()
    if (auth === 'oauth') await expect(detail.locator('[data-addon-setup="oauth"]')).toContainText(`Sign in to ${entry.title} to finish.`, { timeout: 60_000 })
    else await expect(detail.getByText('Ready in the next chat', { exact: true })).toBeVisible({ timeout: 60_000 })
    const attached = await page.evaluate((agentId) => window.api.localAgents.listMcpProviders(agentId), agent.id)
    expect(attached).toHaveLength(1)
    providerId = attached[0]
    const requirements = (manifestOf(agent.path).mcp_servers ?? []) as Array<Record<string, unknown>>
    console.log(`live-marketplace-plugins mcp_servers: ${JSON.stringify(requirements)}`)
    expect(requirements).toHaveLength(1)
    expect(JSON.stringify(requirements[0])).toContain(entry.ref.id)
    expect(requirements[0]).toMatchObject({ url: entry.install?.mcp?.url })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  await test.step('Detach drops the requirement', async () => {
    const name = (await page.evaluate(() => window.api.mcp.list())).find((p) => p.id === providerId)!.name
    await section.getByRole('button', { name: `Detach ${name} from this agent`, exact: true }).click()
    await section.getByRole('group', { name: `Detach ${name} from this agent`, exact: true }).getByRole('button', { name: 'Detach', exact: true }).click()
    await expect.poll(() => manifestOf(agent.path).mcp_servers ?? []).toEqual([])
    expect(await page.evaluate((agentId) => window.api.localAgents.listMcpProviders(agentId), agent.id)).toEqual([])
    expect(await cinna.electronApp.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])).toEqual([])
  })
})
