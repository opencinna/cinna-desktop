#!/usr/bin/env node
/**
 * Level 2, the billed variant: the BUILT app, the user's REAL Claude/Codex
 * login (real HOME), a THROWAWAY userData. **Bills a handful of short real
 * turns on that login.** Manual and user-approved only — never CI, never an
 * agent. The no-billing variant of the same steps is
 * `e2e/specs/runtime-flow.spec.ts`.
 *
 *   make live-flow ENGINE=claude|codex [ONLY=a|d|e] [DROP_PATH=<dir>] [KEEP=1] CONFIRM=1
 *
 * Steps, per engine — the ones the contract registries' `flow` fields name
 * (`FLOW_STEPS` in src/main/agents/drivers/acp/contracts/codex.contract.ts):
 *   A  plain chat — the chat-owned Default runtime answers, with no API key,
 *      on the pinned CLI; a title replaces the derived one afterwards (on
 *      Codex its own thread title — Cinna runs no AI title for that chat)
 *   B  @-add a specialist to that plain chat — the runtime keeps conducting
 *      (coordinator), calls the specialist through Cinna's MCP server, and
 *      relays a code word only the specialist's folder knows. On Codex this is
 *      the new-session-on-tool-change path
 *   C  a later message in the same chat still remembers the first
 *   D  a coordinator chat whose specialist is attached before the first turn
 *   E  cancel: (1) Stop a plain chat mid-reply — the turn ends promptly, the
 *      partial reply is kept as an ordinary reply, nothing streams afterwards,
 *      and a follow-up in the same chat is answered; (2) Stop a coordinator
 *      chat while its specialist is inside a slow shell command — the
 *      conductor turn and the specialist's nested run both end, the command's
 *      process is gone, and a follow-up is answered. Each verdict carries the
 *      Stop→end timings and the main-process cancel lines
 *
 * ONLY=a stops after A; ONLY=d runs D alone; ONLY=e runs E alone (D and E run
 * only when asked for). DROP_PATH removes one directory
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
  console.error('usage: make live-flow ENGINE=<claude|codex> [ONLY=a|d|e] [DROP_PATH=<dir>] [KEEP=1] CONFIRM=1')
  process.exit(2)
}
const ONLY = (process.env.ONLY ?? '').toLowerCase()
if (ONLY && ONLY !== 'a' && ONLY !== 'd' && ONLY !== 'e') {
  console.error(`ONLY must be a, d or e, not "${process.env.ONLY}"`)
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
/** E: the slow specialist, and the shell command that keeps its call in flight. An odd duration, so `pgrep -f` finds only ours. */
const SLOW_SPECIALIST = 'Slow Worker'
const SLOW_COMMAND = 'sleep 67'
/** E: each counted line reads `<n>-kiwi`; the prompt holds only `n-kiwi`, so `3-kiwi` on screen is the reply streaming. */
const COUNT_SUFFIX = 'kiwi'
/** E: the Stop→end bounds the brief asks for, and how long to watch for text after the end. */
const PLAIN_STOP_BOUND_MS = 10_000
const CONDUCTOR_STOP_BOUND_MS = 15_000
const QUIET_WATCH_MS = 10_000

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

/** E: a specialist whose one job is a shell command that takes a minute, so Stop lands while its call is in flight. */
function makeSlowWorker(root) {
  const dir = join(root, 'slow-worker')
  mkdirSync(dir, { recursive: true })
  const memory = `# ${SLOW_SPECIALIST}\n\nYou run this project's slow check. When anyone asks you to run the slow check, run exactly this shell command first and wait for it to finish:\n\n    ${SLOW_COMMAND}\n\nOnly after it has finished, reply with exactly: slow check done\n`
  writeFileSync(join(dir, 'CLAUDE.md'), memory)
  writeFileSync(join(dir, 'AGENTS.md'), memory)
  writeFileSync(join(dir, 'README.md'), `# ${SLOW_SPECIALIST}\n`)
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

/*
 * E — cancel. The main process logs every level to stdout as `[scope] message
 * { data }` with no timestamp, so the cancel evidence is read from the chunks
 * captured after a given index, and its timing from when a poll first saw it.
 * `session/cancel` itself is a notification the driver does not log; what it
 * logs is how each ACP turn ended (`ACP turn complete { stopReason }`, `an ACP
 * turn was stopped by the user`, or `did not acknowledge a cancel; its process
 * was retired` when the grace expired).
 */
const mainLogLength = () => (launch.mainLog ?? []).length
const mainLogSince = (from) => (launch.mainLog ?? []).slice(from).join('')
const CANCEL_WORDS = /cancel|stopped|stopping an ACP|ACP turn complete|did not acknowledge|abort|retired|interrupt|Conductor/i
const TURN_END = /ACP turn complete|an ACP turn was stopped|did not acknowledge a cancel|an ACP turn failed|an ACP turn hit the ceiling/
/** One entry per `[scope] message`, its inspected data included even when it spans lines. */
const logEntries = (text) => text.split(/\n(?=\[[\w:.\-/]+\] )/).map((e) => e.trim()).filter(Boolean)
const cancelEntries = (text) => logEntries(text).filter((e) => CANCEL_WORDS.test(e))
const flat = (entry) => entry.replace(/\s+/g, ' ')

/** How the driver says this agent's turn ended, from the log after Stop. */
function cancelAck(text, agentId) {
  const mine = cancelEntries(text).filter((e) => e.includes(agentId))
  const retired = mine.some((e) => /did not acknowledge a cancel/.test(e))
  const complete = mine.find((e) => /ACP turn complete/.test(e))
  const stopReason = complete?.match(/stopReason: '([^']*)'/)?.[1] ?? null
  const byUser = mine.some((e) => /an ACP turn was stopped/.test(e))
  return {
    ok: !retired && (stopReason === 'cancelled' || byUser),
    detail: `${retired ? 'RETIRED (no acknowledgement within the grace); ' : ''}stopReason=${stopReason ?? 'none logged'}; ${mine.map(flat).join(' | ').slice(0, 700) || 'no log entry names this agent after Stop'}`
  }
}

/** The processes running the slow specialist's shell command, if any. */
function commandPids() {
  try { return execFileSync('pgrep', ['-f', SLOW_COMMAND], { encoding: 'utf8' }).trim().split('\n').filter(Boolean) } catch { return [] }
}
function describePids(pids) {
  if (!pids.length) return 'none'
  try { return execFileSync('ps', ['-o', 'pid=,ppid=,etime=,command=', '-p', pids.join(',')], { encoding: 'utf8' }).trim().replace(/\n/g, ' | ') } catch { return pids.join(',') }
}

/** The highest `<n>-kiwi` on screen. The prompt's own `n-kiwi` has no digits. */
const highestCount = (page) => page.evaluate((suffix) =>
  Math.max(0, ...[...document.body.innerText.matchAll(new RegExp(`(?:^|\\s)(\\d+)-${suffix}`, 'g'))].map((m) => Number(m[1]))), COUNT_SUFFIX)
const savedReply = async (page, chatId) =>
  ((await page.evaluate((id) => window.api.chat.get(id), chatId)).messages ?? []).filter((m) => m.role === 'assistant').map((m) => String(m.content)).join('\n')
/** The assistant text after the chat's last user message. */
function answerAfterLastUser(messages) {
  const lastUser = messages.map((m) => m.role).lastIndexOf('user')
  return messages.slice(lastUser + 1).filter((m) => m.role === 'assistant').map((m) => String(m.content)).join('\n')
}

/**
 * Click the composer's Stop the way a user does, then time the end: the
 * composer back to idle (Stop gone for 1.5 s straight — it can blink between
 * phases of a turn), each watched agent's turn-end log entry, and each extra
 * locator disappearing. Gives up a few seconds past `boundMs` once the
 * composer is idle, and a minute after the click at the latest.
 */
async function stopAndTime(page, watchAgents, boundMs, watchGone = {}) {
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  const logAt = mainLogLength()
  const clicked = Date.now()
  await stop.click()
  say('   clicked Stop')
  const logMs = {}
  const goneMs = {}
  let idleSince = null
  let endedMs = null
  while (Date.now() - clicked < 60_000) {
    const elapsed = Date.now() - clicked
    const entries = logEntries(mainLogSince(logAt))
    for (const [label, agentId] of Object.entries(watchAgents)) {
      if (!(label in logMs) && entries.some((e) => TURN_END.test(e) && e.includes(agentId))) logMs[label] = elapsed
    }
    for (const [label, locator] of Object.entries(watchGone)) {
      if (!(label in goneMs) && !(await locator.isVisible().catch(() => false))) goneMs[label] = elapsed
    }
    if (await stop.isVisible().catch(() => false)) { idleSince = null; endedMs = null }
    else if (idleSince === null) idleSince = elapsed
    else if (elapsed - idleSince >= 1500) endedMs = idleSince
    const all = Object.keys(watchAgents).every((l) => l in logMs) && Object.keys(watchGone).every((l) => l in goneMs)
    if (endedMs !== null && (all || elapsed > boundMs + 5000)) break
    await sleep(200)
  }
  const parts = [`Stop→composer idle ${endedMs ?? 'not within 60s'}${endedMs === null ? '' : 'ms'}`]
  for (const label of Object.keys(watchAgents)) parts.push(`Stop→${label} turn-end log ${label in logMs ? `${logMs[label]}ms` : 'none'}`)
  for (const label of Object.keys(watchGone)) parts.push(`Stop→${label} gone ${label in goneMs ? `${goneMs[label]}ms` : 'never'}`)
  say(`   ${parts.join('; ')}`)
  return { logAt, clicked, endedMs, logMs, goneMs, timing: parts.join('; ') }
}

/** E1 — Stop a plain chat mid-reply; the same chat must answer afterwards. */
async function scenarioE1(page) {
  say('▶ E1 Stop a plain chat mid-reply')
  const logFrom = mainLogLength()
  await composer(page).fill(`Count from 1 to 500, one number per line, writing every line as the number followed by -${COUNT_SUFFIX} (for example n-${COUNT_SUFFIX}). No other text, no code block, no tools.`)
  await composer(page).press('Enter')
  const streamed = await page.getByText(/(?:^|\s)5-kiwi/).first().waitFor({ timeout: 120_000 }).then(() => true, () => false)
  verdict('E1: the reply started streaming', streamed)
  const chat = (await page.evaluate(() => window.api.chat.list()))[0]
  const conductorId = (await page.evaluate((id) => window.api.chat.get(id), chat.id)).agentId
  if (!(await page.getByRole('button', { name: 'Stop', exact: true }).isVisible().catch(() => false))) {
    verdict('E1: the turn was still running when Stop was due', false, 'the composer showed no Stop — the reply finished or failed before it')
    return
  }
  const atClick = await highestCount(page)
  const t = await stopAndTime(page, { conductor: conductorId }, PLAIN_STOP_BOUND_MS)
  verdict(`E1: the turn ended within ${PLAIN_STOP_BOUND_MS / 1000}s of Stop`, t.endedMs !== null && t.endedMs <= PLAIN_STOP_BOUND_MS, t.timing)
  const atEnd = await highestCount(page)
  const savedAtEnd = await savedReply(page, chat.id)
  await page.screenshot({ path: join(RESULTS, 'E1-after-stop.png'), animations: 'disabled' })
  await sleep(QUIET_WATCH_MS)
  const afterQuiet = await highestCount(page)
  const savedAfterQuiet = await savedReply(page, chat.id)
  verdict(`E1: no text arrived in the ${QUIET_WATCH_MS / 1000}s after the turn ended`, afterQuiet === atEnd && savedAfterQuiet === savedAtEnd,
    `highest count on screen: ${atClick} at Stop, ${atEnd} at end, ${afterQuiet} ${QUIET_WATCH_MS / 1000}s later; saved reply ${savedAtEnd.length}→${savedAfterQuiet.length} chars`)
  verdict('E1: Stop cut the reply short', atEnd < 500, `reached ${atEnd} of 500`)
  const detail = await page.evaluate((id) => window.api.chat.get(id), chat.id)
  writeFileSync(join(RESULTS, 'chat-after-E1-stop.json'), JSON.stringify(detail, null, 2))
  const errors = (detail.messages ?? []).filter((m) => m.role === 'error')
  const alerts = await page.getByRole('alert').count()
  // What a stop normally looks like on ACP (e2e/specs/llm-stop.spec.ts): the partial reply saved as an ordinary reply, no error row, no alert.
  verdict('E1: the stop reads as a stop — partial reply kept, no error row, no alert', /\d+-kiwi/.test(savedAfterQuiet) && errors.length === 0 && alerts === 0,
    `saved reply ends "…${savedAfterQuiet.slice(-40).replace(/\s+/g, ' ')}"; error rows: ${errors.map((m) => String(m.content).slice(0, 160)).join(' | ') || 'none'}; alerts: ${alerts}`)
  const ack = cancelAck(mainLogSince(t.logAt), conductorId)
  verdict('E1: the runtime acknowledged the cancel (process not retired)', ack.ok, ack.detail)
  const endedF = await sendAndWait(page, 'What number did you reach? Answer with just the number.', 'E1 follow-up')
  const after = await page.evaluate((id) => window.api.chat.get(id), chat.id)
  writeFileSync(join(RESULTS, 'chat-after-E1.json'), JSON.stringify(after, null, 2))
  const reply = answerAfterLastUser(after.messages ?? [])
  verdict('E1: a follow-up in the same chat is answered', endedF && /\d/.test(reply), `"${reply.slice(0, 80)}" (highest on screen at the stop's end: ${atEnd})`)
  verdict('E1: no error rows after the follow-up', !(after.messages ?? []).some((m) => m.role === 'error'), (after.messages ?? []).filter((m) => m.role === 'error').map((m) => String(m.content).slice(0, 200)).join(' | '))
  writeFileSync(join(RESULTS, 'E1-cancel-log.txt'), cancelEntries(mainLogSince(logFrom)).join('\n'))
}

/** E2 — Stop a coordinator chat while its specialist's slow command runs; both runs must end. */
async function scenarioE2(page, worker) {
  say('▶ E2 Stop a coordinator chat during a specialist call')
  const chat = await page.evaluate(async (agentId) => {
    const created = await window.api.chat.create()
    await window.api.chat.update(created.id, { router: 'coordinator', title: 'Live E' })
    await window.api.chat.addOnDemandAgent(created.id, agentId)
    return window.api.chat.get(created.id)
  }, worker.id)
  await page.reload()
  await page.getByRole('button', { name: 'Chats', exact: true }).waitFor({ timeout: 60_000 })
  await page.getByText('Live E', { exact: true }).first().click()
  await sleep(1500)
  const logFrom = mainLogLength()
  await composer(page).fill(`Use your tool for the agent "${SLOW_SPECIALIST}" to ask it to run the slow check, then tell me exactly what it replied.`)
  await composer(page).press('Enter')
  const stop = page.getByRole('button', { name: 'Stop', exact: true })
  const subStop = page.getByRole('button', { name: `Stop ${SLOW_SPECIALIST}`, exact: true })
  // Until the specialist's command is running — or, since a live Codex
  // specialist may not wait on it (seen 2026-09-18: its turn ended in 17s with
  // no command left running), 3s into its sub-thread — answering any
  // permission ask on the way.
  const t0 = Date.now()
  let subSeenMs = null
  let pids = []
  while (Date.now() - t0 < 180_000) {
    await allowAsks(page)
    if (subSeenMs === null && (await subStop.isVisible().catch(() => false))) { subSeenMs = Date.now() - t0; say(`   the specialist's sub-thread is live after ${subSeenMs}ms`) }
    pids = commandPids()
    if (pids.length) break
    if (subSeenMs !== null && Date.now() - t0 - subSeenMs >= 3000) break
    if (Date.now() - t0 > 30_000 && !(await stop.isVisible().catch(() => false))) break
    await sleep(500)
  }
  if (pids.length) { say(`   ${SLOW_COMMAND} running: ${describePids(pids)}`); await sleep(2000) }
  if (!(await stop.isVisible().catch(() => false))) {
    verdict('E2: the conductor turn was still running when Stop was due', false, `sub-thread seen: ${subSeenMs ?? 'never'}; the composer showed no Stop`)
    return
  }
  const inFlight = await subStop.isVisible().catch(() => false)
  verdict('E2: Stop landed while the specialist call was in flight', inFlight, `sub-thread Stop visible at the click: ${inFlight}; first seen ${subSeenMs ?? 'never'}ms after send`)
  // Which path the Stop took, not a verdict: the call is in flight either way.
  say(`   ${SLOW_COMMAND} running at Stop: ${pids.length ? describePids(pids) : 'no — the specialist was still thinking or waiting on its model'}`)
  const t = await stopAndTime(page, { conductor: chat.agentId, specialist: worker.id }, CONDUCTOR_STOP_BOUND_MS, { 'sub-thread Stop': subStop })
  verdict(`E2: the conductor turn ended within ${CONDUCTOR_STOP_BOUND_MS / 1000}s of Stop`, t.endedMs !== null && t.endedMs <= CONDUCTOR_STOP_BOUND_MS, t.timing)
  await page.screenshot({ path: join(RESULTS, 'E2-after-stop.png'), animations: 'disabled' })
  const detail = await page.evaluate((id) => window.api.chat.get(id), chat.id)
  writeFileSync(join(RESULTS, 'chat-after-E2-stop.json'), JSON.stringify(detail, null, 2))
  const toolRows = (detail.messages ?? []).filter((m) => m.toolCallId)
  const subGone = 'sub-thread Stop' in t.goneMs && t.goneMs['sub-thread Stop'] <= CONDUCTOR_STOP_BOUND_MS
  const subLogged = 'specialist' in t.logMs && t.logMs.specialist <= CONDUCTOR_STOP_BOUND_MS
  verdict(`E2: the specialist's nested run ended within ${CONDUCTOR_STOP_BOUND_MS / 1000}s too (sub-thread idle, its turn-end logged)`, subGone && subLogged,
    `${t.timing}; tool rows: ${toolRows.map((m) => `${m.toolName}${m.toolError ? '(error)' : ''}: ${String(m.content).slice(0, 100)}`).join(' | ') || 'none'}`)
  const spec = cancelAck(mainLogSince(t.logAt), worker.id)
  verdict('E2: the specialist acknowledged the cancel (process not retired)', spec.ok, spec.detail)
  const cond = cancelAck(mainLogSince(t.logAt), chat.agentId)
  verdict('E2: the conductor acknowledged the cancel (process not retired)', cond.ok, cond.detail)
  const wait = t.clicked + CONDUCTOR_STOP_BOUND_MS - Date.now()
  if (wait > 0) await sleep(wait)
  const left = commandPids()
  verdict(`E2: the specialist's "${SLOW_COMMAND}" is not left running ${CONDUCTOR_STOP_BOUND_MS / 1000}s after Stop`, left.length === 0, describePids(left))
  verdict('E2: the stop left no error row', !(detail.messages ?? []).some((m) => m.role === 'error'), (detail.messages ?? []).filter((m) => m.role === 'error').map((m) => String(m.content).slice(0, 200)).join(' | '))
  const endedF = await sendAndWait(page, 'Reply with exactly this and nothing else: after-stop-ok', 'E2 follow-up')
  const after = await page.evaluate((id) => window.api.chat.get(id), chat.id)
  writeFileSync(join(RESULTS, 'chat-after-E2.json'), JSON.stringify(after, null, 2))
  const reply = answerAfterLastUser(after.messages ?? [])
  verdict('E2: a follow-up in the same chat is answered', endedF && reply.includes('after-stop-ok'), reply.slice(0, 120))
  verdict('E2: no error rows after the follow-up', !(after.messages ?? []).some((m) => m.role === 'error'), (after.messages ?? []).filter((m) => m.role === 'error').map((m) => String(m.content).slice(0, 200)).join(' | '))
  writeFileSync(join(RESULTS, 'E2-cancel-log.txt'), cancelEntries(mainLogSince(logFrom)).join('\n'))
}

/** E — both cancel scenarios; one failing to run does not skip the other. */
async function scenarioE(app, root) {
  const worker = await adopt(app, makeSlowWorker(root))
  for (const [name, run] of [['E1', () => scenarioE1(app.page)], ['E2', () => scenarioE2(app.page, worker)]]) {
    try { await run() } catch (error) {
      verdict(`${name}: the scenario ran to the end`, false, String(error?.stack ?? error))
      await app.page.screenshot({ path: join(RESULTS, `${name}-failure.png`) }).catch(() => {})
    }
  }
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
    if (ONLY === 'e') { await scenarioE(app, root); return }
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
    // The after-turn title retry runs on the now-warm process (Claude), or Codex
    // reports its thread title after the turn (Codex); give it up to 40 s. Codex's
    // placeholder is the prompt verbatim, so it would still start like the derived one.
    let titled = detail
    for (let i = 0; i < 20; i++) {
      await sleep(2000)
      titled = await page.evaluate((id) => window.api.chat.get(id), chat.id)
      if (titled.title && !titled.title.startsWith('Reply with exactly')) break
    }
    verdict(ENGINE === 'codex' ? 'A: Codex’s own thread title replaced the derived one after the first turn' : 'A: the AI title replaced the derived one after the first turn',
      !!titled.title && !titled.title.startsWith('Reply with exactly'), `title: ${titled.title}`)

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
