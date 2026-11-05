import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { LIVE_ENGINE, liveEngineOptions, requireLiveEngine, seedLiveModel, useLiveRuntime } from '../fixtures/liveEngine'
import { SCAFFOLD_SCRIPT_FILES, SCAFFOLD_SKILL_FILES } from '../../src/main/services/localAgents/guidedBuild'

/**
 * @live — **the guided first build on a real agent**: a new user's blank kit
 * agent interviews them and ends with a build brief, and Start building gets
 * the agent built. Billed; `CINNA_E2E_LIVE_ENGINE=opencode|claude|codex`
 * picks the engine (`e2e/fixtures/liveEngine.ts`).
 *
 * Everything is driven as a person would: the job is typed into the guided
 * composer, the agent's questions are answered in the question modal (the
 * recommended option, else the first), permission asks are allowed once, and
 * the brief card's Start building opens the building chat.
 *
 * 1. A mid-complexity job (a daily check of AI news, no source named) is guided:
 *    the agent asks with its question tool, edits nothing in its folder, and
 *    proposes a brief through `build_brief_propose`. Start building opens an
 *    unguided chat with the brief, and the agent builds — its folder gains a
 *    script, skill or schedule beyond the scaffold.
 * 2. A task instead of a job description is not attempted: the agent asks
 *    what to be built for, and after "Build me for that" interviews on to a
 *    brief; its folder stays the scaffold.
 * 3. An area start ("Help me with my expenses", "Fix my mailbox") on a
 *    generically named agent is worked into a role: at least two questions
 *    (where, what, how), and the brief's summary names it.
 *
 * Assertions are on outcomes (the persisted tool rows, the card, the folder),
 * never on wording. Each step's transcript is written to the test's output
 * folder (`guided-transcript.md`) so a run can be judged by eye.
 *
 * ## Cost
 *
 * Test 1 is an interview of 2–4 turns and one building turn of a dozen or so
 * tool calls; the others are interviews of 1–3 turns. On gpt-5.6-luna about $0.10–0.30 per run; on
 * Claude sonnet roughly $0.50–1.50.
 */

test.beforeEach(() => requireLiveEngine())

test.use(liveEngineOptions())

const AGENT = 'News Digest'
const DESCRIPTION = 'Keeps me up to date on AI news.'
/**
 * A daily check as a new user types it: when and what,
 * but not where from or how it reaches them — so the interview has something
 * to ask.
 */
const JOB = 'Every weekday morning, check what is new in AI and tell me what matters.'
const TASK = 'Summarize this for me: "The quarterly report shows revenue up 12% while costs grew 4%; the board approved a new office in Lisbon."'
/** A plain-text question gets this reply instead of a modal answer. */
const NUDGE = 'Your recommendations are fine. Please use what you have and propose the build brief.'

const MAX_ROUNDS = 6
/** Permission asks a build may raise before the run counts as stuck. */
const MAX_ASKS = 40

/** The composer's guided-build row (it names no agent: one shows at a time). */
function invitation(page: Page): Locator {
  return page.getByRole('listitem').filter({ hasText: 'this chat starts with guidance' })
}

function guidedComposer(page: Page, name = AGENT): Locator {
  return page.getByRole('combobox', { name: `Describe what ${name} should do for you…`, exact: true })
}

function anyComposer(page: Page): Locator {
  return page.locator('textarea[data-chat-composer]').first()
}

const briefCard = (page: Page): Locator => page.getByRole('group', { name: 'Build brief', exact: true }).last()

interface Arranged { agentId: string; folder: string }

async function arrange(cinna: CinnaApp, name = AGENT, description = DESCRIPTION): Promise<Arranged> {
  await cinna.skipOnboarding()
  const model = await seedLiveModel(cinna)
  console.log(`live-guided-build engine: ${LIVE_ENGINE.label}, chat model: ${model}`)
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, name, description, { unbuilt: true })
  expect(agent.unbuilt).toBe(true)
  await useLiveRuntime(cinna, agent.id)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  if (!agent.path) throw new Error('the scaffolded agent has no folder')
  return { agentId: agent.id, folder: agent.path }
}

/** The agent page's new-chat composer, with the guided-build row on it. */
async function openAgent(page: Page, name = AGENT): Promise<void> {
  await expect(async () => {
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name, exact: true }).click()
    await expect(guidedComposer(page, name)).toBeVisible({ timeout: 2000 })
    await expect(invitation(page)).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 30_000 })
}

/** Entries beyond the scaffold under `scripts/` and `skills/`, and the manifest's schedules. */
function builtParts(folder: string): { scripts: string[]; skills: string[]; schedules: number; credentials: number } {
  const list = (dir: string, scaffold: readonly string[]): string[] => existsSync(join(folder, dir))
    ? readdirSync(join(folder, dir)).filter((n) => !n.startsWith('.') && n !== '__pycache__' && !scaffold.includes(n))
    : []
  let schedules = 0
  let credentials = 0
  try {
    const manifest = JSON.parse(readFileSync(join(folder, 'cinna-agent.json'), 'utf8'))
    schedules = Array.isArray(manifest.schedules) ? manifest.schedules.length : 0
    credentials = Array.isArray(manifest.credentials) ? manifest.credentials.length : 0
  } catch { /* unreadable: counts as none */ }
  return { scripts: list('scripts', SCAFFOLD_SCRIPT_FILES), skills: list('skills', SCAFFOLD_SKILL_FILES), schedules, credentials }
}

async function chatIdsFor(page: Page, agentId: string): Promise<string[]> {
  return page.evaluate(async (id) => (await window.api.chat.list()).filter((c) => c.agentId === id).map((c) => c.id), agentId)
}

async function activeRun(page: Page, chatId: string): Promise<string | null> {
  return page.evaluate(async (id) => (await window.api.chat.get(id))?.activeRunId ?? null, chatId)
}

/**
 * The chat is listed before its first run starts (the new-chat flow binds the
 * agent, then sends), so "no run" right after a send is not "turn ended".
 * Wait until a run has started or the agent has already answered.
 */
async function turnStarted(page: Page, chatId: string): Promise<void> {
  await expect.poll(() => page.evaluate(async (id) => {
    const chat = await window.api.chat.get(id)
    return (chat?.activeRunId ?? null) !== null || (chat?.messages ?? []).some((m) => m.role !== 'user')
  }, chatId), { message: 'the first turn starts', timeout: 60_000 }).toBe(true)
}

/** The chat's messages as markdown, for the transcript file and failure messages. */
async function transcript(page: Page, chatId: string): Promise<string> {
  const chat = await page.evaluate((id) => window.api.chat.get(id), chatId)
  if (!chat) return '(no chat)'
  return chat.messages.map((m) => {
    if (m.role === 'tool_call') return `**tool_call ${m.toolName}** (${m.toolProvider ?? ''})${m.toolError ? ' ERROR' : ''}\n\`\`\`json\n${JSON.stringify(m.toolInput ?? {}, null, 2)}\n\`\`\``
    if (m.role === 'tool_result') return `**tool_result ${m.toolName ?? ''}**: ${(m.content ?? '').slice(0, 600)}`
    const parts = Array.isArray((m as { parts?: unknown[] }).parts) ? JSON.stringify((m as { parts?: unknown[] }).parts).slice(0, 1500) : ''
    return `**${m.role}**: ${m.content ?? ''}${parts && m.role !== 'user' ? `\n<parts>${parts}</parts>` : ''}`
  }).join('\n\n')
}

function saveTranscript(name: string, text: string): void {
  const path = test.info().outputPath(name)
  writeFileSync(path, text)
  console.log(`transcript: ${path}`)
}

type Step = 'brief' | 'question' | 'permission' | 'idle'

/**
 * Answer what the agent puts in front of the person until `done` holds or
 * the rounds run out: a question modal (recommended option, else the first),
 * a permission ask (Allow once), or a turn that ended with neither (a plain
 * text reply, answered with {@link NUDGE} when `nudge` is set).
 */
async function drive(
  cinna: CinnaApp,
  chatId: () => Promise<string>,
  done: () => Promise<boolean>,
  opts: { nudge: boolean; log: string[]; timeout: number }
): Promise<void> {
  const page = cinna.page
  const answer = page.getByRole('button', { name: /^Answer( questions)?$/ }).last()
  const allow = page.getByRole('button', { name: 'Allow once', exact: true }).first()
  const deadline = Date.now() + opts.timeout
  let rounds = 0
  let asks = 0
  await turnStarted(page, await chatId())
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out driving the chat:\n${opts.log.join('\n')}`)
    if (rounds - asks > MAX_ROUNDS || asks > MAX_ASKS) throw new Error(`more than ${MAX_ROUNDS} rounds:\n${opts.log.join('\n')}`)
    let step: Step | null = null
    await expect.poll(async () => {
      if (await done()) step = 'brief'
      else if (await allow.isVisible()) step = 'permission'
      else if (await answer.isVisible() && await answer.isEnabled()) step = 'question'
      else if ((await activeRun(page, await chatId())) === null) step = 'idle'
      return step
    }, { timeout: Math.max(1000, deadline - Date.now()), intervals: [1000] }).not.toBeNull()
    rounds += 1
    if (step === 'brief') break
    if (step === 'permission') {
      asks += 1
      const text = (await allow.locator('xpath=ancestor::*[4]').innerText().catch(() => '')).slice(0, 300)
      opts.log.push(`round ${rounds}: permission ask — ${text.replace(/\s+/g, ' ')}`)
      await allow.click()
      continue
    }
    if (step === 'question') {
      await answer.click()
      const modal = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: /^Send answers?$/ }) })
      await expect(modal).toBeVisible()
      const questions = modal.locator('[data-question-index]')
      const n = await questions.count()
      const picked: string[] = []
      for (let i = 0; i < n; i++) {
        const q = questions.nth(i)
        const text = (await q.locator('.font-medium').first().innerText()).trim()
        const options = q.getByRole('button').filter({ hasNotText: 'Other (enter custom answer)' })
        const recommended = options.filter({ hasText: /Recommended/i })
        const choice = (await recommended.count()) > 0 ? recommended.first() : options.first()
        const label = (await choice.innerText()).split('\n')[0].trim()
        await choice.click()
        picked.push(`  - ${text} → ${label}`)
      }
      opts.log.push(`round ${rounds}: ${n} question(s)\n${picked.join('\n')}`)
      await modal.getByRole('button', { name: /^Send answers?$/ }).click()
      await expect(modal).toHaveCount(0, { timeout: 30_000 })
      continue
    }
    // idle with no brief and nothing to answer — unless the brief landed as the turn ended
    if (await done()) break
    opts.log.push(`round ${rounds}: the turn ended with no question tool and no brief`)
    if (!opts.nudge) break
    const input = anyComposer(page)
    await input.fill(NUDGE)
    await input.press('Enter')
    const id = await chatId()
    await expect.poll(async () => (await activeRun(page, id)) !== null || (await done()), { timeout: 30_000 }).toBe(true)
  }
}

test('a daily-check job is interviewed into a brief, and Start building gets the agent built', async ({ cinna }) => {
  test.setTimeout(20 * 60_000)
  const { agentId, folder } = await arrange(cinna)
  const page = cinna.page
  const log: string[] = []
  const before = builtParts(folder)

  await test.step('the job is typed into the guided composer and sent', async () => {
    await openAgent(page)
    await guidedComposer(page).fill(JOB)
    await guidedComposer(page).press('Enter')
    await expect.poll(() => chatIdsFor(page, agentId)).toHaveLength(1)
  })
  const [guidedChat] = await chatIdsFor(page, agentId)
  expect((await page.evaluate((id) => window.api.chat.get(id), guidedChat))?.guidedBuild).toBe(true)

  const hasBrief = async (): Promise<boolean> => {
    const chat = await page.evaluate((id) => window.api.chat.get(id), guidedChat)
    return (chat?.messages ?? []).some((m) => m.role === 'tool_call' && m.toolName === 'build_brief_propose' && !m.toolError)
      && (chat?.activeRunId ?? null) === null
  }

  await test.step('the agent interviews with its question tool and ends with a brief', async () => {
    try {
      await drive(cinna, async () => guidedChat, hasBrief, { nudge: true, log, timeout: 8 * 60_000 })
    } finally {
      saveTranscript('guided-transcript.md', `# ${LIVE_ENGINE.label}\n\n## Driver\n${log.join('\n')}\n\n## Guided chat\n\n${await transcript(page, guidedChat)}`)
    }
    console.log(`driver log:\n${log.join('\n')}`)
    const chat = await page.evaluate((id) => window.api.chat.get(id), guidedChat)
    const msgs = chat?.messages ?? []
    // Guided, not built: the folder is still the scaffold.
    expect(builtParts(folder), 'the guided chat did not build anything').toEqual(before)
    // An interview needs no permission: an ask here is a new user's first sight of the agent.
    expect(log.filter((l) => l.includes('permission ask')), 'the interview raised no permission ask').toEqual([])
    // It asked through the question tool before the brief: the job names no
    // source and no way of telling the person.
    expect(log.some((l) => /question\(s\)/.test(l)), `the agent asked with its question tool:\n${log.join('\n')}`).toBe(true)
    const briefs = msgs.filter((m) => m.role === 'tool_call' && m.toolName === 'build_brief_propose')
    expect(briefs.length).toBeGreaterThanOrEqual(1)
    const brief = (briefs[briefs.length - 1].toolInput ?? {}) as { capabilities?: { id: string; state: string }[]; credentials?: unknown[]; prompt?: string }
    console.log(`brief: ${JSON.stringify(brief, null, 2)}`)
    // A weekday-morning job calls for a schedule.
    expect(brief.capabilities?.find((c) => c.id === 'schedules')?.state, 'the brief recommends Schedules').toMatch(/^(used|maybe)$/)
  })

  await test.step('the brief card is shown, and Start building opens an unguided building chat', async () => {
    const card = briefCard(page)
    await expect(card).toBeVisible()
    await expect(card.getByRole('button', { name: 'Start building', exact: true })).toBeVisible()
    await card.getByRole('button', { name: 'Start building', exact: true }).click()
    await expect.poll(() => chatIdsFor(page, agentId)).toHaveLength(2)
    await expect.poll(async () => (await page.evaluate(() => window.api.localAgents.list())).agents.find((a) => a.id === agentId)?.unbuilt).toBe(false)
  })
  const buildingChat = (await chatIdsFor(page, agentId)).find((id) => id !== guidedChat)!
  expect((await page.evaluate((id) => window.api.chat.get(id), buildingChat))?.guidedBuild).toBe(false)

  await test.step('the building chat builds the agent', async () => {
    const built = async (): Promise<boolean> => {
      const parts = builtParts(folder)
      return (parts.scripts.length + parts.skills.length + parts.schedules > 0) && (await activeRun(page, buildingChat)) === null
    }
    const buildLog: string[] = []
    try {
      await drive(cinna, async () => buildingChat, built, { nudge: false, log: buildLog, timeout: 10 * 60_000 })
    } finally {
      saveTranscript('building-transcript.md', `# ${LIVE_ENGINE.label}\n\n## Driver\n${buildLog.join('\n')}\n\n## Building chat\n\n${await transcript(page, buildingChat)}\n\n## Folder\n${JSON.stringify(builtParts(folder), null, 2)}`)
    }
    const parts = builtParts(folder)
    console.log(`built: ${JSON.stringify(parts)}`)
    expect(parts.scripts.length + parts.skills.length + parts.schedules, 'the agent folder gained a script, skill or schedule').toBeGreaterThan(0)
    // The agent is built: its new-chat composer no longer invites.
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name: AGENT, exact: true }).click()
    await expect(page.getByRole('combobox', { name: 'Type a message...', exact: true })).toBeVisible()
    await expect(invitation(page)).toHaveCount(0)
  })
})

test('a task instead of a job description is not attempted; the agent asks what to be built for', async ({ cinna }) => {
  test.setTimeout(10 * 60_000)
  const { agentId, folder } = await arrange(cinna)
  const page = cinna.page
  const before = builtParts(folder)
  await openAgent(page)
  await guidedComposer(page).fill(TASK)
  await guidedComposer(page).press('Enter')
  await expect.poll(() => chatIdsFor(page, agentId)).toHaveLength(1)
  const [chatId] = await chatIdsFor(page, agentId)
  await turnStarted(page, chatId)

  const answer = page.getByRole('button', { name: /^Answer( questions)?$/ }).last()
  await expect.poll(async () => (await answer.isVisible()) || (await activeRun(page, chatId)) === null, { timeout: 4 * 60_000, intervals: [1000] }).toBe(true)
  const text = await transcript(page, chatId)
  saveTranscript('task-transcript.md', `# ${LIVE_ENGINE.label}\n\n${text}`)
  expect(await answer.isVisible(), `the agent asked with its question tool:\n${text}`).toBe(true)
  expect(builtParts(folder)).toEqual(before)

  // "Build me for that", and the interview goes on to a brief.
  await answer.click()
  const modal = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: /^Send answers?$/ }) })
  const first = modal.locator('[data-question-index]').first()
  const build = first.getByRole('button').filter({ hasText: /build me/i })
  await ((await build.count()) > 0 ? build.first() : first.getByRole('button').first()).click()
  const questions = modal.locator('[data-question-index]')
  for (let i = 1; i < await questions.count(); i++) await questions.nth(i).getByRole('button').first().click()
  await modal.getByRole('button', { name: /^Send answers?$/ }).click()
  const log: string[] = []
  const hasBrief = async (): Promise<boolean> => {
    const chat = await page.evaluate((id) => window.api.chat.get(id), chatId)
    return (chat?.messages ?? []).some((m) => m.role === 'tool_call' && m.toolName === 'build_brief_propose' && !m.toolError)
      && (chat?.activeRunId ?? null) === null
  }
  try {
    await drive(cinna, async () => chatId, hasBrief, { nudge: true, log, timeout: 5 * 60_000 })
  } finally {
    saveTranscript('task-transcript.md', `# ${LIVE_ENGINE.label}\n\n## Driver\n${log.join('\n')}\n\n${await transcript(page, chatId)}`)
  }
  expect(builtParts(folder)).toEqual(before)
})

/**
 * A new user's first words often name an area, not a job. The guide works out
 * the role — where they manage it, what exactly, and how — and the brief's
 * summary names it. The agent has the generic name a newcomer gives it.
 */
const AREAS = [
  { start: 'Help me with my expenses', role: /expense|spend|receipt|budget/i },
  { start: 'Fix my mailbox', role: /mail|inbox/i }
]

for (const area of AREAS) {
  test(`an area start (“${area.start}”) is interviewed into a role`, async ({ cinna }) => {
    test.setTimeout(10 * 60_000)
    const name = 'My Assistant'
    const { agentId, folder } = await arrange(cinna, name, name)
    const page = cinna.page
    const before = builtParts(folder)
    const log: string[] = []
    await openAgent(page, name)
    await guidedComposer(page, name).fill(area.start)
    await guidedComposer(page, name).press('Enter')
    await expect.poll(() => chatIdsFor(page, agentId)).toHaveLength(1)
    const [chatId] = await chatIdsFor(page, agentId)
    const hasBrief = async (): Promise<boolean> => {
      const chat = await page.evaluate((id) => window.api.chat.get(id), chatId)
      return (chat?.messages ?? []).some((m) => m.role === 'tool_call' && m.toolName === 'build_brief_propose' && !m.toolError)
        && (chat?.activeRunId ?? null) === null
    }
    try {
      await drive(cinna, async () => chatId, hasBrief, { nudge: true, log, timeout: 8 * 60_000 })
    } finally {
      saveTranscript('area-transcript.md', `# ${LIVE_ENGINE.label} — ${area.start}\n\n## Driver\n${log.join('\n')}\n\n## Chat\n\n${await transcript(page, chatId)}`)
    }
    console.log(`driver log (${area.start}):\n${log.join('\n')}`)
    expect(builtParts(folder), 'the guided chat did not build anything').toEqual(before)
    expect(log.filter((l) => l.includes('permission ask')), 'the interview raised no permission ask').toEqual([])
    // An area says none of where, what or how: more than one question.
    const asked = log.flatMap((l) => l.split('\n').filter((line) => line.startsWith('  - ')))
    expect(asked.length, `the agent asked what the role is:\n${log.join('\n')}`).toBeGreaterThanOrEqual(2)
    const chat = await page.evaluate((id) => window.api.chat.get(id), chatId)
    const briefs = (chat?.messages ?? []).filter((m) => m.role === 'tool_call' && m.toolName === 'build_brief_propose' && !m.toolError)
    const brief = (briefs[briefs.length - 1].toolInput ?? {}) as { summary?: string; prompt?: string }
    console.log(`brief (${area.start}): ${JSON.stringify(brief, null, 2)}`)
    expect(brief.summary ?? '', 'the summary names the role').toMatch(area.role)
    await expect(briefCard(page).getByRole('button', { name: 'Start building', exact: true })).toBeVisible()
  })
}
