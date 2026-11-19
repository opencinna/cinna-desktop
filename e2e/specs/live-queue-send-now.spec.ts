import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { LIVE_ENGINE, liveEngineOptions, requireLiveEngine, seedLiveModel, useLiveRuntime } from '../fixtures/liveEngine'

/**
 * **Send now on a queued message stops a real agent's running turn, and the
 * agent answers the queued message as its next turn.**
 *
 * The scripted twin is `pending-messages.spec.ts` tests 7–12 (the wire, the
 * chip's labels, edit blocking, the drain from the head, a cancel before the
 * drain, a later plain Stop still holding). This spec asks one thing of each
 * real engine (`CINNA_E2E_LIVE_ENGINE=opencode|claude|codex|antigravity`):
 * that a turn stopped mid-tool by Send now ends stopped, not failed, and the
 * same session then takes the queued message and answers it.
 *
 * Arrange: a kit folder agent with a general persona on this run's engine
 * (`useLiveRuntime`). Act:
 * 1. The first message asks the agent to run `sleep 90` and only then reply.
 *    No ask in that turn is answered: a pending ask (Antigravity's default
 *    *Ask*, perhaps Codex) holds the turn just as well as the sleep.
 * 2. Once Stop shows, a follow-up is sent **with a small text file attached**.
 *    A message with files is always queued, never steered
 *    (`runQueueService.submit`), so it queues on Claude and Codex too, which
 *    would otherwise steer a text-only follow-up into the running turn. Its
 *    text holds a random code word no other prompt contains and asks for that
 *    word alone, no tools.
 * 3. Hover on the bubble's `Stop and send now` chip reads `Stop & send?`; click.
 *
 * Witnesses: the queued bubble and main's queue before the click; afterwards
 * no `error` row in the chat (a failed turn saves one, and it is what the
 * transcript's error banner renders) and the drain itself — a stopped turn
 * that *failed* on its way out holds the queue and puts the text back in the
 * composer instead, so a drained turn proves the stop ended `canceled`. The
 * saved user rows are the hold prompt, then the follow-up with its file; the
 * reply after it holds the code word; the composer is empty at every sample
 * and at the end; main's queue is empty and the chat's last turn `completed`.
 * Asks in the **drained** turn are answered **Allow once** (at most four) and
 * recorded. After a pass the fixture proves from main's log that the turns
 * ran on that engine.
 *
 * ## Cost
 *
 * Two short turns: the hold (stopped within seconds of starting the sleep)
 * and the answer. OpenCode bills the `.env` OpenAI key (gpt-5.6-luna, about a
 * cent); Claude (sonnet, see `liveEngine.ts`), Codex and Antigravity spend the
 * developer's own login. One engine at a time:
 * - `make e2e-one SPEC=e2e/specs/live-queue-send-now.spec.ts` (OpenCode)
 * - `make e2e-one SPEC=e2e/specs/live-queue-send-now.spec.ts LIVE_ENGINE=claude`
 * - `make e2e-one SPEC=e2e/specs/live-queue-send-now.spec.ts LIVE_ENGINE=codex`
 * - `make e2e-one SPEC=e2e/specs/live-queue-send-now.spec.ts LIVE_ENGINE=antigravity`
 *
 * ## Observed
 *
 * 2026-11-19, one passing run per engine, each the first try. On every engine
 * Send now landed before any ask was on screen (the turn was still in its
 * first model call or its `sleep`), no ask came in the drained turn, and the
 * reply was the code word alone:
 * - OpenCode 2.2.5, `gpt-5.6-luna`: 14.6 s.
 * - Claude Code 2.1.328, `sonnet`: 12.8 s.
 * - Codex 0.167.0, `gpt-5.6-luna`: 15.6 s.
 * - Antigravity 1.4.5, `gemini-3.8-flash-low`: 17.6 s.
 *
 * ## What it does not prove
 *
 * That the engine killed the `sleep` process (only that the turn ended and the
 * next one ran), several queued messages merged on a real engine, a Send now
 * on a text-only message (it would have been steered on Claude and Codex),
 * a stopped turn that fails on its way out, or the plain-LLM chat runtime.
 */

const AGENT = 'Errand Runner'
const DESCRIPTION = 'A general assistant: runs the shell commands the user asks for and answers the questions the user sends.'
const HOLD = 'Use your shell tool to run the command `sleep 90` and wait for it to finish. Only after it has finished, reply with the single word done.'
const FILE_NAME = 'send-now-note.txt'
const FILE_TEXT = 'A short note that travels with the follow-up. Nothing in it needs doing.\n'
const IDLE = 'Type a message...'
const RUNNING = 'Send a follow-up · Esc Esc to stop'

interface Transcript {
  users: Array<{ content: string; files: string[] }>
  after: string
  errors: string[]
  lastRun: string | null
}

/** The user rows of the one chat, what the assistant said after the last of them, and how its last turn ended. */
async function transcript(cinna: CinnaApp): Promise<Transcript | null> {
  return cinna.page.evaluate(async () => {
    const [row] = await window.api.chat.list()
    if (!row) return null
    const messages = (await window.api.chat.get(row.id))?.messages ?? []
    const lastUser = messages.map((message) => message.role).lastIndexOf('user')
    return {
      users: messages.filter((message) => message.role === 'user')
        .map((message) => ({ content: message.content, files: (message.attachments ?? []).map((file) => file.filename) })),
      after: messages.slice(lastUser + 1).filter((message) => message.role === 'assistant').map((message) => message.content).join('\n'),
      errors: messages.filter((message) => message.role === 'error').map((message) => message.content.slice(0, 500)),
      lastRun: row.lastRunResult?.status ?? null
    }
  })
}

test.describe('@live', () => {
  test.use(liveEngineOptions())
  test.beforeEach(() => requireLiveEngine())

  test(`@live Send now stops the running turn and the agent answers the queued message (${LIVE_ENGINE.name})`, async ({ cinna }) => {
    test.setTimeout(8 * 60_000)
    await cinna.skipOnboarding()
    const model = await seedLiveModel(cinna)
    await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
    const root = await addAgentRoot(cinna)
    const agent = await createFolderAgent(cinna, root, AGENT, DESCRIPTION)
    await useLiveRuntime(cinna, agent.id)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    if (LIVE_ENGINE.name === 'antigravity') {
      await expect.poll(() => cinna.page.evaluate(() => window.api.localTools.antigravityAuth()), { timeout: 30_000 })
        .toEqual({ state: 'logged_in' })
    }

    const page = cinna.page
    const word = `HERON-${randomBytes(3).toString('hex').toUpperCase()}`
    const followUp = `Stop waiting for that command and do not run it again. Do not use any tools and do not open the attached file. Reply with only this code word: ${word}`
    expect(HOLD).not.toContain(word)
    const downloads = homeDir(cinna, 'Downloads')
    const filePath = join(downloads, FILE_NAME)
    writeFileSync(filePath, FILE_TEXT)
    // After the last relaunch: main's OS picker answers the note.
    await cinna.electronApp.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
    }, filePath)

    const stop = page.getByRole('button', { name: 'Stop', exact: true })
    const running = page.getByRole('combobox', { name: RUNNING, exact: true })
    const queued = page.locator('[data-queued-message]')
    const ask = page.getByText(/^The agent is asking to /)

    await test.step('the first turn starts and stays running', async () => {
      await page.getByRole('button', { name: 'Agents', exact: true }).click()
      await page.getByRole('button', { name: AGENT, exact: true }).click()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
      const input = page.getByRole('combobox', { name: IDLE, exact: true })
      await input.fill(HOLD)
      await input.press('Enter')
      await expect(stop).toBeVisible({ timeout: 30_000 })
      await expect(running).toBeVisible()
    })

    await test.step('a follow-up with a file attached queues behind it', async () => {
      await page.getByRole('button', { name: 'Add to chat', exact: true }).click()
      const attach = page.getByRole('menu', { name: 'Add to chat' }).getByRole('menuitem', { name: 'Attach files' })
      await expect(attach).toBeEnabled()
      await attach.click()
      await expect(page.getByRole('button', { name: `Remove ${FILE_NAME}`, exact: true })).toBeVisible()
      await running.fill(followUp)
      await running.press('Enter')
      await expect(running).toHaveValue('')
      await expect(queued).toHaveCount(1)
      await expect(queued.getByText(followUp, { exact: true })).toBeVisible()
      await expect(queued.getByText('Queued', { exact: true })).toBeVisible()
      await expect(queued.getByRole('button', { name: `Preview ${FILE_NAME}`, exact: true })).toBeVisible()
      const view = await page.evaluate(async () => window.api.run.queueList((await window.api.chat.list())[0].id))
      expect(view.held).toBe(false)
      expect(view.items.map((item) => [item.content, (item.attachments ?? []).map((file) => file.filename)]))
        .toEqual([[followUp, [FILE_NAME]]])
      // Still the first turn, still running.
      expect((await transcript(cinna))?.users).toEqual([{ content: HOLD, files: [] }])
      await expect(stop).toBeVisible()
    })

    const onScreenAtStop = (await ask.count()) > 0 ? 'a pending ask' : 'no ask'
    await test.step('Send now reads "Stop & send?" under the pointer, and is clicked', async () => {
      const chip = queued.getByRole('button', { name: 'Stop and send now', exact: true })
      await chip.hover()
      await expect(queued.getByText('Stop & send?', { exact: true })).toBeVisible()
      await chip.click()
    })

    const asks: string[] = []
    const composerSeen: string[] = []
    let last: Transcript | null = null
    await test.step('the stopped turn ends and the queued message runs as the next turn', async () => {
      await expect.poll(async () => {
        const composer = page.getByRole('combobox', { name: new RegExp(`^(${IDLE.replace(/\./g, '\\.')}|${RUNNING})$`) })
        for (const value of await composer.evaluateAll((els) => els.map((el) => (el as HTMLTextAreaElement).value))) {
          if (value !== '') composerSeen.push(value)
        }
        last = await transcript(cinna)
        if (last && last.errors.length > 0) return `error: ${last.errors[0]}`
        // Only the drained turn's asks are answered; the first turn's was left to hold it.
        if (last && last.users.length === 2 && (await ask.count()) > 0) {
          if (asks.length >= 4) return 'too many asks'
          asks.push(await ask.first().innerText())
          await page.getByRole('button', { name: 'Allow once', exact: true }).first().click()
          return 'answered an ask'
        }
        const busy = (await stop.count()) > 0
        return !busy && (await queued.count()) === 0 && last !== null && last.users.length === 2 && last.after.trim() !== '' ? 'done' : 'running'
      }, { message: 'the drained turn ends', timeout: 5 * 60_000, intervals: [1000] }).toBe('done')
    })

    const settled = last as unknown as Transcript
    console.log(`live-queue-send-now ${model}: stopped with ${onScreenAtStop}, ${asks.length} asks after, reply ${JSON.stringify(settled.after.slice(0, 300))}`)
    test.info().annotations.push(
      { type: 'model', description: model },
      { type: 'at Send now', description: onScreenAtStop },
      { type: 'asks', description: JSON.stringify(asks) },
      { type: 'reply', description: settled.after.slice(0, 500) }
    )

    await test.step('stopped, not failed: no error row, and the queued message went as its own turn', async () => {
      expect(settled.errors).toEqual([])
      expect(settled.users).toEqual([{ content: HOLD, files: [] }, { content: followUp, files: [FILE_NAME] }])
      expect(settled.lastRun).toBe('completed')
    })

    await test.step('the reply is the code word', async () => {
      expect(settled.after, `${LIVE_ENGINE.label} refused the prompt under Google's use policy (the reply is that refusal)`).not.toMatch(/^The prompt could not be submitted/)
      expect(settled.after).toContain(word)
    })

    await test.step('nothing went back to the composer, and nothing is left queued', async () => {
      expect(composerSeen).toEqual([])
      await expect(page.getByRole('combobox', { name: IDLE, exact: true })).toHaveValue('')
      await expect(queued).toHaveCount(0)
      expect(await page.evaluate(async () => window.api.run.queueList((await window.api.chat.list())[0].id)))
        .toEqual({ held: false, items: [] })
    })
  })
})
