import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { LIVE_ENGINE, liveEngineOptions, requireLiveEngine, seedLiveModel, useLiveRuntime, type LiveEngineName } from '../fixtures/liveEngine'

/**
 * @live — **a two-level subagent orchestration on a real engine**, read off
 * the screen: root → `orch` (level 1) → `worker` (level 2), each defined in
 * the folder with the engine's own agent mechanism.
 *
 * `CINNA_E2E_LIVE_ENGINE` picks the engine, as in every `live-*` spec
 * (`e2e/fixtures/liveEngine.ts`). The definitions written into the kit agent's
 * folder:
 *
 * - Claude: `.claude/agents/{orch,worker,leaf}.md` on `haiku` (the root runs
 *   on the Medium tier). A kit folder runs isolated, and the launcher passes
 *   these files as the session's agents.
 * - OpenCode: `.opencode/agent/*.md` with `mode: subagent`. Cinna lets an
 *   OpenCode subagent nest three deep and puts every level under the
 *   profile's asks, so the test answers each `Allow once`.
 * - Codex: `.codex/agents/*.toml` roles. Codex lets only the root spawn
 *   (`max_depth` 1): `orch` has no spawn tool, so A ends **degraded-clean**
 *   (one level-1 item that completes, its report in the `wait` call's
 *   output), and C has the level-1 `worker` run the long command itself.
 * - Antigravity: Cinna filters the subagent tools out of the session, so the
 *   model cannot spawn. A asserts the degraded-clean end only.
 *
 * Variants (one test each; an engine that cannot run one skips with why):
 * - **A** foreground nesting: `worker` runs `echo L2`, every level reports
 *   up, the root replies `done`.
 * - **B** background + early report + in-turn resume: Claude only.
 * - **C** cancel: the worker runs `python3 -c 'import time; time.sleep(60)'`;
 *   the test presses Stop once the worker shows as running.
 * - **D** fan-out: `orch` starts two workers, each starts a `leaf`.
 *
 * What it asserts: sub-threads nested in the transcript (the worker's inside
 * orch's, the worker's own steps inside the worker's), each level's report on
 * screen, the composer's Subagents badge gone, every activity item terminal
 * (`completed`; `stopped` after Stop) in main's snapshot, the composer idle,
 * and a follow-up answered (`144`, not in its prompt). Exact model wording is
 * asserted only for the reports the prompts dictate.
 *
 * What it does not prove: anything about a Codex level-2 subagent (Codex
 * does not run one), that a cancelled process outside the engine died, or
 * the main log's subagent warnings (the driver tests own those).
 *
 * ## Running it, and cost
 *
 * One engine per run, always the full path (SPEC is a regex):
 * `make e2e-one SPEC=e2e/specs/live-subagents.spec.ts LIVE_ENGINE=claude`
 * (then `opencode`, `codex`, `antigravity`). Claude and Codex spend the
 * developer's own subscription, OpenCode the `.env` OpenAI key on
 * gpt-5.6-luna, Antigravity the Google quota on Gemini Flash. A–D on Claude
 * were about $0.20 in the probes; the other engines run fewer variants.
 */

test.use(liveEngineOptions())
test.beforeEach(() => requireLiveEngine())

const ENGINE: LiveEngineName = LIVE_ENGINE.name
const AGENT = 'Subagent Probe'
const IDLE = 'Type a message...'
const RUNNING = 'Send a follow-up · Esc Esc to stop'
const FOLLOW_UP = 'What is 12 times 12? Reply with only the number. Do not use any tools.'
/** Each wait for a model-driven step: haiku/luna levels take tens of seconds each. */
const TURN_MS = 5 * 60_000

const WORKFLOW = [
  'You are a protocol probe agent inside a test harness.',
  'Follow the user\'s instructions literally and briefly. Never do anything that was not asked.',
  'Never ask the user anything.'
].join(' ')

/* ------------------------------------------------------------------ agents */

function writeFile(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

function writeClaudeAgents(folder: string): void {
  const agent = (name: string, body: string): void => writeFile(join(folder, '.claude', 'agents', `${name}.md`),
    `---\nname: ${name}\ndescription: Probe ${name} for a protocol test. Only use when explicitly named.\nmodel: haiku\n---\n\n${body}\n`)
  agent('orch', `You are a protocol probe. Follow these steps literally, with no commentary and no extra tool calls.

- If your prompt says MODE=NESTED:
  1. Call the Agent tool with subagent_type "worker", run_in_background: false, description "fg worker", prompt "ECHO=L2".
  2. Call SubagentHandback with message "ORCH FINAL".
- If your prompt says MODE=EARLY:
  1. Call the Agent tool with subagent_type "worker", run_in_background: true, description "bg worker", prompt "SLEEP=20".
  2. Immediately call SubagentHandback with message "INTERIM: worker launched". Do not wait for the worker.
- If you receive a message saying MODE=CONTINUE:
  1. Call the Agent tool with subagent_type "worker", run_in_background: false, description "fg worker", prompt "ECHO=L2".
  2. Call SubagentHandback with message "ORCH FINAL".
- If your prompt says MODE=LONG:
  1. Call the Agent tool with subagent_type "worker", run_in_background: false, description "long worker", prompt "LONG=60".
  2. Call SubagentHandback with message "ORCH FINAL".
- If your prompt says MODE=FANOUT:
  1. In ONE message, make TWO Agent tool calls at once, both subagent_type "worker", run_in_background: false, descriptions "worker one" and "worker two", prompt "LEAF=1" for both.
  2. When both returned, call SubagentHandback with message "ORCH FINAL".
- If a background worker's result notification arrives after you handed back, call SubagentHandback with message "LATE NOTE" if you still can, otherwise end.`)
  agent('worker', `You are a protocol probe. Follow these steps literally, with no commentary.
1. If your prompt has ECHO=X, run the Bash command \`echo X\`.
2. If your prompt has SLEEP=N, run the Bash command \`python3 -c 'import time; time.sleep(N)'\` in the foreground, with a Bash timeout of 120000.
3. If your prompt has LONG=N, run the Bash command \`python3 -c 'import time; time.sleep(N)'\` in the foreground (not in the background), with a Bash timeout of 120000.
4. If your prompt says LEAF=1, call the Agent tool with subagent_type "leaf", run_in_background: false, description "leaf", prompt "leaf".
5. Call SubagentHandback with message "WORKER DONE".`)
  agent('leaf', 'You are a protocol probe. Run the Bash command `echo leaf`, then call SubagentHandback with message "LEAF DONE". Nothing else.')
}

function writeOpencodeAgents(folder: string): void {
  const agent = (name: string, body: string): void => writeFile(join(folder, '.opencode', 'agent', `${name}.md`),
    `---\ndescription: Probe ${name} for a protocol test. Only use when explicitly named.\nmode: subagent\n---\n\n${body}\n`)
  agent('orch', `You are a protocol probe. Follow these steps literally, with no commentary.
- MODE=NESTED: call the subagent tool with agent "worker", description "fg worker" and prompt "ECHO=L2"; then reply "ORCH FINAL".
- MODE=LONG: call the subagent tool with agent "worker", description "long worker" and prompt "LONG=60"; then reply "ORCH FINAL".
- MODE=FANOUT: emit TWO subagent tool calls in the SAME response as parallel tool calls (agent "worker", prompt "LEAF=1", descriptions "worker one" and "worker two"); do not wait for the first before making the second; when both returned, reply "ORCH FINAL".`)
  agent('worker', `You are a protocol probe. Follow these steps literally, with no commentary.
1. ECHO=X: run the bash command \`echo X\`.
2. LONG=N: run the bash command \`python3 -c 'import time; time.sleep(N)'\` in the foreground.
3. LEAF=1: call the subagent tool with agent "leaf", description "leaf" and prompt "leaf".
4. Reply "WORKER DONE".`)
  agent('leaf', 'You are a protocol probe. Run the bash command `echo leaf`, then reply "LEAF DONE". Nothing else.')
}

function writeCodexAgents(folder: string): void {
  const role = (name: string, instructions: string): void => writeFile(join(folder, '.codex', 'agents', `${name}.toml`),
    `name = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(`Probe ${name} for a protocol test. Only use when explicitly named.`)}\nmodel_reasoning_effort = "low"\ndeveloper_instructions = ${JSON.stringify(instructions)}\n`)
  role('orch', `You are a protocol probe. Follow these steps literally, with no commentary.
- MODE=NESTED: spawn_agent with agent_type "worker" and message "ECHO=L2"; wait for it; then reply "ORCH FINAL".
- Your tools may sit inside exec (ALL_TOOLS, tools.<name>). If no tool whose name contains "spawn" exists there either, reply exactly "NO SPAWN TOOL" instead.`)
  role('worker', `You are a protocol probe. Follow these steps literally, with no commentary.
1. ECHO=X: run the shell command \`echo X\`.
2. LONG=N: run the shell command \`python3 -c 'import time; time.sleep(N)'\` in the foreground.
3. Reply "WORKER DONE".`)
}

const WRITE_AGENTS: Record<LiveEngineName, ((folder: string) => void) | null> = {
  claude: writeClaudeAgents,
  opencode: writeOpencodeAgents,
  codex: writeCodexAgents,
  // Antigravity defines subagents at runtime, and Cinna filters those tools out.
  antigravity: null
}

/* ----------------------------------------------------------------- prompts */

type Variant = 'A' | 'B' | 'C' | 'D'

const PROMPTS: Record<LiveEngineName, Partial<Record<Variant, string>>> = {
  claude: {
    A: 'Protocol probe. Call the Agent tool exactly once: subagent_type "orch", run_in_background: false, description "A orch", prompt "MODE=NESTED". When it returns, reply: done. Nothing else.',
    B: `Protocol probe. Call the Agent tool exactly once: subagent_type "orch", run_in_background: true, description "B orch", prompt "MODE=EARLY". Then end your turn with the single word: launched.
Later rules: when a report from that agent containing INTERIM arrives, call SendMessage with to set to that agent's id and message "MODE=CONTINUE", then end your turn with: resumed. When a report containing ORCH FINAL arrives, reply: done. On any other notification reply: noted. Never do anything else.`,
    C: 'Protocol probe. Call the Agent tool exactly once: subagent_type "orch", run_in_background: false, description "C orch", prompt "MODE=LONG". When it returns, reply: done. Nothing else.',
    D: 'Protocol probe. Call the Agent tool exactly once: subagent_type "orch", run_in_background: false, description "D orch", prompt "MODE=FANOUT". When it returns, reply: done. Nothing else.'
  },
  opencode: {
    A: 'Protocol probe. Call the subagent tool exactly once with agent "orch", description "A orch" and prompt "MODE=NESTED". When it returns, reply: done. Nothing else.',
    C: 'Protocol probe. Call the subagent tool exactly once with agent "orch", description "C orch" and prompt "MODE=LONG". When it returns, reply: done. Nothing else.',
    D: 'Protocol probe. Call the subagent tool exactly once with agent "orch", description "D orch" and prompt "MODE=FANOUT". When it returns, reply: done. Nothing else.'
  },
  codex: {
    A: 'Protocol probe. Call spawn_agent exactly once with agent_type "orch" and message "MODE=NESTED". Wait for it. Then reply: done. Nothing else.',
    // Codex's level 1 runs the long command itself: there is no level 2 to cancel.
    C: 'Protocol probe. Call spawn_agent exactly once with agent_type "worker" and message "LONG=60". Wait for it. Then reply: done. Nothing else.'
  },
  antigravity: {
    A: 'Protocol probe. Define a subagent named "orch" whose job is: define a subagent named "worker" that runs the shell command `echo L2` and reports "WORKER DONE"; invoke worker and wait; then report "ORCH FINAL". Invoke orch and wait for it. Then reply: done. If you have no subagent tools, reply exactly: NO SUBAGENT TOOLS.'
  }
}

/** Why a variant does not run on an engine (from the live probes of each engine's wire). */
const SKIPS: Record<LiveEngineName, Partial<Record<Variant, string>>> = {
  claude: {},
  opencode: {
    B: 'OpenCode 2.0.27: a background subagent call reports completed at once, and a resumed child streams nothing over ACP — there is no resumed generation to see'
  },
  codex: {
    B: 'Codex: no in-turn resume; a send_input to an ended agent carries its old completed state, so a resumed run is not observable as a new one',
    D: 'Codex: max_depth 1 — orch has no spawn tool, so a fan-out of workers with leaves cannot happen (A already covers the degraded end)'
  },
  antigravity: {
    B: 'Antigravity: Cinna filters the subagent tools out, so there is nothing to background or resume',
    C: 'Antigravity: Cinna filters the subagent tools out, so there is no subagent to cancel',
    D: 'Antigravity: Cinna filters the subagent tools out, so there is no fan-out'
  }
}

function promptFor(variant: Variant): string {
  const skip = SKIPS[ENGINE][variant]
  test.skip(skip !== undefined, skip ?? '')
  const prompt = PROMPTS[ENGINE][variant]
  if (!prompt) throw new Error(`no ${variant} prompt for ${ENGINE}`)
  return prompt
}

/* ------------------------------------------------------------------- arrange */

async function arrange(cinna: CinnaApp): Promise<{ agentId: string; folder: string }> {
  await cinna.skipOnboarding()
  console.log(`live-subagents engine: ${await seedLiveModel(cinna)}`)
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, 'Runs subagent protocol probes.')
  if (!agent.path) throw new Error('the scaffolded agent has no folder')
  await useLiveRuntime(cinna, agent.id)
  for (const prompt of ['workflow', 'entrypoint'] as const) {
    const outcome = await cinna.page.evaluate(async ({ agentId, prompt, value }) => {
      const doc = await window.api.localAgents.readDoc({ agentId, prompt })
      if (!doc.stamp) throw new Error(`${doc.relPath} does not exist`)
      return window.api.localAgents.updateField({ agentId, update: { field: 'prompt', prompt, value }, expectedStamp: doc.stamp })
    }, { agentId: agent.id, prompt, value: WORKFLOW })
    expect(outcome.ok, `${prompt} prompt saved`).toBe(true)
  }
  WRITE_AGENTS[ENGINE]?.(agent.path)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return { agentId: agent.id, folder: agent.path }
}

/* ----------------------------------------------------------------- locators */

const composer = (cinna: CinnaApp, name = IDLE): Locator => cinna.page.getByRole('combobox', { name, exact: true })
/** The Subagents badge, present only while a subagent runs. */
const subagentBadge = (cinna: CinnaApp): Locator => cinna.page.getByRole('button', { name: /\bsubagents? running$/ })
/** A sub-thread's header button (named by the spawn's description), within `scope`. */
const header = (scope: Pick<Locator, 'getByRole'>, name: string): Locator =>
  scope.getByRole('button', { name, exact: true })
/** The sub-thread itself: header row → thread root. */
const thread = (head: Locator): Locator => head.locator('xpath=../..')
const steps = (scope: Locator): Locator => scope.getByRole('button', { name: /^(Expand|Collapse) \d+ steps?$/ })

/* --------------------------------------------------------------- the turn */

async function openAgentComposer(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await cinna.page.locator('.app-sidebar-wrap').getByRole('button', { name: AGENT, exact: true }).click()
  await expect(cinna.page.getByRole('heading', { level: 1, name: AGENT })).toBeVisible()
}

async function send(cinna: CinnaApp, agentId: string, text: string): Promise<string> {
  await composer(cinna).fill(text)
  await composer(cinna).press('Enter')
  await expect(composer(cinna, RUNNING)).toBeVisible({ timeout: 60_000 })
  let chatId = ''
  await expect.poll(async () => {
    const chats = await cinna.page.evaluate(() => window.api.chat.list())
    chatId = chats.find((chat) => chat.agentId === agentId)?.id ?? ''
    return chatId
  }, { message: 'the chat with the agent exists' }).not.toBe('')
  return chatId
}

/**
 * Answer any permission ask on screen with Allow once (OpenCode asks for every
 * `subagent` call and shell command; the others may ask for a command). Called
 * between polls of whatever the test is waiting on.
 */
async function answerAsks(cinna: CinnaApp): Promise<void> {
  const allow = cinna.page.getByRole('button', { name: 'Allow once', exact: true })
  if (await allow.count() > 0) await allow.first().click({ timeout: 2_000 }).catch(() => undefined)
}

/** Wait, answering asks meanwhile, until `probe` is true. */
async function until(cinna: CinnaApp, message: string, probe: () => Promise<boolean>, timeout = TURN_MS): Promise<void> {
  await expect.poll(async () => {
    await answerAsks(cinna)
    return probe()
  }, { message, timeout, intervals: [1_000] }).toBe(true)
}

interface ChatState {
  activeRunId: string | null
  assistant: string[]
  parts: { kind: string; toolName?: string; toolId?: string; text: string; parentToolId?: string }[]
  items: { title: string; state: string }[]
}

async function chatState(cinna: CinnaApp, chatId: string): Promise<ChatState> {
  return cinna.page.evaluate(async (id) => {
    const chat = await window.api.chat.get(id)
    const activity = await window.api.sessionActivity.get(id)
    const assistant = (chat?.messages ?? []).filter((m) => m.role === 'assistant')
    return {
      activeRunId: chat?.activeRunId ?? null,
      assistant: assistant.map((m) => m.content),
      parts: assistant.flatMap((m) => (m.parts ?? []).map((p) => ({ kind: p.kind, toolName: p.toolName, toolId: p.toolId, text: p.text, parentToolId: p.parentToolId }))),
      items: activity.ok ? activity.snapshot.items.map((item) => ({ title: item.title, state: item.state })) : []
    }
  }, chatId)
}

/** The turn (and any follow-up turn the agent starts) is over: no run, nothing running. */
async function settled(cinna: CinnaApp, chatId: string, extra: (s: ChatState) => boolean = () => true): Promise<ChatState> {
  let last: ChatState | null = null
  await until(cinna, 'the turn ends with nothing left running', async () => {
    last = await chatState(cinna, chatId)
    return last.activeRunId === null && last.items.every((item) => item.state !== 'running') && extra(last)
  })
  await expect(composer(cinna)).toBeVisible()
  await expect(subagentBadge(cinna)).toHaveCount(0)
  return last as unknown as ChatState
}

/** The chat is still usable: a follow-up gets an answer that is not in its prompt. */
async function followUpWorks(cinna: CinnaApp, chatId: string): Promise<void> {
  await composer(cinna).fill(FOLLOW_UP)
  await composer(cinna).press('Enter')
  await until(cinna, 'the follow-up is answered', async () => {
    const state = await chatState(cinna, chatId)
    // The reply's last text part: a Claude root may first answer a late
    // background notice (`noted`) in the same message.
    const last = state.parts.filter((p) => p.kind === 'text' && !p.parentToolId).at(-1)?.text ?? ''
    return state.activeRunId === null && /^\s*144\.?\s*$/.test(last)
  }, 3 * 60_000)
  await expect(cinna.page.getByRole('paragraph').filter({ hasText: /^\s*144\.?\s*$/ })).toBeVisible()
  await expect(subagentBadge(cinna)).toHaveCount(0)
}

/** The root's own last word, `done`, as a paragraph of its reply. */
const rootDone = (cinna: CinnaApp): Locator => cinna.page.getByRole('paragraph').filter({ hasText: /^\s*done\.?\s*$/i })

/** Open a folded thread (compact mode folds a finished one) and return its body. */
async function openThread(head: Locator): Promise<Locator> {
  if (await head.getAttribute('aria-expanded') === 'false') await head.click()
  await expect(head).toHaveAttribute('aria-expanded', 'true')
  return thread(head)
}

/**
 * A level's report, on screen inside `scope`. OpenCode's subagent ends with its
 * reply, drawn as text in its thread; a Claude subagent ends with a
 * `SubagentHandback` call whose `message` is the report (the caller gets it as
 * a message, not as the Agent result), so it is read by opening the thread's
 * steps and that call — what a user does to see it.
 */
async function expectReport(scope: Locator, text: string): Promise<void> {
  await unfoldAll(scope)
  await expect(scope.getByText(text).first()).toBeVisible()
}

/**
 * Open every folded thing inside `scope` — sub-threads, step groups, tool
 * calls — the way a reader clicks down a transcript. The first folded button
 * in document order is never inside another folded block (that block's own
 * header would come first), so it is always the one on screen to click.
 */
async function unfoldAll(scope: Locator): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const folded = scope.locator('button[aria-expanded="false"]')
    if (await folded.count() === 0) return
    await folded.first().click()
  }
  throw new Error('more than 60 folded blocks: the transcript is not what this test arranged')
}

/** A text part of the agent's own reply reading exactly `word`. */
const saidWord = (state: ChatState, word: string): boolean =>
  state.parts.some((p) => p.kind === 'text' && !p.parentToolId && new RegExp(`^\\s*${word}\\.?\\s*$`, 'i').test(p.text))

/**
 * An activity item's title for a spawn: Claude names it by the call's
 * description, OpenCode by the agent it runs (the sub-thread header is the
 * description on both).
 */
const itemTitle = (description: string, agent: string): string => (ENGINE === 'opencode' ? agent : description)
const expectedTitles = (...spawns: [string, string][]): string[] => spawns.map(([d, a]) => itemTitle(d, a)).sort()

const titles = (state: ChatState): string[] => state.items.map((item) => item.title).sort()
const states = (state: ChatState): string[] => [...new Set(state.items.map((item) => item.state))]

/* ------------------------------------------------------------------- tests */

test('@live A foreground nesting: orch → worker → echo L2, every level reports, the root says done', async ({ cinna }) => {
  test.setTimeout(10 * 60_000)
  const prompt = promptFor('A')
  const { agentId } = await arrange(cinna)
  await openAgentComposer(cinna)
  const chatId = await send(cinna, agentId, prompt)
  const state = await settled(cinna, chatId)
  console.log(`live-subagents A ${ENGINE}: items ${JSON.stringify(state.items)}`)

  if (ENGINE === 'claude' || ENGINE === 'opencode') {
    await test.step('the worker’s thread sits inside orch’s, its own steps inside it, each with its report', async () => {
      await expect(rootDone(cinna)).toBeVisible()
      const orch = await openThread(header(cinna.page, 'A orch'))
      const workerHead = header(orch, 'fg worker')
      await expect(workerHead).toHaveCount(1)
      const worker = await openThread(workerHead)
      await expect(steps(worker).first()).toBeVisible()
      await expectReport(worker, 'WORKER DONE')
      if (ENGINE === 'claude') await expect(worker.getByRole('button', { name: 'Tool: Bash', exact: true })).toBeVisible()
      await expectReport(orch, 'ORCH FINAL')
      // Nothing of the subagents' was drawn as the root's own: one thread at the top.
      await expect(header(cinna.page, 'fg worker')).toHaveCount(1)
    })
    await test.step('both items completed', async () => {
      expect(titles(state)).toEqual(expectedTitles(['A orch', 'orch'], ['fg worker', 'worker']))
      expect(states(state)).toEqual(['completed'])
    })
  } else if (ENGINE === 'codex') {
    await test.step('degraded-clean: one level-1 item completed, its report in the wait output, no second level', async () => {
      expect(state.items).toEqual([{ title: 'MODE=NESTED', state: 'completed' }])
      const waits = new Set(state.parts.filter((p) => p.kind === 'tool' && p.toolName === 'wait').map((p) => p.toolId))
      const report = state.parts.filter((p) => p.kind === 'tool_result' && waits.has(p.toolId)).map((p) => p.text.trim()).join('\n')
      console.log(`live-subagents A codex: wait output ${JSON.stringify(report)}`)
      // orch has no spawn tool at depth 1: it says so, or claims success (the model's choice, not Cinna's).
      expect(report).toMatch(/^(NO SPAWN TOOL|ORCH FINAL)$/)
      await expect(rootDone(cinna)).toBeVisible()
      // On screen: the steps opened, the wait call's Output shows orch's report.
      for (const group of await cinna.page.getByRole('button', { name: /^Expand \d+ steps?$/ }).all()) await group.click()
      const wait = cinna.page.getByRole('button', { name: 'Tool: wait', exact: true })
      await expect(wait).toHaveCount(1)
      await wait.locator('xpath=following::button[normalize-space()="Output"][1]').click()
      await expect(cinna.page.getByText(report, { exact: true })).toBeVisible()
    })
  } else {
    await test.step('degraded-clean: no subagent was started and nothing is left running', async () => {
      expect(state.items).toEqual([])
      console.log(`live-subagents A antigravity: reply ${JSON.stringify(state.assistant.at(-1) ?? '')}`)
    })
  }

  await test.step('the chat takes a follow-up', () => followUpWorks(cinna, chatId))
})

test('@live B background orch reports early, the root resumes it, the resumed run reports ORCH FINAL', async ({ cinna }) => {
  test.setTimeout(12 * 60_000)
  const prompt = promptFor('B')
  const { agentId } = await arrange(cinna)
  await openAgentComposer(cinna)
  const chatId = await send(cinna, agentId, prompt)
  // The root's turns: `launched`, then (a turn Claude starts itself) `resumed`, then `done`.
  const state = await settled(cinna, chatId, (s) => saidWord(s, 'done'))
  console.log(`live-subagents B ${ENGINE}: items ${JSON.stringify(state.items)} replies ${JSON.stringify(state.assistant)}`)

  await expect(rootDone(cinna)).toBeVisible()
  const orch = await openThread(header(cinna.page, 'B orch'))
  // Both workers — the background one of the first run and the foreground one
  // of the resumed run — sit inside orch's one thread, nowhere else.
  await expect(header(orch, 'bg worker')).toHaveCount(1)
  await expect(header(orch, 'fg worker')).toHaveCount(1)
  await expect(header(cinna.page, 'fg worker')).toHaveCount(1)
  // The early report and the resumed generation's report both reached the transcript.
  await expectReport(orch, 'INTERIM: worker launched')
  await expectReport(orch, 'ORCH FINAL')
  // The resume is a run of its own: orch's item twice (more only if the model resumed it again).
  expect(titles(state).filter((t) => t !== 'B orch')).toEqual(['bg worker', 'fg worker'])
  expect(titles(state).filter((t) => t === 'B orch').length).toBeGreaterThanOrEqual(2)
  expect(states(state)).toEqual(['completed'])

  await test.step('the chat takes a follow-up', () => followUpWorks(cinna, chatId))
})

test('@live C Stop while the worker runs a long command ends the whole tree as stopped', async ({ cinna }) => {
  test.setTimeout(10 * 60_000)
  const prompt = promptFor('C')
  const { agentId } = await arrange(cinna)
  await openAgentComposer(cinna)
  const chatId = await send(cinna, agentId, prompt)

  await test.step('the worker is visibly running its command', async () => {
    if (ENGINE === 'codex') {
      // Codex shows its level-1 subagent as an item only; its own shell calls never reach the root.
      await until(cinna, 'the worker shows as a running subagent', async () => (await subagentBadge(cinna).count()) === 1)
      await expect(subagentBadge(cinna)).toHaveAccessibleName('1 subagent running')
    } else {
      await until(cinna, 'orch and the worker both run, the worker inside orch', async () =>
        (await header(thread(header(cinna.page, 'C orch')), 'long worker').count()) === 1 &&
        (await cinna.page.getByRole('button', { name: '2 subagents running', exact: true }).count()) === 1)
      const worker = thread(header(cinna.page, 'long worker'))
      await until(cinna, 'the worker’s long command has started', async () =>
        (await worker.getByRole('button', { name: /^Tool: / }).count()) > 0 || (await steps(worker).count()) > 0)
    }
  })

  const stoppedAt = Date.now()
  await test.step('Stop ends the turn and every item promptly', async () => {
    await cinna.page.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(composer(cinna)).toBeVisible({ timeout: 30_000 })
    await expect(subagentBadge(cinna)).toHaveCount(0, { timeout: 30_000 })
    const state = await settled(cinna, chatId)
    console.log(`live-subagents C ${ENGINE}: stopped in ${Date.now() - stoppedAt} ms, items ${JSON.stringify(state.items)}`)
    if (ENGINE === 'codex') expect(state.items).toEqual([{ title: 'LONG=60', state: 'stopped' }])
    else {
      expect(titles(state)).toEqual(expectedTitles(['C orch', 'orch'], ['long worker', 'worker']))
      expect(states(state)).toEqual(['stopped'])
    }
    expect(state.assistant.join('\n')).not.toMatch(/ORCH FINAL|WORKER DONE/)
  })

  await test.step('the chat takes a follow-up', () => followUpWorks(cinna, chatId))
})

test('@live D fan-out: two workers under orch, a leaf under each, every report on screen', async ({ cinna }) => {
  test.setTimeout(12 * 60_000)
  const prompt = promptFor('D')
  const { agentId } = await arrange(cinna)
  await openAgentComposer(cinna)
  const chatId = await send(cinna, agentId, prompt)
  const state = await settled(cinna, chatId)
  console.log(`live-subagents D ${ENGINE}: items ${JSON.stringify(state.items)}`)

  await expect(rootDone(cinna)).toBeVisible()
  const orch = await openThread(header(cinna.page, 'D orch'))
  for (const name of ['worker one', 'worker two']) {
    const worker = await openThread(header(orch, name))
    const leaf = await openThread(header(worker, 'leaf'))
    await expectReport(leaf, 'LEAF DONE')
    await expectReport(worker, 'WORKER DONE')
  }
  await expect(header(cinna.page, 'leaf')).toHaveCount(2)
  await expectReport(orch, 'ORCH FINAL')
  expect(titles(state)).toEqual(expectedTitles(['D orch', 'orch'], ['worker one', 'worker'], ['worker two', 'worker'], ['leaf', 'leaf'], ['leaf', 'leaf']))
  expect(states(state)).toEqual(['completed'])

  await test.step('the chat takes a follow-up', () => followUpWorks(cinna, chatId))
})
