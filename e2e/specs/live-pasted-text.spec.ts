import { randomBytes } from 'node:crypto'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { LIVE_ENGINE, liveEngineOptions, requireLiveEngine, seedLiveModel, useLiveRuntime } from '../fixtures/liveEngine'

/**
 * **A real agent reads a pasted-text block as material and the typed text as the instruction.**
 *
 * A long paste is sent inline (`src/shared/pastedText.ts`) as
 * `<pasted_text lines="N">\n…\n</pasted_text>\n\n<typed text>`. The open
 * question from the plan was whether that tag confuses any agent. This spec
 * runs one short turn per engine (`CINNA_E2E_LIVE_ENGINE=opencode|claude|codex|antigravity`).
 *
 * Arrange: a kit folder agent on this run's engine (`useLiveRuntime`). Act: a
 * new chat with it, a 24-line fake service log pasted through the composer's
 * real paste handler (a synthetic `text/plain` `paste` event, the path
 * `pasted-text.spec.ts` uses — the host clipboard is never read), so it
 * becomes a chip; then the typed question, sent with Enter. One log line holds
 * `ERROR code=<token>`, a random token no prompt contains, and one line is a
 * bare `</pasted_text>`, which goes out escaped as `<\/pasted_text>` — a
 * closing tag *inside* the material, before the error line.
 *
 * Witnesses: the stored user message is exactly the block (escaped line
 * included) then the typed text; the reply contains the token and not the
 * string `pasted_text` (no echo of, or complaint about, the tags); the user
 * bubble shows one paste card and no raw tag, and the card's preview gives back
 * the raw log with the unescaped line. Any ask is answered **Allow once** (at
 * most four) and recorded; none was expected and none was seen. After a pass
 * the fixture proves from main's log that the turn ran on that engine.
 *
 * ## Observed (2026-10-27)
 *
 * Two passing runs each on OpenCode, Claude and Codex. Every reply was the
 * token alone (`ZK-52036A0D`, …) — no mention of the tags, no ask, no complaint
 * about the escaped `<\/pasted_text>` line:
 * - OpenCode 2.0.27, `gpt-5.6-luna`: 16.0 s and 16.3 s. In the first run the
 *   agent made one unrelated `glob` call (`scripts/*` in its own folder) before
 *   answering; the second made none.
 * - Claude Code 2.1.311, `haiku`: 12.3 s and 12.2 s, no tool call.
 * - Codex 0.162.1, `gpt-5.6-luna`: 13.9 s and 12.8 s, no tool call.
 * - Antigravity 1.3.0, `gemini-3.8-flash-low`: **unproven**. Every turn but one
 *   was answered, as the reply text, `The prompt could not be submitted. The
 *   prompt contains sensitive words that violate Google's [Generative AI
 *   Prohibited Use policy](…)`. It is not the tag: the same refusal came back
 *   with no paste at all (`What is 2+2? Reply with the number only.`), on
 *   `gemini-3.8-flash-medium`, and on the existing
 *   `live-attachments.spec.ts` Antigravity test; the log typed inline with no
 *   tag passed once and was refused the next time. The test fails on that
 *   refusal with its own message rather than on the token.
 *
 * ## Cost
 *
 * One short turn per engine. OpenCode bills the `.env` OpenAI key (about a
 * cent); Claude, Codex and Antigravity spend the developer's own login through
 * the real-`HOME` exception (`realLogin.ts`). Run one engine at a time:
 * - `make e2e-one SPEC=e2e/specs/live-pasted-text.spec.ts` (OpenCode)
 * - `CINNA_E2E_LIVE_MODEL=haiku make e2e-one SPEC=e2e/specs/live-pasted-text.spec.ts LIVE_ENGINE=claude`
 * - `make e2e-one SPEC=e2e/specs/live-pasted-text.spec.ts LIVE_ENGINE=codex`
 * - `make e2e-one SPEC=e2e/specs/live-pasted-text.spec.ts LIVE_ENGINE=antigravity`
 *
 * ## What it does not prove
 *
 * Several pastes in one message, a paste with no typed text, a queued or
 * merged message, a transcript replayed after a session restart, or the
 * plain-LLM chat runtime. The chip, card and clamp mechanics are
 * `pasted-text.spec.ts` (model-free).
 */

const AGENT = 'Log Reader'
const PROMPT = 'What is the error code in the pasted log? Reply with the code only.'
const LABEL = 'gateway service log'

interface Turn {
  reply: string
  errors: string[]
  tools: Array<{ toolName?: string; toolInput?: unknown; text: string }>
  userText: string
}

function fakeLog(token: string): string[] {
  const lines = [LABEL]
  for (let i = 1; i <= 22; i++) {
    const at = `2026-10-27 09:00:${String(i).padStart(2, '0')}`
    if (i === 14) lines.push('</pasted_text>')
    else if (i === 17) lines.push(`${at} ERROR code=${token} upstream refused the request`)
    else lines.push(`${at} INFO request ${1000 + i} served in ${10 + i} ms`)
  }
  lines.push('end of log')
  return lines
}

/** The one chat of this run, as main stores it. */
async function onlyTurn(cinna: CinnaApp): Promise<Turn | null> {
  return cinna.page.evaluate(async () => {
    const rows = await window.api.chat.list()
    if (rows.length === 0) return null
    const chat = await window.api.chat.get(rows[0].id)
    if (!chat) return null
    const assistant = chat.messages.filter((m) => m.role === 'assistant')
    const parts = assistant.flatMap((m) => m.parts ?? [])
    return {
      reply: assistant.map((m) => m.content).join('\n'),
      errors: chat.messages.filter((m) => m.role === 'error').map((m) => m.content.slice(0, 500)),
      tools: parts.filter((p) => p.kind === 'tool').map((p) => ({ toolName: p.toolName, toolInput: p.toolInput, text: p.text })),
      userText: chat.messages.find((m) => m.role === 'user')?.content ?? ''
    }
  })
}

test.describe('@live', () => {
  test.use(liveEngineOptions())
  test.beforeEach(() => requireLiveEngine())

  test(`@live an agent answers from a pasted-text block and the typed instruction (${LIVE_ENGINE.label})`, async ({ cinna }) => {
    test.setTimeout(6 * 60_000)
    await cinna.skipOnboarding()
    const model = await seedLiveModel(cinna)
    await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
    const root = await addAgentRoot(cinna)
    const agent = await createFolderAgent(cinna, root, AGENT, 'Answers questions about text the user gives it.')
    await useLiveRuntime(cinna, agent.id)

    const token = `ZK-${randomBytes(4).toString('hex').toUpperCase()}`
    const logLines = fakeLog(token)
    const log = logLines.join('\n')
    expect(PROMPT).not.toContain(token)

    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())

    const page = cinna.page
    const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
    await test.step('a new chat with the agent, the log pasted as a chip', async () => {
      await page.getByRole('button', { name: 'Agents', exact: true }).click()
      await answerAgentsFolder(cinna)
      await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
      await expect(page.getByRole('heading', { name: 'What can I help with?', level: 1 })).toBeVisible()
      await input.focus()
      const prevented = await page.evaluate((text) => {
        const target = document.activeElement
        if (!(target instanceof HTMLTextAreaElement)) throw new Error('the composer is not focused')
        const data = new DataTransfer()
        data.setData('text/plain', text)
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
        target.dispatchEvent(event)
        return event.defaultPrevented
      }, log)
      expect(prevented).toBe(true)
      await expect(page.getByTestId('paste-badge')).toHaveText(`${LABEL}· ${logLines.length} lines`)
      await expect(input).toHaveValue('')
    })

    await input.fill(PROMPT)
    await input.press('Enter')

    const asks: string[] = []
    let turn: Turn | null = null
    await test.step('the turn ends; any ask is answered Allow once and recorded', async () => {
      await expect.poll(async () => {
        const ask = page.getByText(/^The agent is asking to /)
        if ((await ask.count()) > 0) {
          if (asks.length >= 4) return 'too many asks'
          asks.push(await ask.first().locator('xpath=..').innerText())
          await page.getByRole('button', { name: 'Allow once', exact: true }).first().click()
          await expect(ask).toHaveCount(0)
          return 'answered an ask'
        }
        turn = await onlyTurn(cinna)
        if (turn && turn.errors.length > 0) return `error: ${turn.errors[0]}`
        const busy = (await page.getByRole('button', { name: 'Stop', exact: true }).count()) > 0
        return !busy && turn !== null && turn.reply.trim() !== '' ? 'done' : 'running'
      }, { message: 'the turn ends', timeout: 4 * 60_000, intervals: [1000] }).toBe('done')
    })

    const settled = turn as unknown as Turn
    test.info().annotations.push(
      { type: 'model', description: model },
      { type: 'asks', description: JSON.stringify(asks) },
      { type: 'tool calls', description: JSON.stringify(settled.tools.map((t) => ({ name: t.toolName, input: t.toolInput, text: t.text.slice(0, 200) }))).slice(0, 3000) },
      { type: 'reply', description: settled.reply.slice(0, 500) }
    )
    console.log(`live-pasted-text ${model}: token ${token} asks ${JSON.stringify(asks)}`)
    console.log(`live-pasted-text tools ${JSON.stringify(settled.tools.map((t) => ({ name: t.toolName, input: t.toolInput, text: t.text.slice(0, 160) })))}`)
    console.log(`live-pasted-text reply ${JSON.stringify(settled.reply.slice(0, 500))}`)

    await test.step('the agent was sent the block, its inner closing tag escaped, then the typed text', async () => {
      const body = log.replace('</pasted_text>', '<\\/pasted_text>')
      expect(settled.userText).toBe(`<pasted_text lines="${logLines.length}">\n${body}\n</pasted_text>\n\n${PROMPT}`)
    })

    await test.step('the reply is the error code, with no word about the tags', async () => {
      expect(settled.errors).toEqual([])
      // Antigravity's own refusal arrives as the reply text, not an error (see the head comment).
      expect(settled.reply, `${LIVE_ENGINE.label} refused the prompt under Google's use policy (the reply is that refusal)`).not.toMatch(/^The prompt could not be submitted/)
      expect(settled.reply).toContain(token)
      expect(settled.reply).not.toContain('pasted_text')
    })

    await test.step('the bubble shows a paste card, no raw tag, and the card gives back the raw log', async () => {
      const card = page.getByTestId('paste-card')
      await expect(card).toHaveCount(1)
      await expect(card).toHaveAccessibleName(`Open pasted text ${LABEL}`)
      await expect(card).toHaveText(`${LABEL}· ${logLines.length} lines`)
      await expect(page.getByText(PROMPT, { exact: true })).toBeVisible()
      await expect(page.getByText('<pasted_text', { exact: false })).toHaveCount(0)
      await card.click()
      const dialog = page.getByRole('dialog', { name: 'Pasted text', exact: true })
      await expect(dialog).toBeVisible()
      expect(await dialog.locator('pre').evaluate((el) => el.textContent)).toBe(log)
      await dialog.getByRole('button', { name: 'Close pasted text preview', exact: true }).click()
      await expect(dialog).toHaveCount(0)
    })
  })
})
