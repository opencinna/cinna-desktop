#!/usr/bin/env node
/**
 * Level 2, the billed variant: the BUILT app, the user's REAL Claude/Codex
 * login (real HOME), a THROWAWAY userData. **Bills a handful of short real
 * turns on that login.** Manual and user-approved only — never CI, never an
 * agent. The no-billing variant of the same steps is
 * `e2e/specs/runtime-flow.spec.ts`.
 *
 *   make live-flow ENGINE=claude|codex [ONLY=a|d] [DROP_PATH=<dir>] [KEEP=1] CONFIRM=1
 *
 * Steps, per engine — the ones the contract registries' `flow` fields name
 * (`FLOW_STEPS` in src/main/agents/drivers/acp/contracts/codex.contract.ts):
 *   A  plain chat — the chat-owned Default runtime answers, with no API key,
 *      on the pinned CLI; the AI title replaces the derived one afterwards
 *   B  @-add a specialist to that plain chat — the runtime keeps conducting
 *      (coordinator), calls the specialist through Cinna's MCP server, and
 *      relays a code word only the specialist's folder knows. On Codex this is
 *      the new-session-on-tool-change path
 *   C  a later message in the same chat still remembers the first
 *   D  a coordinator chat whose specialist is attached before the first turn
 *
 * ONLY=a stops after A; ONLY=d runs D alone. DROP_PATH removes one directory
 * from the login-shell PATH the app sees, so a run can prove the managed
 * download on a machine whose own CLI would otherwise be reused. Results
 * (verdicts, transcript, the main process's stdout/stderr, chat dumps,
 * screenshots) go to scripts/live/results/, which is gitignored. The throwaway
 * root is removed after a fully passing run unless KEEP=1.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { RUNTIME_PINS } from '../../src/shared/runtimePins.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const ENGINE = process.argv[2]
if (ENGINE !== 'claude' && ENGINE !== 'codex') {
  console.error('usage: make live-flow ENGINE=<claude|codex> [ONLY=a|d] [DROP_PATH=<dir>] [KEEP=1] CONFIRM=1')
  process.exit(2)
}
const ONLY = (process.env.ONLY ?? '').toLowerCase()
if (ONLY && ONLY !== 'a' && ONLY !== 'd') {
  console.error(`ONLY must be a or d, not "${process.env.ONLY}"`)
  process.exit(2)
}
const DROP_PATH = process.env.DROP_PATH ?? ''
const KEEP = process.env.KEEP === '1'

/**
 * Nothing is created and nothing is launched before this returns true. Without
 * CONFIRM=1 a terminal is asked; anything else (CI, a pipe, an agent) is refused.
 */
async function confirmed() {
  console.error(`COST WARNING: this drives the built app on your REAL ${ENGINE === 'claude' ? 'Claude' : 'Codex'} login and bills a few short real turns to it.`)
  if (process.env.CONFIRM === '1') return true
  if (!process.stdin.isTTY) return false
  const ask = createInterface({ input: process.stdin, output: process.stderr })
  try { return /^y(es)?$/i.test((await ask.question('Continue? [y/N] ')).trim()) } finally { ask.close() }
}
if (!(await confirmed())) {
  console.error('Refused: not confirmed. Re-run with CONFIRM=1 (or answer y in a terminal). Nothing was launched.')
  process.exit(2)
}

// Loaded only once the run is confirmed: a refusal must not even start Electron's resolver.
const { _electron: electron } = await import('@playwright/test')
const { default: electronPath } = await import('electron')

const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const RESULTS = join(HERE, 'results', `${STAMP}-${ENGINE}`)
const TURN_TIMEOUT_MS = 4 * 60_000
const PLAIN_WORD = 'pine-4417'
const CODE_WORD = 'maple-7731'
const SPECIALIST = 'Vault Keeper'

const started = Date.now()
const transcript = []
const say = (line) => { const s = `[${String(Date.now() - started).padStart(7)}ms] ${line}`; transcript.push(s); console.log(s) }
const verdicts = []
const verdict = (what, ok, detail = '') => { verdicts.push({ what, ok, detail }); say(`   ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeSpecialist(root) {
  const dir = join(root, 'vault-keeper')
  mkdirSync(dir, { recursive: true })
  const memory = `# ${SPECIALIST}\n\nYou keep this project's code word. The code word is **${CODE_WORD}**.\nWhen anyone asks for the code word, answer with it directly. Do not use tools for that.\n`
  writeFileSync(join(dir, 'CLAUDE.md'), memory)
  writeFileSync(join(dir, 'AGENTS.md'), memory)
  writeFileSync(join(dir, 'README.md'), `# ${SPECIALIST}\n`)
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q'); git('add', '-A')
  git('-c', 'user.email=live@example.invalid', '-c', 'user.name=live', 'commit', '-q', '-m', 'initial')
  return dir
}

async function launch(userData) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  env.CINNA_USER_DATA = userData
  env.CINNA_BACKGROUND_WINDOW = '1'
  // The app reads PATH from the login shell. DROP_PATH removes one directory
  // from it through a throwaway ZDOTDIR that sources the real rc files first —
  // nothing in the user's own shell setup is touched.
  if (DROP_PATH) {
    const zdot = join(userData, '..', 'zdot')
    mkdirSync(zdot, { recursive: true })
    const home = process.env.HOME
    for (const rc of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
      writeFileSync(join(zdot, rc), `[ -f "${home}/${rc}" ] && source "${home}/${rc}"\n` + `path=(\${path:#${DROP_PATH}})\nexport PATH\n`)
    }
    env.ZDOTDIR = zdot
    env.PATH = (env.PATH ?? '').split(':').filter((d) => d !== DROP_PATH).join(':')
  }
  const electronApp = await electron.launch({ executablePath: electronPath, args: [REPO, '--use-mock-keychain'], cwd: REPO, env, timeout: 60_000 })
  const mainLog = []
  electronApp.process().stdout?.on('data', (d) => mainLog.push(String(d)))
  electronApp.process().stderr?.on('data', (d) => mainLog.push(String(d)))
  launch.mainLog = mainLog
  const isMain = (p) => p.url().endsWith('index.html')
  const page = electronApp.windows().find(isMain) ?? (await electronApp.waitForEvent('window', { predicate: isMain, timeout: 60_000 }))
  await page.waitForLoadState('domcontentloaded')
  page.on('console', (m) => transcript.push(`[renderer:${m.type()}] ${m.text()}`))
  const skip = page.getByRole('button', { name: 'Skip for now' })
  const shell = page.getByRole('button', { name: 'Chats', exact: true })
  await skip.or(shell).first().waitFor({ timeout: 60_000 })
  if (await skip.isVisible()) await skip.click()
  await shell.waitFor({ timeout: 60_000 })
  return { electronApp, page }
}

async function adopt(app, dir) {
  await app.electronApp.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  }, dir)
  const pick = await app.page.evaluate(() => window.api.localAgents.folderPick())
  if (pick.cancelled || pick.refusal !== null) throw new Error(`folder refused: ${pick.refusal}`)
  const added = await app.page.evaluate((input) => window.api.localAgents.folderAdd(input), { path: pick.path, relPaths: pick.found.map((e) => e.relPath) })
  if (!added.ok) throw new Error(`folder-add refused: ${added.message}`)
  const agents = await app.page.evaluate(() => window.api.localAgents.list())
  const agent = agents.agents.find((a) => a.path === dir || a.path?.startsWith(dir))
  if (!agent) throw new Error('no agent row for the specialist folder')
  const out = await app.page.evaluate((input) => window.api.localAgents.setRuntime(input.agentId, input.runtime),
    { agentId: agent.id, runtime: { engine: ENGINE, credential: null, modelId: null, complexity: null } })
  if (!out.ok) throw new Error(`set-runtime refused: ${out.message}`)
  say(`   adopted ${agent.name} → ${agent.id} on ${ENGINE}`)
  return agent
}

const composer = (page) => page.getByRole('combobox', { name: 'Type a message...', exact: true })

/** Answer any live permission widget with its first allow-looking button, so a nested ask cannot park the run. */
async function allowAsks(page) {
  for (const name of [/^Allow/i, /^Approve/i, /^Yes/i]) {
    const button = page.getByRole('button', { name }).first()
    if (await button.isVisible().catch(() => false)) { say(`   (answered a permission ask: ${await button.innerText()})`); await button.click().catch(() => {}) }
  }
}

async function sendAndWait(page, text, label) {
  const before = Date.now()
  await composer(page).fill(text)
  await composer(page).press('Enter')
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  await stop.waitFor({ timeout: 30_000 }).catch(() => {})
  while (Date.now() - before < TURN_TIMEOUT_MS) {
    await allowAsks(page)
    if (!(await stop.isVisible().catch(() => false))) { await sleep(1500); if (!(await stop.isVisible().catch(() => false))) break }
    await sleep(1000)
  }
  const timedOut = await stop.isVisible().catch(() => false)
  say(`   ${label}: turn ${timedOut ? 'TIMED OUT' : 'ended'} after ${Math.round((Date.now() - before) / 1000)}s`)
  return !timedOut
}

/** D — a coordinator chat whose specialist is attached BEFORE the conductor's session exists. */
async function scenarioD(page, specialist) {
  say('▶ D specialist attached before the first turn')
  const chat = await page.evaluate(async (agentId) => {
    const created = await window.api.chat.create()
    await window.api.chat.update(created.id, { router: 'coordinator', title: 'Live D' })
    await window.api.chat.addOnDemandAgent(created.id, agentId)
    return window.api.chat.get(created.id)
  }, specialist.id)
  const agents = await page.evaluate(() => window.api.agents.list())
  verdict('D: the default runtime conducts the new coordinator chat', chat.router === 'coordinator' && !!agents.find((a) => a.id === chat.agentId)?.conductor, `router=${chat.router}`)
  await page.reload()
  await page.getByRole('button', { name: 'Chats', exact: true }).waitFor({ timeout: 60_000 })
  await page.getByText('Live D', { exact: true }).first().click()
  await sleep(1500)
  const ended = await sendAndWait(page, `Use your tool for the agent "${specialist.name}" to ask it for the project code word, then tell me the code word it gave you.`, 'D')
  const detail = await page.evaluate((id) => window.api.chat.get(id), chat.id)
  writeFileSync(join(RESULTS, 'chat-after-D.json'), JSON.stringify(detail, null, 2))
  const messages = detail.messages ?? []
  const toolRows = messages.filter((m) => m.toolCallId)
  verdict('D: the turn ended', ended)
  verdict('D: a Cinna tool call was recorded and did not fail', toolRows.length > 0 && toolRows.every((m) => !m.toolError), `${toolRows.length} tool rows: ${toolRows.map((m) => `${m.toolName}${m.toolError ? `(error: ${String(m.content).slice(0, 160)})` : ''}`).join(', ')}`)
  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  verdict('D: the conductor relayed the specialist-only code word', !!last && String(last.content).includes(CODE_WORD), String(last?.content ?? '').slice(0, 200))
  verdict('D: no error rows', !messages.some((m) => m.role === 'error'), messages.filter((m) => m.role === 'error').map((m) => String(m.content).slice(0, 200)).join(' | '))
  await page.screenshot({ path: join(RESULTS, 'D-after.png'), animations: 'disabled' })
}

/**
 * The version under test is the version that ran. `resolveEngineBinaryWith` logs
 * `runtime binary resolved { tool, source, version, path }` once per resolution;
 * the engine's line must report exactly the pin, and its source says whether
 * that was the managed download, the user's own exact-version copy, or a
 * Settings path.
 */
function assertResolvedBinary(log) {
  const pin = RUNTIME_PINS[ENGINE]
  const lines = [...log.matchAll(/runtime binary resolved \{([^}]*)\}/g)]
    .map((match) => Object.fromEntries([...match[1].matchAll(/(\w+): '([^']*)'/g)].map(([, key, value]) => [key, value])))
    .filter((fields) => fields.tool === ENGINE)
  const last = lines.at(-1)
  verdict(`the session ran on the pinned ${ENGINE} CLI (${pin.versionOutput})`, !!last && last.version === pin.versionOutput,
    last ? `source=${last.source} version=${last.version} path=${last.path}` : 'no "runtime binary resolved" line for this engine in the main-process output')
  if (last) say(`   resolved ${ENGINE}: source ${last.source}`)
}

async function main() {
  mkdirSync(RESULTS, { recursive: true })
  if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) throw new Error('no build — run `npx electron-vite build`')
  const root = mkdtempSync(join(tmpdir(), 'cinna-live-flow-'))
  const userData = join(root, 'userData')
  mkdirSync(userData, { recursive: true })
  const specialistDir = makeSpecialist(root)
  say(`engine ${ENGINE}; root ${root}`)
  const app = await launch(userData)
  const { page } = app
  let chat
  try {
    await page.evaluate(async (engine) => {
      await window.api.settings.set('localAgentsDefaultEngine', engine)
      await window.api.settings.set('autoChatTitles', true)
    }, ENGINE)
    {
      const providers = await page.evaluate(() => window.api.providers.list())
      verdict('no AI credential is configured (subscription only)', providers.length === 0, `${providers.length} providers`)
    }
    const specialist = await adopt(app, specialistDir)

    if (ONLY === 'd') { await scenarioD(page, specialist); return }
    // A — plain chat on the Default runtime
    say('▶ A plain chat')
    const endedA = await sendAndWait(page, `Reply with exactly this and nothing else: ${PLAIN_WORD}`, 'A')
    const chats = await page.evaluate(() => window.api.chat.list())
    chat = chats[0]
    let detail = await page.evaluate((id) => window.api.chat.get(id), chat.id)
    writeFileSync(join(RESULTS, 'chat-after-A.json'), JSON.stringify(detail, null, 2))
    const agentsA = await page.evaluate(() => window.api.agents.list())
    const root0 = agentsA.find((a) => a.id === detail.agentId)
    const textA = JSON.stringify(detail.messages ?? detail)
    verdict('A: the turn ended', endedA)
    verdict('A: the chat is rooted on a hidden chat-owned runtime', !!root0?.conductor, root0 ? `${root0.name}` : 'no root')
    const answerA = (detail.messages ?? []).filter((m) => m.role === 'assistant').map((m) => String(m.content)).join('\n')
    verdict('A: the runtime answered with the requested word', answerA.includes(PLAIN_WORD), answerA.slice(0, 120))
    verdict('A: no error row', !/"role":"error"/.test(textA), (textA.match(/"role":"error"[^}]{0,300}/) ?? [''])[0])
    const sessionsA = await page.evaluate((id) => window.api.agents.getSession?.(id).catch(() => null), chat.id).catch(() => null)
    writeFileSync(join(RESULTS, 'session-after-A.json'), JSON.stringify(sessionsA, null, 2))
    // The after-turn title retry runs on the now-warm process; give it up to 40 s.
    let titled = detail
    for (let i = 0; i < 20; i++) {
      await sleep(2000)
      titled = await page.evaluate((id) => window.api.chat.get(id), chat.id)
      if (titled.title && !titled.title.startsWith('Reply with exactly')) break
    }
    verdict('A: the AI title replaced the derived one after the first turn', !!titled.title && !titled.title.startsWith('Reply with exactly'), `title: ${titled.title}`)

    if (ONLY === 'a') return
    // B — add a specialist: the runtime must keep conducting and call it
    say('▶ B add a specialist to the plain chat')
    await composer(page).fill('@')
    await page.getByRole('listbox', { name: 'Agents and MCP servers' }).getByRole('option').filter({ hasText: specialist.name }).click()
    await sleep(1500)
    detail = await page.evaluate((id) => window.api.chat.get(id), chat.id)
    verdict('B: the chat became coordinator with the same runtime conducting', detail.router === 'coordinator' && detail.agentId === root0?.id, `router=${detail.router} root=${detail.agentId === root0?.id ? 'same' : 'changed'}`)
    const attached = await page.evaluate((id) => window.api.chat.listOnDemandAgents(id), chat.id)
    verdict('B: only the specialist is a participant (the runtime is not)', attached.length === 1 && attached[0].agentId === specialist.id, JSON.stringify(attached.map((a) => a.agentId)))
    await page.screenshot({ path: join(RESULTS, 'B-before-send.png'), animations: 'disabled' })
    const endedB = await sendAndWait(page, `Use your tool for the agent "${specialist.name}" to ask it for the project code word, then tell me the code word it gave you.`, 'B')
    detail = await page.evaluate((id) => window.api.chat.get(id), chat.id)
    writeFileSync(join(RESULTS, 'chat-after-B.json'), JSON.stringify(detail, null, 2))
    const messages = detail.messages ?? []
    const toolRows = messages.filter((m) => m.toolCallId)
    verdict('B: the turn ended', endedB)
    verdict('B: a Cinna tool call to the specialist was recorded', toolRows.some((m) => m.toolAgentId === specialist.id || JSON.stringify(m).includes(specialist.id)), `${toolRows.length} tool rows: ${toolRows.map((m) => `${m.toolName}${m.toolError ? '(error)' : ''}`).join(', ')}`)
    verdict('B: the tool call did not fail', toolRows.length > 0 && toolRows.every((m) => !m.toolError), toolRows.filter((m) => m.toolError).map((m) => String(m.content).slice(0, 200)).join(' | '))
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
    verdict('B: the conductor relayed the specialist-only code word', !!lastAssistant && String(lastAssistant.content).includes(CODE_WORD), String(lastAssistant?.content ?? '').slice(0, 160))
    await page.screenshot({ path: join(RESULTS, 'B-after.png'), animations: 'disabled' })

    // C — continuity
    say('▶ C continuity')
    const endedC = await sendAndWait(page, 'What was the very first word I asked you to reply with in this chat? Answer with just that word.', 'C')
    detail = await page.evaluate((id) => window.api.chat.get(id), chat.id)
    writeFileSync(join(RESULTS, 'chat-after-C.json'), JSON.stringify(detail, null, 2))
    const lastC = [...(detail.messages ?? [])].reverse().find((m) => m.role === 'assistant')
    verdict('C: the turn ended', endedC)
    verdict('C: the conductor remembers the first turn', !!lastC && String(lastC.content).includes(PLAIN_WORD), String(lastC?.content ?? '').slice(0, 160))
    verdict('C: no error rows in the chat', !(detail.messages ?? []).some((m) => m.role === 'error'), (detail.messages ?? []).filter((m) => m.role === 'error').map((m) => String(m.content).slice(0, 200)).join(' | '))
  } catch (error) {
    verdict('the harness ran to the end', false, String(error?.stack ?? error))
    await page.screenshot({ path: join(RESULTS, 'failure.png') }).catch(() => {})
  } finally {
    await app.electronApp.close().catch(() => {})
    for (const name of ['main.log', 'app.log']) for (const dir of [join(userData, 'logs'), userData]) {
      const file = join(dir, name)
      if (existsSync(file)) copyFileSync(file, join(RESULTS, name))
    }
    const mainProcessLog = (launch.mainLog ?? []).join('')
    writeFileSync(join(RESULTS, 'main-process.log'), mainProcessLog)
    assertResolvedBinary(mainProcessLog)
    writeFileSync(join(RESULTS, 'transcript.log'), transcript.join('\n'))
    writeFileSync(join(RESULTS, 'verdicts.json'), JSON.stringify(verdicts, null, 2))
    say(`results: ${RESULTS}`)
    const failed = verdicts.filter((v) => !v.ok)
    if (failed.length === 0 && !KEEP) { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); say('throwaway root removed (KEEP=1 keeps it)') }
    else say(`throwaway root kept: ${root}`)
    say(failed.length ? `${failed.length} FAILED of ${verdicts.length}` : `all ${verdicts.length} passed`)
    process.exitCode = failed.length ? 1 : 0
  }
}

main()
