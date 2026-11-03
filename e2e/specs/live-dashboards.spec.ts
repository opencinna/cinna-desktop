import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { LIVE_REQUESTED, requireLiveKey, seedOpenAiDefaultMode } from '../fixtures/live'
import { liveEngineFor, type LiveEngine } from '../fixtures/liveEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * @live — **Dashboards D2 on a real agent**: a kit agent asked in one message
 * for two dashboard components builds both under its `dashboards/`, runs the
 * delivered `cinna-dashboards` skill's `check_component.py`, and prints a
 * reference for each on a line of its own. The transcript then shows two
 * cards that resolve as valid (title, `Add <title> to a dashboard` enabled,
 * no `Has problems to fix`), and one of them, added to a dashboard through
 * its card, draws its data in the tile.
 *
 * Engines: `CINNA_E2E_LIVE_DASHBOARD_ENGINES`, a comma list of
 * `claude-haiku`, `claude-sonnet`, `opencode` (unset: `claude-haiku,opencode`),
 * one `test.describe('on <entry>')` each, resolved through `liveEngineFor`.
 * Claude runs on the developer's own login (`realLogin.ts`); OpenCode on
 * `.env`'s `OPENAI_API_KEY` with `gpt-5.6-luna`. Claude on `haiku` asks
 * before each write (Ask every time): every permission ask is answered
 * Allow once and counted in the log.
 *
 * Assertions are on outcomes — the folders, the tool rows, the printed
 * reference lines, the cards and the tile — never on wording. Each run writes
 * its transcript to the test's output folder (`dashboards-transcript.md`).
 *
 * Cost: one building turn of a dozen or so tool calls (on haiku a few cents
 * on the subscription; on gpt-5.6-luna about $0.05).
 *
 * Not proven: Preview, Ask to fix and missing-credential cards on a real
 * agent (`dashboard-cards.spec.ts` covers them scripted), skill-shipped
 * components, bundle references, Codex and Antigravity delivery.
 */

const AGENT = 'Follow-up Desk'
const DESCRIPTION = 'Keeps track of my open follow-ups and my notes, and shows them to me.'
const PROMPT = [
  'Build me two dashboard components: a list of my open follow-ups from app-data/followups.json',
  'and a markdown view of my notes in app-data/notes.md.',
  'Seed those two files with a few example entries.',
  'Check each component, then print a reference for each.'
].join(' ')
const REFERENCE_LINE = /^\s*cinna:\/\/component\/\S+\s*$/gm

interface DashboardEngine { entry: string; engine: LiveEngine }

const ENGINES: DashboardEngine[] = ((process.env.CINNA_E2E_LIVE_DASHBOARD_ENGINES ?? '').trim() || 'claude-haiku,opencode')
  .split(',').map((raw) => raw.trim()).filter(Boolean).map((entry) => {
    const claude = /^claude-(haiku|sonnet|opus)$/.exec(entry)
    if (claude) return { entry, engine: liveEngineFor('claude', claude[1]) }
    if (entry === 'opencode') return { entry, engine: liveEngineFor('opencode', '') }
    throw new Error(`CINNA_E2E_LIVE_DASHBOARD_ENGINES: unknown entry "${entry}" (claude-haiku, claude-sonnet, claude-opus, opencode)`)
  })

async function kitAgent(cinna: CinnaApp, runtime: LiveEngine['runtime']): Promise<{ agentId: string; dir: string }> {
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, DESCRIPTION)
  if (runtime !== null) {
    const outcome = await cinna.page.evaluate(async ({ agentId, runtime }) => {
      const got = await window.api.localAgents.get(agentId)
      if (!got.ok) return { ok: false as const, message: got.message }
      const stamp = got.value.stamps['cinna-agent.json']
      if (!stamp) return { ok: false as const, message: 'the kit agent has no manifest stamp' }
      return window.api.localAgents.updateField({ agentId, update: { field: 'runtime', value: runtime }, expectedStamp: stamp })
    }, { agentId: agent.id, runtime })
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
  }
  return { agentId: agent.id, dir: agent.path }
}

/** Component folders the agent made: each `dashboards/<name>/` holding a `component.json`. */
function componentFolders(dir: string): string[] {
  const root = join(dir, 'dashboards')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'component.json')))
    .map((entry) => entry.name)
    .sort()
}

async function transcript(page: Page, chatId: string): Promise<string> {
  const chat = await page.evaluate((id) => window.api.chat.get(id), chatId)
  if (!chat) return '(no chat)'
  return chat.messages.map((m) => {
    if (m.role === 'tool_call') return `**tool_call ${m.toolName}**${m.toolError ? ' ERROR' : ''}\n\`\`\`json\n${JSON.stringify(m.toolInput ?? {}, null, 2).slice(0, 2000)}\n\`\`\`\n→ ${(m.content ?? '').slice(0, 800)}`
    const tools = (m.parts ?? []).filter((part) => part.kind === 'tool' || part.kind === 'tool_result')
      .map((part) => part.kind === 'tool' ? `  - tool ${part.toolName}: ${JSON.stringify(part.toolInput ?? {}).slice(0, 600)}` : `    → ${part.text.slice(0, 400).replace(/\n/g, ' ⏎ ')}`)
    return `**${m.role}**: ${m.content ?? ''}${tools.length > 0 ? `\n\n<tools>\n${tools.join('\n')}\n</tools>` : ''}`
  }).join('\n\n')
}

/**
 * Send `prompt` in the open new-chat composer and wait for the turn to end,
 * answering every permission ask Allow once (counted, with its text).
 */
async function buildTurn(cinna: CinnaApp, agentId: string, prompt: string, asks: string[]): Promise<string> {
  const page = cinna.page
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(prompt)
  await input.press('Enter')
  let chatId: string | null = null
  const allow: Locator = page.getByRole('button', { name: 'Allow once', exact: true })
  await expect.poll(async () => {
    if (!chatId) {
      chatId = (await page.evaluate(() => window.api.chat.list())).find((row) => row.agentId !== null)?.id ?? null
      if (!chatId) return 'no chat yet'
    }
    if (await allow.count() > 0) {
      const text = (await allow.first().locator('xpath=ancestor::*[4]').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)
      await allow.first().click().catch(() => undefined)
      asks.push(text)
      return 'asked'
    }
    const chat = await page.evaluate((id) => window.api.chat.get(id), chatId)
    const messages = chat?.messages ?? []
    const last = messages[messages.length - 1]
    if (chat?.activeRunId || messages.length < 2 || last?.role !== 'assistant' || !last.content) return 'running'
    return 'done'
  }, { timeout: 12 * 60_000, intervals: [1000], message: 'the building turn ends' }).toBe('done')
  void agentId
  return chatId!
}

test.beforeEach(() => {
  test.skip(!LIVE_REQUESTED, 'live specs run only through make e2e-live or make e2e-one SPEC=<live spec>')
})

for (const { entry, engine } of ENGINES) test.describe(`on ${entry}`, () => {
  test.use({
    engine: true,
    realLogin: engine.realLogin,
    liveEngineCheck: { engine: engine.name, binary: engine.realLogin?.binary ?? null }
  })

  test(`[${entry}] two components asked in one message become two valid cards, and one added to a dashboard draws its data`, async ({ cinna }) => {
    test.setTimeout(20 * 60_000)
    if (engine.name === 'opencode') requireLiveKey()
    test.skip(engine.skipReason !== null, engine.skipReason ?? '')

    await cinna.skipOnboarding()
    if (engine.name === 'opencode') console.log(`live-dashboards ${entry}: default mode on ${await seedOpenAiDefaultMode(cinna)}`)
    await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
    const { agentId, dir } = await kitAgent(cinna, engine.runtime)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())

    await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
    await answerAgentsFolder(cinna)
    await cinna.page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()

    const asks: string[] = []
    const started = Date.now()
    let chatId = ''
    try {
      chatId = await buildTurn(cinna, agentId, PROMPT, asks)
    } finally {
      const id = chatId || (await cinna.page.evaluate(() => window.api.chat.list())).find((row) => row.agentId !== null)?.id
      if (id) {
        const path = test.info().outputPath('dashboards-transcript.md')
        writeFileSync(path, `# ${engine.label}\n\n## Permission asks (${asks.length})\n${asks.map((a) => `- ${a}`).join('\n')}\n\n## Chat\n\n${await transcript(cinna.page, id)}`)
        console.log(`live-dashboards ${entry}: transcript ${path}`)
      }
    }
    console.log(`live-dashboards ${entry}: turn took ${Math.round((Date.now() - started) / 1000)} s, ${asks.length} permission ask(s)`)
    for (const ask of asks) console.log(`  ask: ${ask}`)

    const page = cinna.page
    const chat = (await page.evaluate((id) => window.api.chat.get(id), chatId))!
    const replies = chat.messages.filter((m) => m.role === 'assistant').map((m) => m.content ?? '').join('\n')
    const references = [...new Set((replies.match(REFERENCE_LINE) ?? []).map((line) => line.trim()))]
    console.log(`live-dashboards ${entry}: references printed:\n${references.map((r) => `  ${r}`).join('\n')}`)
    // A tool step is a `tool_call` row (OpenCode) or a `tool` part of the assistant row (Claude).
    const toolInputs = chat.messages.flatMap((m) => [
      ...(m.role === 'tool_call' ? [JSON.stringify(m.toolInput ?? {})] : []),
      ...(m.parts ?? []).filter((part) => part.kind === 'tool').map((part) => JSON.stringify(part.toolInput ?? {}))
    ])
    const checks = toolInputs.filter((input) => input.includes('check_component.py'))
    for (const check of checks) console.log(`  check: ${check.slice(0, 300)}`)
    console.log(`live-dashboards ${entry}: check_component.py runs: ${checks.length}`)
    const folders = componentFolders(dir)
    console.log(`live-dashboards ${entry}: dashboards/ holds ${JSON.stringify(folders)}`)

    await test.step('the agent built two components, ran the check script and printed two references', async () => {
      expect(folders.length, `two component folders under dashboards/: ${JSON.stringify(folders)}`).toBeGreaterThanOrEqual(2)
      expect(checks.length, 'the agent ran the skill’s check_component.py').toBeGreaterThan(0)
      expect(references.length, `two references, each on its own line:\n${replies}`).toBeGreaterThanOrEqual(2)
    })

    const components = await page.evaluate((id) => window.api.dashboards.components(id), agentId)
    console.log(`live-dashboards ${entry}: components ${JSON.stringify(components.map((c) => ({ name: c.name, title: c.title, view: c.view, valid: c.valid, source: c.source, findings: c.findings.map((f) => f.message) })))}`)

    await test.step('the transcript shows two cards, each valid: title, Add enabled, no problems', async () => {
      const cards = page.locator('[data-component-cards] [data-component-card]')
      await expect(cards.first()).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('[data-component-card-skeleton]')).toHaveCount(0, { timeout: 30_000 })
      const count = await cards.count()
      const names: string[] = []
      for (let i = 0; i < count; i++) names.push((await cards.nth(i).getAttribute('aria-label')) ?? '')
      console.log(`live-dashboards ${entry}: cards ${JSON.stringify(names)}; card text:\n${(await cards.allInnerTexts()).map((t) => `  ${t.replace(/\s+/g, ' ')}`).join('\n')}`)
      expect(count, 'one card per printed component').toBeGreaterThanOrEqual(2)
      await expect(page.locator('[data-component-miss]')).toHaveCount(0)
      for (const component of components.filter((c) => folders.includes(c.name))) {
        const card = page.locator('[data-component-cards]').getByRole('group', { name: `Component ${component.title}`, exact: true }).first()
        await expect(card).toBeVisible()
        await expect(card).toContainText(component.title)
        await expect(card).toContainText(AGENT)
        await expect(card).not.toContainText('Has problems to fix')
        await expect(card.getByRole('button', { name: `Add ${component.title} to a dashboard`, exact: true })).toBeEnabled()
      }
    })

    const chosen = components.find((c) => c.valid && c.view === 'list' && folders.includes(c.name))
      ?? components.find((c) => c.valid && folders.includes(c.name))
    expect(chosen, 'a valid component to add').toBeTruthy()
    const title = chosen!.title

    await test.step(`Add to dashboard… on “${title}” places it, and the tile draws its data`, async () => {
      const card = page.locator('[data-component-cards]').getByRole('group', { name: `Component ${title}`, exact: true }).first()
      await card.getByRole('button', { name: `Add ${title} to a dashboard`, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: `Add ${title} to a dashboard` })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(dialog).toBeHidden()
      await expect(card).toContainText('On My dashboard')
      await card.getByRole('button', { name: 'My dashboard', exact: true }).click()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('My dashboard')

      // What the tile should draw, from main's own cached result once the run finished.
      const dashboards = await page.evaluate(() => window.api.dashboards.list())
      const board = dashboards.find((d) => d.name === 'My dashboard')!
      let data: unknown = null
      await expect.poll(async () => {
        const tiles = await page.evaluate((id) => window.api.dashboards.tiles(id), board.id)
        if (!tiles.ok || tiles.tiles.length === 0) return 'no tile'
        const result = await page.evaluate((id) => window.api.dashboards.tileResult(id), tiles.tiles[0].tile.id)
        if (!result.ok) return `tileResult: ${JSON.stringify(result)}`
        if (result.result.error) return `error: ${result.result.error}`
        data = result.result.data
        return data === null ? 'no data yet' : 'data'
      }, { timeout: 90_000, message: 'the tile has a result' }).toBe('data')
      console.log(`live-dashboards ${entry}: tile data ${JSON.stringify(data).slice(0, 600)}`)
      const expected = visibleText(chosen!.view, data, chosen!.source, dir)
      expect(expected, `a string the tile should show, from ${JSON.stringify(data).slice(0, 300)}`).not.toBe('')
      const grid = page.getByTestId('dashboard-grid')
      await expect(grid.getByRole('group')).toHaveCount(1)
      await expect(grid.getByRole('group', { name: title }).getByText(expected, { exact: false }).first()).toBeVisible({ timeout: 30_000 })
    })
  })
})

/**
 * D3 on a real agent: one item picked in a list tile, asked about in the
 * dashboard's chat panel. The question names nothing; the item's title is
 * only in the wire-only `<dashboard_context>` block, so a reply that names it
 * read the selection.
 */
const SELECT_AGENT = 'Follow-up Panel Desk'
const FOLLOW_UPS = [
  { id: 'fu-1', title: 'Renew the Halvorsen maintenance contract', subtitle: 'Due in two weeks' },
  { id: 'fu-2', title: 'Send Marisol the revised Q3 forecast', subtitle: 'She asked on Monday' },
  { id: 'fu-3', title: 'Book the Lisbon offsite venue', subtitle: 'Before the prices go up' }
]
const SELECTED = FOLLOW_UPS[1]
const PANEL_QUESTION = 'What is the item I selected about?'

for (const { entry, engine } of ENGINES) test.describe(`on ${entry}`, () => {
  test.use({
    engine: true,
    realLogin: engine.realLogin,
    liveEngineCheck: { engine: engine.name, binary: engine.realLogin?.binary ?? null }
  })

  test(`[${entry}] D3: an item selected in a tile is what the panel's agent answers about`, async ({ cinna }) => {
    test.setTimeout(10 * 60_000)
    if (engine.name === 'opencode') requireLiveKey()
    test.skip(engine.skipReason !== null, engine.skipReason ?? '')

    await cinna.skipOnboarding()
    if (engine.name === 'opencode') console.log(`live-dashboards ${entry}: default mode on ${await seedOpenAiDefaultMode(cinna)}`)
    await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
    const root = await addAgentRoot(cinna)
    const agent = await createFolderAgent(cinna, root, SELECT_AGENT, 'Keeps my open follow-ups.')
    if (engine.runtime !== null) {
      const outcome = await cinna.page.evaluate(async ({ agentId, runtime }) => {
        const got = await window.api.localAgents.get(agentId)
        if (!got.ok) return { ok: false as const, message: got.message }
        return window.api.localAgents.updateField({ agentId, update: { field: 'runtime', value: runtime }, expectedStamp: got.value.stamps['cinna-agent.json']! })
      }, { agentId: agent.id, runtime: engine.runtime })
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
    }
    const component = join(agent.path, 'dashboards', 'follow-ups')
    mkdirSync(join(component, 'api'), { recursive: true })
    writeFileSync(join(component, 'component.json'), JSON.stringify({
      schema_version: 1, title: 'Follow-ups', view: 'list',
      source: { endpoint: 'items' },
      endpoints: { items: { script: 'api/items.mjs', description: 'My open follow-ups. No params.' } },
      size: 'm'
    }, null, 2))
    writeFileSync(join(component, 'api', 'items.mjs'), `console.log(JSON.stringify({ items: ${JSON.stringify(FOLLOW_UPS)} }))\n`)
    const added = await cinna.page.evaluate(async (agentId) => {
      await window.api.localAgents.rescan()
      return window.api.dashboards.addTile({ newDashboardName: 'My dashboard', agentId, component: 'follow-ups' })
    }, agent.id)
    expect(added.ok, JSON.stringify(added)).toBe(true)

    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    const page = cinna.page
    await page.getByRole('button', { name: 'Dashboards', exact: true }).click()
    await page.getByRole('button', { name: 'My dashboard 1', exact: true }).click()
    const tile = page.getByTestId('dashboard-grid').getByRole('group', { name: 'Follow-ups', exact: true })
    const row = tile.locator('li', { hasText: SELECTED.title })
    await expect(row).toBeVisible({ timeout: 60_000 })

    await tile.hover()
    await tile.getByRole('button', { name: 'Ask about Follow-ups', exact: true }).click()
    const panel = page.getByTestId('dashboard-chat-panel')
    // Low on the row and right of its text: the hover bar floats over the top of the first row.
    const box = (await row.boundingBox())!
    await row.click({ position: { x: box.width - 12, y: box.height - 4 } })
    await expect(panel.getByTestId('dashboard-context-chip')).toHaveText('Follow-ups · 1 selected')
    const composer = panel.getByRole('combobox', { name: 'Type a message...', exact: true })
    await composer.fill(PANEL_QUESTION)
    await composer.press('Enter')

    const started = Date.now()
    const asks: string[] = []
    let reply = ''
    await expect.poll(async () => {
      const allow = page.getByRole('button', { name: 'Allow once', exact: true })
      if (await allow.count() > 0) {
        asks.push((await allow.first().locator('xpath=ancestor::*[4]').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300))
        await allow.first().click().catch(() => undefined)
        return 'asked'
      }
      const chat = (await page.evaluate(() => window.api.chat.list())).find((c) => c.originDashboardId)
      if (!chat) return 'no panel chat yet'
      const full = await page.evaluate((id) => window.api.chat.get(id), chat.id)
      const messages = full?.messages ?? []
      const last = messages[messages.length - 1]
      if (full?.activeRunId || last?.role !== 'assistant' || !last.content) return 'running'
      reply = last.content
      return 'done'
    }, { timeout: 5 * 60_000, intervals: [1000], message: 'the panel turn ends' }).toBe('done')
    console.log(`live-dashboards ${entry}: panel turn took ${Math.round((Date.now() - started) / 1000)} s, ${asks.length} permission ask(s); reply:\n${reply}`)
    await page.screenshot({ path: test.info().outputPath('panel-reply.png') })

    expect(PANEL_QUESTION).not.toContain('Marisol')
    expect(reply, 'the reply names the selected item').toMatch(/Marisol/)
    expect(reply, 'the reply names the selected item').toMatch(/Q3 forecast/i)
    for (const other of FOLLOW_UPS.filter((f) => f !== SELECTED)) expect(reply, `not about ${other.title}`).not.toContain(other.title)
  })
})

/** A piece of text the tile draws for this result: a list item's title, a table cell, or a word run from the markdown. */
function visibleText(view: string | null, data: unknown, source: unknown, dir: string): string {
  const d = data as Record<string, unknown> | string | null
  if (view === 'list' && d && typeof d === 'object' && Array.isArray(d.items)) {
    const item = d.items.find((i) => i && typeof (i as { title?: unknown }).title === 'string') as { title: string } | undefined
    return item?.title ?? ''
  }
  let markdown = typeof d === 'string' ? d : d && typeof d === 'object' && typeof d.markdown === 'string' ? d.markdown : ''
  const file = source && typeof source === 'object' ? (source as { file?: unknown }).file : null
  if (markdown === '' && typeof file === 'string' && existsSync(join(dir, file))) markdown = readFileSync(join(dir, file), 'utf8')
  // A plain run of words from a body line: no markdown punctuation, so the rendered text holds it verbatim.
  for (const line of markdown.split('\n')) {
    const match = /[A-Za-z][A-Za-z0-9 ,']{8,}[A-Za-z0-9]/.exec(line.replace(/^\s*(#+|[-*+]|\d+\.|>)\s*/, ''))
    if (match && !/^\s*```/.test(line)) return match[0].trim()
  }
  return ''
}
