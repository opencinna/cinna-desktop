import { mkdirSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { liveEngineOptions, requireLiveEngine, seedLiveModel, useLiveRuntime } from '../fixtures/liveEngine'

/**
 * @live — **a real agent uses its own skill.** A kit folder agent has one
 * authored skill, `skills/<name>/SKILL.md`, whose body holds a code word and
 * tells the agent to run `scripts/ledger.py` beside it; the script prints a
 * product of two numbers that appear only inside it. One real turn, typed into
 * the agent page's composer, asks for "the ledger code", which only the skill
 * explains. Each engine gets the skill its own way (`docs/agents/local_agents/skills.md`,
 * "Delivery"): OpenCode through `skills.paths` and its `skill` tool, Claude
 * Code as a plugin skill, Codex as a listing with the `SKILL.md` path in its
 * prompt — so the prompt names both the skill tool and the listed path.
 *
 * Witnesses, all engine-neutral: the reply holds the code word (from the
 * skill, in no prompt) and the product (computed by the script, in no file);
 * the transcript has a tool call or result naming the skill, a call that runs
 * `ledger.py`, and that call's output holding the product on stdout; the chat
 * has no error message and the turn raised no ask.
 *
 * Engine: `CINNA_E2E_LIVE_ENGINE` (`opencode` by default; `claude` / `codex`
 * on the developer's own login, `e2e/fixtures/liveEngine.ts`).
 *
 * ## Cost
 *
 * One turn of 3–5 requests. On OpenCode with gpt-4.1-mini over its
 * ~10–15k-token system prompt, about **$0.01–0.02**. Run deliberately:
 * `make e2e-one SPEC=live-skills`.
 *
 * ## What it does not prove
 *
 * Catalog skills (`live-sharing-skill-engines.spec.ts`), skill credential
 * slots, or that the agent would choose the skill unprompted: the prompt names it.
 */

test.use(liveEngineOptions())
test.beforeEach(() => requireLiveEngine())

const AGENT = 'Ledger Keeper'

/** A word no model would produce unless a file told it to. */
const randomWord = (prefix: string): string => `${prefix}${Math.floor(1000 + Math.random() * 9000)}`

interface Turn {
  reply: string
  errors: string[]
  tools: Array<{ toolId?: string; toolName?: string; toolInput?: unknown; text: string }>
  results: Array<{ toolId?: string; toolStream?: string; text: string }>
}

/** The chat whose first user message is `prompt`, as main stores it. */
async function turnOf(cinna: CinnaApp, prompt: string): Promise<Turn | null> {
  return cinna.page.evaluate(async (first) => {
    for (const row of await window.api.chat.list()) {
      const chat = await window.api.chat.get(row.id)
      if (chat?.messages.find((message) => message.role === 'user')?.content !== first) continue
      const assistant = chat.messages.filter((message) => message.role === 'assistant')
      const parts = assistant.flatMap((message) => message.parts ?? [])
      return {
        reply: assistant.map((message) => message.content).join('\n'),
        errors: chat.messages.filter((message) => message.role === 'error').map((message) => message.content.slice(0, 500)),
        tools: parts.filter((part) => part.kind === 'tool')
          .map((part) => ({ toolId: part.toolId, toolName: part.toolName, toolInput: part.toolInput, text: part.text })),
        results: parts.filter((part) => part.kind === 'tool_result')
          .map((part) => ({ toolId: part.toolId, toolStream: part.toolStream, text: part.text }))
      }
    }
    return null
  }, prompt)
}

test('@live a folder agent opens its own skill and runs the script the skill names', async ({ cinna }) => {
  test.setTimeout(6 * 60_000)
  await cinna.skipOnboarding()
  const model = await seedLiveModel(cinna)
  console.log(`live-skills model: ${model}`)
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))

  const skill = `ledger-code-${randomBytes(2).toString('hex')}`
  const word = randomWord('QUILL')
  const a = 101 + Math.floor(Math.random() * 800)
  const b = 11 + Math.floor(Math.random() * 80)
  const product = String(a * b)

  await test.step('a kit agent with one authored skill and its script', async () => {
    const root = await addAgentRoot(cinna)
    const created = await createFolderAgent(cinna, root, AGENT, 'Keeps the ledger.')
    await useLiveRuntime(cinna, created.id)
    const dir = join(created.path, 'skills', skill)
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), [
      '---',
      `name: ${skill}`,
      'description: Gives today’s ledger code. Use it whenever someone asks for the ledger code.',
      '---',
      '',
      '# The ledger code',
      '',
      `The ledger code is the code word ${word}, a hyphen, then the number the script \`scripts/ledger.py\` in this skill’s folder prints.`,
      '',
      '1. Run the script with python3, by its full path inside this skill’s folder: `python3 <this skill’s folder>/scripts/ledger.py`.',
      '2. Never compute or guess the number yourself; use exactly what the script printed.',
      `3. Answer with the code alone, for example \`${word}-<number>\`.`,
      ''
    ].join('\n'))
    writeFileSync(join(dir, 'scripts', 'ledger.py'), `print(${a} * ${b})\n`)
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    const got = await cinna.page.evaluate((id) => window.api.localAgents.get(id), created.id)
    if (!got.ok) throw new Error(got.message)
    expect((got.value.skills ?? []).map((row) => ({ name: row.name, source: row.source, deliverable: row.deliverable })))
      .toEqual([{ name: skill, source: 'authored', deliverable: true }])
    // Seeded agents reach the agent list and its composer after a restart.
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
  })

  const prompt =
    `What is today's ledger code? Use your ${skill} skill to find out: open it with your skill tool ` +
    '(or, if you have none, read its SKILL.md at the path your instructions list) and follow it exactly. ' +
    'Reply with only the ledger code.'

  await test.step('the question is typed into the agent page’s composer', async () => {
    await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
    await cinna.page.getByRole('button', { name: AGENT, exact: true }).click()
    await expect(cinna.page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
    const input = cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
    await input.fill(prompt)
    await input.press('Enter')
    await expect(cinna.page.getByRole('combobox', { name: 'Send a follow-up · Esc Esc to stop', exact: true }))
      .toBeVisible({ timeout: 30_000 })
  })

  let turn: Turn | null = null
  await test.step('the turn ends with an answer and no ask', async () => {
    const ask = cinna.page.getByText(/^The agent is asking to /)
    await expect.poll(async () => {
      if ((await ask.count()) > 0) return `ask: ${await ask.first().innerText()}`
      turn = await turnOf(cinna, prompt)
      if (turn && turn.errors.length > 0) return `error: ${turn.errors[0]}`
      const busy = (await cinna.page.getByRole('button', { name: 'Stop', exact: true }).count()) > 0
      return !busy && turn !== null && turn.reply.trim() !== '' ? 'done' : 'running'
    }, { message: 'the turn ends', timeout: 4 * 60_000, intervals: [1000] }).toBe('done')
  })

  const settled = turn as unknown as Turn
  test.info().annotations.push(
    { type: 'model', description: model },
    { type: 'tool calls', description: JSON.stringify(settled.tools.map((tool) => ({ name: tool.toolName, input: tool.toolInput, text: tool.text.slice(0, 200) }))).slice(0, 3000) },
    { type: 'reply', description: settled.reply.slice(0, 500) }
  )

  await test.step('the transcript shows the skill opened and its script run, without an error', async () => {
    expect(settled.errors).toEqual([])
    const resultsOf = (toolId: string | undefined) => settled.results.filter((result) => toolId !== undefined && result.toolId === toolId)
    // OpenCode's `skill` part has no input; the name it opened is in the paired result.
    const skillTouched = settled.tools.filter((tool) =>
      JSON.stringify(tool).includes(skill) || resultsOf(tool.toolId).some((result) => result.text.includes(skill)))
    expect(skillTouched.length, `a tool call opens or reads the ${skill} skill`).toBeGreaterThan(0)
    const scriptRuns = settled.tools.filter((tool) => JSON.stringify(tool).includes('ledger.py'))
    expect(scriptRuns.length, 'a tool call runs scripts/ledger.py').toBeGreaterThan(0)
    const outputs = scriptRuns.flatMap((tool) => resultsOf(tool.toolId))
    expect(outputs.some((result) => result.text.includes(product) && result.toolStream !== 'stderr'), `the script printed ${product}`).toBe(true)
    expect(outputs.filter((result) => result.toolStream === 'stderr'), 'the script wrote nothing to stderr').toEqual([])
  })

  await test.step('the reply carries the skill’s code word and the script’s number', async () => {
    expect(settled.reply).toContain(word)
    expect(settled.reply).toContain(product)
    await expect(cinna.page.getByText(new RegExp(`${word}\\W*${product}`)).first()).toBeVisible()
  })
})
