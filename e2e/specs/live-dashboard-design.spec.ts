import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FrameLocator, Locator, Page } from '@playwright/test'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { LIVE_REQUESTED, requireLiveKey, seedOpenAiDefaultMode } from '../fixtures/live'
import { liveEngineFor, type LiveEngine } from '../fixtures/liveEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import type { LocalAgentRuntimeInput } from '../../src/shared/engine'

/**
 * @live — **the dashboard design pack on real agents**: a kit agent asked in
 * one message, as a person would, for two chart components finds the
 * desktop's design pack from its prompt alone (`cinnaDashboardsSection` names
 * `DESIGN.md` and `example/` by absolute path) and builds on it. The message
 * never names the pack, `DESIGN.md` or `_cinna`.
 *
 * Checked per engine:
 * - (a) no permission ask touched `dashboard-design` (each engine has read access);
 * - (b) a tool step read `DESIGN.md` or the example;
 * - (c) every `view: html` component links `_cinna/ui.css` and `_cinna/charts.js`
 *   and its html/css/js (outside `api/`, comments stripped) holds no `#hex`,
 *   `rgb(` or `hsl(` literal; `var(--cinna-…, <literal>)` fallbacks are reported only;
 * - (d) the kit's `check_component.py` passes on each component;
 * - (e) two valid component cards render in the transcript;
 * - (f) one html card added to a dashboard draws a tile whose frame has
 *   `window.CinnaCharts`, an `svg` in `.cinna-chart`, and a body background equal
 *   to the host's `--cinna-bg` (`--color-bg`);
 * - (g) after Interface → Switch to light/dark, the frame's `--cinna-bg` follows.
 *
 * Engines: `CINNA_E2E_LIVE_DESIGN_ENGINES`, a comma list of `claude`, `codex`,
 * `antigravity`, `opencode` (unset: `opencode`). Each at a medium effort:
 * Claude `sonnet` with `effort: medium` on the developer's login; Codex its
 * configured model with `complexity: medium` (reasoning effort medium);
 * Antigravity `gemini-3.8-flash-medium` (the effort is in the model id);
 * OpenCode `gpt-5.6-luna` on `.env`'s key — the desktop sets no effort on
 * OpenCode, so it runs at its default. Every permission ask is answered Allow
 * once and recorded.
 *
 * Artifacts per run (test output folder, copied to
 * `drafts/dashboard-design-pack/live/<engine>/`): `transcript.md`,
 * `asks.json`, `results.json`, `components/`, `tile-dark.png`, `tile-light.png`.
 *
 * Cost: one building turn of a dozen or more tool calls per engine.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CHECK_SCRIPT = join(REPO, 'resources', 'cinna-agent-kit', 'skills', 'cinna-dashboards', 'scripts', 'check_component.py')
const DRAFTS = join(REPO, 'drafts', 'dashboard-design-pack', 'live')

const AGENT = 'Shop Pulse'
const DESCRIPTION = 'Tracks how my online shop is doing and shows it to me.'
const PROMPT = [
  'Build me two dashboard components for my shop, each with its own data endpoint returning sample data.',
  'First: weekly revenue by channel (web, marketplace, retail) for the last 12 weeks as a line chart.',
  'Second: a KPI row with this week’s signups, orders and revenue, above a bar chart of weekly signups for the last 12 weeks.',
  'Check each component, then print a reference for each.'
].join(' ')

interface DesignEngine { entry: string; engine: LiveEngine; runtime: LocalAgentRuntimeInput | null; effort: string }

function designEngine(entry: string): DesignEngine {
  if (entry === 'claude') {
    return { entry, engine: liveEngineFor('claude', 'sonnet'), runtime: { engine: 'claude', credential: null, modelId: 'sonnet', complexity: null, effort: 'medium' }, effort: 'medium (runtime.effort beside model sonnet)' }
  }
  if (entry === 'codex') {
    return { entry, engine: liveEngineFor('codex', ''), runtime: { engine: 'codex', credential: null, modelId: null, complexity: 'medium' }, effort: 'medium (complexity medium; the CLI’s configured model)' }
  }
  if (entry === 'antigravity') {
    const engine = liveEngineFor('antigravity', 'gemini-3.8-flash-medium')
    return { entry, engine, runtime: engine.runtime, effort: 'medium (gemini-3.8-flash-medium)' }
  }
  if (entry === 'opencode') return { entry, engine: liveEngineFor('opencode', ''), runtime: null, effort: 'none set (OpenCode default)' }
  throw new Error(`CINNA_E2E_LIVE_DESIGN_ENGINES: unknown entry "${entry}" (claude, codex, antigravity, opencode)`)
}

const ENGINES: DesignEngine[] = ((process.env.CINNA_E2E_LIVE_DESIGN_ENGINES ?? '').trim() || 'opencode')
  .split(',').map((raw) => raw.trim()).filter(Boolean).map(designEngine)

const REFERENCE_LINE = /^\s*cinna:\/\/component\/\S+\s*$/gm

/** Component folders the agent made: each `dashboards/<name>/` holding a `component.json`. */
function componentFolders(dir: string): string[] {
  const root = join(dir, 'dashboards')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'component.json')))
    .map((entry) => entry.name)
    .sort()
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/** Comments out: `<!-- -->`, `/* *\/`, and `//` line comments not part of a URL. */
function stripComments(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
}

const FALLBACK = /var\(\s*--cinna-[\w-]+\s*,([^()]*(?:\([^()]*\)[^()]*)*)\)/g
const LITERAL = /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/gi

interface ColourScan { literals: string[]; fallbacks: string[] }

function scanColours(file: string, text: string): ColourScan {
  const clean = stripComments(text)
  const fallbacks: string[] = []
  const rest = clean.replace(FALLBACK, (whole, inner: string) => {
    if (new RegExp(LITERAL.source, 'i').test(inner)) fallbacks.push(`${file}: ${whole.trim()}`)
    return ' '
  })
  const literals: string[] = []
  for (const line of rest.split('\n')) {
    const hits = line.match(LITERAL)
    if (hits) literals.push(`${file}: ${hits.join(' ')} — ${line.trim().slice(0, 160)}`)
  }
  return { literals, fallbacks }
}

interface ComponentReport {
  name: string
  view: string | null
  entry: string | null
  linksUi: boolean | null
  linksCharts: boolean | null
  literals: string[]
  fallbacks: string[]
  check: { status: number | null; output: string }
  checkRun: { status: number | null; output: string }
  usesCharts: boolean
}

function inspectComponent(agentDir: string, name: string): ComponentReport {
  const folder = join(agentDir, 'dashboards', name)
  let spec: { view?: string; entry?: string } = {}
  try { spec = JSON.parse(readFileSync(join(folder, 'component.json'), 'utf8')) } catch { /* reported by the check */ }
  const view = typeof spec.view === 'string' ? spec.view : null
  const entry = view === 'html' ? (typeof spec.entry === 'string' ? spec.entry : 'index.html') : null
  const files = filesUnder(folder).filter((f) => /\.(html?|css|m?js)$/i.test(f))
  const literals: string[] = []
  const fallbacks: string[] = []
  let usesCharts = false
  for (const file of files) {
    const rel = relative(folder, file)
    const text = readFileSync(file, 'utf8')
    if (/\bCinnaCharts\b/.test(stripComments(text))) usesCharts = true
    if (rel.startsWith('api/')) continue
    const scan = scanColours(rel, text)
    literals.push(...scan.literals)
    fallbacks.push(...scan.fallbacks)
  }
  let linksUi: boolean | null = null
  let linksCharts: boolean | null = null
  if (entry !== null) {
    const page = existsSync(join(folder, entry)) ? stripComments(readFileSync(join(folder, entry), 'utf8')) : ''
    linksUi = /href\s*=\s*["']\.?\/?_cinna\/ui\.css["']/.test(page)
    linksCharts = /src\s*=\s*["']\.?\/?_cinna\/charts\.js["']/.test(page)
  }
  const run = (extra: string[]): { status: number | null; output: string } => {
    const out = spawnSync('uv', ['run', 'python', CHECK_SCRIPT, `dashboards/${name}`, ...extra], { cwd: agentDir, encoding: 'utf8', timeout: 120_000 })
    return { status: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}`.trim() }
  }
  return { name, view, entry, linksUi, linksCharts, literals, fallbacks, check: run([]), checkRun: run(['--run']), usesCharts }
}

/** Every tool step as one string: `tool_call` rows (OpenCode) and `tool` parts (the ACP engines). */
function toolSteps(messages: Array<{ role: string; toolName?: string | null; toolInput?: unknown; parts?: Array<{ kind: string }> | null }>): string[] {
  return messages.flatMap((m) => [
    ...(m.role === 'tool_call' ? [`${m.toolName ?? ''} ${JSON.stringify(m.toolInput ?? {})}`] : []),
    ...(m.parts ?? []).filter((part) => part.kind === 'tool').map((part) => JSON.stringify(part))
  ])
}

async function transcript(page: Page, chatId: string): Promise<string> {
  const chat = await page.evaluate((id) => window.api.chat.get(id), chatId)
  if (!chat) return '(no chat)'
  return chat.messages.map((m) => {
    if (m.role === 'tool_call') return `**tool_call ${m.toolName}**${m.toolError ? ' ERROR' : ''}\n\`\`\`json\n${JSON.stringify(m.toolInput ?? {}, null, 2).slice(0, 3000)}\n\`\`\`\n→ ${(m.content ?? '').slice(0, 800)}`
    const tools = (m.parts ?? []).filter((part) => part.kind === 'tool' || part.kind === 'tool_result')
      .map((part) => part.kind === 'tool' ? `  - tool ${part.toolName}: ${JSON.stringify(part.toolInput ?? {}).slice(0, 1200)}` : `    → ${part.text.slice(0, 400).replace(/\n/g, ' ⏎ ')}`)
    return `**${m.role}**: ${m.content ?? ''}${tools.length > 0 ? `\n\n<tools>\n${tools.join('\n')}\n</tools>` : ''}`
  }).join('\n\n')
}

/** Send `prompt` in the open new-chat composer and wait for the turn to end, answering every ask Allow once. */
async function buildTurn(cinna: CinnaApp, prompt: string, asks: string[]): Promise<string> {
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
      const text = (await allow.first().locator('xpath=ancestor::*[4]').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 800)
      await allow.first().click().catch(() => undefined)
      asks.push(text)
      return 'asked'
    }
    const chat = await page.evaluate((id) => window.api.chat.get(id), chatId)
    const messages = chat?.messages ?? []
    const last = messages[messages.length - 1]
    if (chat?.activeRunId || messages.length < 2 || last?.role !== 'assistant' || !last.content) return 'running'
    return 'done'
  }, { timeout: 15 * 60_000, intervals: [1000], message: 'the building turn ends' }).toBe('done')
  return chatId!
}

/** The host's `--color-bg` (what it sends as `--cinna-bg`) as a computed colour. */
async function hostBg(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.background = 'var(--color-bg)'
    document.body.appendChild(probe)
    const colour = getComputedStyle(probe).backgroundColor
    probe.remove()
    return colour
  })
}

interface FrameState { charts: string; svgs: number; bodyBg: string; cinnaBg: string; rawCinnaBg: string }

async function frameState(frame: FrameLocator): Promise<FrameState> {
  return frame.locator('html').evaluate(() => {
    const probe = document.createElement('div')
    probe.style.background = 'var(--cinna-bg)'
    document.body.appendChild(probe)
    const cinnaBg = getComputedStyle(probe).backgroundColor
    probe.remove()
    return {
      charts: typeof (window as unknown as { CinnaCharts?: unknown }).CinnaCharts,
      svgs: document.querySelectorAll('.cinna-chart svg').length,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      cinnaBg,
      rawCinnaBg: getComputedStyle(document.documentElement).getPropertyValue('--cinna-bg').trim()
    }
  })
}

async function currentTheme(page: Page): Promise<string> {
  return (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) ?? 'unknown'
}

/** Interface → Switch to light / Switch to dark, as a person switches it. */
async function switchTheme(page: Page): Promise<void> {
  const before = await currentTheme(page)
  await page.getByRole('button', { name: 'Interface', exact: true }).click()
  await page.getByRole('button', { name: before === 'dark' ? 'Switch to light' : 'Switch to dark', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('html')).toHaveAttribute('data-theme', before === 'dark' ? 'light' : 'dark')
}

test.beforeEach(() => {
  test.skip(!LIVE_REQUESTED, 'live specs run only through make e2e-live or make e2e-one SPEC=<live spec>')
})

for (const { entry, engine, runtime, effort } of ENGINES) test.describe(`on ${entry}`, () => {
  test.use({
    engine: true,
    realLogin: engine.realLogin,
    liveEngineCheck: { engine: engine.name, binary: engine.realLogin?.binary ?? null }
  })

  test(`[${entry}] two chart components asked for in one message are built on the design pack`, async ({ cinna }) => {
    test.setTimeout(30 * 60_000)
    if (engine.name === 'opencode') requireLiveKey()
    test.skip(engine.skipReason !== null, engine.skipReason ?? '')
    const out = (name: string): string => test.info().outputPath(name)
    const results: Record<string, unknown> = { engine: engine.label, effort, runtime }
    const asks: string[] = []
    let agentDir = ''
    let chatId = ''

    try {
      await cinna.skipOnboarding()
      if (engine.name === 'opencode') results.chatMode = await seedOpenAiDefaultMode(cinna)
      await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
      const root = await addAgentRoot(cinna)
      const agent = await createFolderAgent(cinna, root, AGENT, DESCRIPTION)
      agentDir = agent.path!
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
      await cinna.relaunch()
      await cinna.skipOnboarding()
      await cinna.page.evaluate(() => window.api.localAgents.rescan())

      await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
      await answerAgentsFolder(cinna)
      await cinna.page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()

      const started = Date.now()
      try {
        chatId = await buildTurn(cinna, PROMPT, asks)
      } finally {
        results.turnSeconds = Math.round((Date.now() - started) / 1000)
        console.log(`live-dashboard-design ${entry}: turn took ${results.turnSeconds} s, ${asks.length} ask(s)`)
      }

      const page = cinna.page
      const chat = (await page.evaluate((id) => window.api.chat.get(id), chatId))!
      const steps = toolSteps(chat.messages)
      const designReads = steps.filter((s) => /DESIGN\.md/.test(s)).map((s) => s.slice(0, 400))
      const exampleUses = steps.filter((s) => /dashboard-design[\\/]+example/.test(s)).map((s) => s.slice(0, 400))
      // An ask for a chained command (`;`, `&&`, `||`, a pipe, a newline) is the
      // engine's rule for every chain, whatever it touches, not missing pack
      // access: Antigravity sends `mkdir -p dashboards && cp -R <pack>/example …`
      // to the owner by design. Only a single command naming the pack counts.
      const chained = (ask: string): boolean => /;|&&|\|\||\||\\n/.test(ask.replace(/\\"[^"]*?\\"/g, ''))
      const packAsks = asks.filter((a) => /dashboard-design/.test(a) && !chained(a))
      const chainedPackAsks = asks.filter((a) => /dashboard-design/.test(a) && chained(a))
      for (const ask of chainedPackAsks) console.log(`  chained ask on the pack (engine rule, not counted): ${ask.slice(0, 200)}`)
      const folders = componentFolders(agentDir)
      const components = folders.map((name) => inspectComponent(agentDir, name))
      Object.assign(results, { asks, packAsks, designReads, exampleUses, folders, components })
      console.log(`live-dashboard-design ${entry}: folders ${JSON.stringify(folders)}; DESIGN.md steps ${designReads.length}; example steps ${exampleUses.length}`)
      for (const c of components) {
        console.log(`  ${c.name}: view ${c.view}, ui.css ${c.linksUi}, charts.js ${c.linksCharts}, CinnaCharts used ${c.usesCharts}, check ${c.check.status}, check --run ${c.checkRun.status}`)
        for (const l of c.literals) console.log(`    literal ${l}`)
        for (const f of c.fallbacks) console.log(`    fallback ${f}`)
        if (c.check.status !== 0) console.log(`    check output: ${c.check.output.slice(0, 800)}`)
      }
      for (const ask of asks) console.log(`  ask: ${ask}`)

      await test.step('(a) no permission ask touched the design pack', async () => {
        expect.soft(packAsks, 'asks naming dashboard-design').toEqual([])
      })
      await test.step('(b) the agent read DESIGN.md or the example', async () => {
        expect.soft(designReads.length + exampleUses.length, 'tool steps naming DESIGN.md or dashboard-design/example').toBeGreaterThan(0)
      })
      await test.step('(c) every html view links the pack and has no colour literals', async () => {
        expect.soft(folders.length, `two component folders: ${JSON.stringify(folders)}`).toBeGreaterThanOrEqual(2)
        for (const c of components.filter((c) => c.view === 'html')) {
          expect.soft(c.linksUi, `${c.name} links _cinna/ui.css`).toBe(true)
          expect.soft(c.linksCharts, `${c.name} links _cinna/charts.js`).toBe(true)
          expect.soft(c.literals, `${c.name} colour literals`).toEqual([])
        }
      })
      await test.step('(d) check_component.py passes on each component', async () => {
        for (const c of components) expect.soft(c.check.status, `${c.name}: ${c.check.output}`).toBe(0)
      })

      const listed = await page.evaluate((id) => window.api.dashboards.components(id), agent.id)
      await test.step('(e) two valid component cards render', async () => {
        const cards = page.locator('[data-component-cards] [data-component-card]')
        await expect(cards.first()).toBeVisible({ timeout: 30_000 })
        await expect(page.locator('[data-component-card-skeleton]')).toHaveCount(0, { timeout: 30_000 })
        const replies = chat.messages.filter((m) => m.role === 'assistant').map((m) => m.content ?? '').join('\n')
        results.references = [...new Set((replies.match(REFERENCE_LINE) ?? []).map((line) => line.trim()))]
        results.cards = await cards.allInnerTexts()
        expect(await cards.count(), 'one card per printed component').toBeGreaterThanOrEqual(2)
        for (const component of listed.filter((c) => folders.includes(c.name))) {
          const card = page.locator('[data-component-cards]').getByRole('group', { name: `Component ${component.title}`, exact: true }).first()
          await expect.soft(card).toBeVisible()
          await expect.soft(card).not.toContainText('Has problems to fix')
          await expect.soft(card.getByRole('button', { name: `Add ${component.title} to a dashboard`, exact: true })).toBeEnabled()
        }
      })

      const htmlCharted = components.filter((c) => c.view === 'html' && c.usesCharts).map((c) => c.name)
      const chosen = listed.find((c) => c.valid && htmlCharted.includes(c.name))
        ?? listed.find((c) => c.valid && c.view === 'html' && folders.includes(c.name))
      expect(chosen, `a valid html component to add: ${JSON.stringify(listed.map((c) => ({ name: c.name, view: c.view, valid: c.valid })))}`).toBeTruthy()
      const title = chosen!.title
      results.tileComponent = chosen!.name

      const grid = page.getByTestId('dashboard-grid')
      const tile = grid.getByRole('group', { name: title, exact: true }).first()
      const frame = tile.frameLocator('[data-testid="dashboard-frame"]')
      await test.step(`(f) “${title}” added to a dashboard draws its chart on the pack in the host's colours`, async () => {
        const card = page.locator('[data-component-cards]').getByRole('group', { name: `Component ${title}`, exact: true }).first()
        await card.getByRole('button', { name: `Add ${title} to a dashboard`, exact: true }).click()
        const dialog = page.getByRole('dialog', { name: `Add ${title} to a dashboard` })
        await expect(dialog).toBeVisible()
        await dialog.getByRole('button', { name: 'Add', exact: true }).click()
        await expect(dialog).toBeHidden()
        await expect(card).toContainText('On My dashboard')
        await card.getByRole('button', { name: 'My dashboard', exact: true }).click()
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('My dashboard')
        await expect(grid.locator('[data-tile-id]')).toHaveCount(1)
        // The page has drawn: a pack chart, or (a page off the pack) any svg or text at all.
        await expect(frame.locator('html')).toBeAttached({ timeout: 60_000 })
        await expect.poll(async () => (await frameState(frame).catch(() => null))?.svgs ?? 0, { timeout: 90_000, message: 'an svg inside .cinna-chart' }).toBeGreaterThan(0).catch(() => undefined)
        const state = await frameState(frame)
        const host = await hostBg(page)
        results.frameFirst = { theme: await currentTheme(page), host, ...state }
        console.log(`live-dashboard-design ${entry}: frame ${JSON.stringify(results.frameFirst)}`)
        await tile.scrollIntoViewIfNeeded()
        await tile.screenshot({ path: out(`tile-${await currentTheme(page)}.png`), animations: 'disabled' })
        await page.screenshot({ path: out(`dashboard-${await currentTheme(page)}.png`) })
        expect.soft(state.charts, 'window.CinnaCharts in the frame').toBe('object')
        expect.soft(state.svgs, 'svg inside .cinna-chart').toBeGreaterThan(0)
        expect.soft(state.bodyBg, 'the frame body background is the host --cinna-bg').toBe(host)
      })

      await test.step('(g) after a theme switch the frame’s --cinna-bg follows', async () => {
        const before = (results.frameFirst as FrameState).cinnaBg
        await switchTheme(page)
        const host = await hostBg(page)
        expect(host, 'the host background changed with the theme').not.toBe(before)
        await expect.poll(async () => (await frameState(frame)).cinnaBg, { timeout: 15_000, message: 'the frame --cinna-bg follows the host' }).toBe(host).catch(() => undefined)
        const state = await frameState(frame)
        results.frameSwitched = { theme: await currentTheme(page), host, ...state }
        console.log(`live-dashboard-design ${entry}: switched ${JSON.stringify(results.frameSwitched)}`)
        await tile.screenshot({ path: out(`tile-${await currentTheme(page)}.png`), animations: 'disabled' })
        expect.soft(state.cinnaBg, 'the frame --cinna-bg follows the host').toBe(host)
        expect.soft(state.bodyBg, 'the frame body background follows too').toBe(host)
      })
    } finally {
      writeFileSync(out('asks.json'), JSON.stringify(asks, null, 2))
      const id = chatId || (await cinna.page.evaluate(() => window.api.chat.list()).catch(() => [])).find((row) => row.agentId !== null)?.id
      if (id) {
        writeFileSync(out('transcript.md'), `# ${engine.label} — effort ${effort}\n\n## Permission asks (${asks.length})\n${asks.map((a) => `- ${a}`).join('\n')}\n\n## Chat\n\n${await transcript(cinna.page, id).catch((e) => String(e))}`)
      }
      if (agentDir && existsSync(join(agentDir, 'dashboards'))) {
        cpSync(join(agentDir, 'dashboards'), out('components'), { recursive: true, filter: (src) => !/(node_modules|__pycache__)/.test(src) })
      }
      writeFileSync(out('results.json'), JSON.stringify(results, null, 2))
      const target = join(DRAFTS, entry)
      rmSync(target, { recursive: true, force: true })
      mkdirSync(target, { recursive: true })
      const outDir = test.info().outputDir
      if (existsSync(outDir) && statSync(outDir).isDirectory()) cpSync(outDir, target, { recursive: true })
      console.log(`live-dashboard-design ${entry}: artifacts ${outDir} → ${target}`)
    }
  })
})
