import { randomBytes } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { LIVE_ENGINE, liveEngineOptions, requireLiveEngine, seedLiveModel, useLiveRuntime } from '../fixtures/liveEngine'

/**
 * **A real agent reads a folder the user mentioned from outside its own folder.**
 *
 * "Mention in Cinna" sends a path, not a file: the chip becomes the line
 * ``Referenced folder: `<abs>` `` and the agent is expected to use its own
 * tools on it. This spec asks what really happens when that folder is *outside*
 * the agent's folder — the common case for a Finder mention — on a real engine.
 *
 * Arrange: a kit folder agent on this run's engine; a folder beside the
 * agents root (in the throwaway home, outside every agent folder) holding
 * `marker.txt` with a token no prompt contains. Act: open a new chat with the
 * agent, mention the folder (`open-file` emitted on main's `app`, the event
 * Finder's Quick Action raises), send the question. An ask that appears is
 * answered **Allow once** through its own button, at most four times, and
 * recorded (its title and resources) as an annotation and on stdout.
 *
 * ## Observed (Claude Code 2.1.308, `haiku`, 2026-10-22)
 *
 * No ask of any kind. The agent made exactly one tool call, `Read` on
 * `<outside folder>/marker.txt`, and replied with the token alone. That is the
 * documented limit in `claudePermissions.ts` ("Read-only tools never arrive":
 * a `Read` runs with no `canUseTool` callback, even outside the session's
 * folder), so the desktop's permission grants never see it. The assertions are
 * written to that: no ask, a `Read` naming the marker, the token in the reply.
 * Other engines would ask (OpenCode's `external_directory`, Antigravity's
 * *Ask*) and name the tool differently, so the test skips unless the run is
 * on Claude.
 *
 * ## Cost
 *
 * One short turn (about 14 s) on the developer's own Claude subscription,
 * through the real-`HOME` exception (`realLogin.ts`). Run it on purpose:
 * `CINNA_E2E_LIVE_MODEL=haiku make e2e-one SPEC=e2e/specs/live-path-mentions.spec.ts LIVE_ENGINE=claude`.
 *
 * ## What it does not prove
 *
 * A Finder right-click (bare-mac spec), the model-free mechanics
 * (`path-mentions.spec.ts`), or a mention inside the agent's own folder.
 */

const AGENT = 'Token Reader'
const PROMPT = 'What is the token in marker.txt in the referenced folder? Reply with the token only.'

interface Turn {
  reply: string
  errors: string[]
  tools: Array<{ toolName?: string; toolInput?: unknown; text: string }>
  userText: string
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
  test.beforeEach(() => {
    requireLiveEngine()
    // The assertions are Claude's observed behaviour (a `Read` with no ask).
    test.skip(LIVE_ENGINE.name !== 'claude', 'Claude only: run with LIVE_ENGINE=claude (CINNA_E2E_LIVE_MODEL=haiku)')
  })

  test(`@live an agent reads a mentioned folder outside its own (${LIVE_ENGINE.label})`, async ({ cinna }) => {
    test.setTimeout(6 * 60_000)
    await cinna.skipOnboarding()
    const model = await seedLiveModel(cinna)
    await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
    const root = await addAgentRoot(cinna)
    const agent = await createFolderAgent(cinna, root, AGENT, 'Answers questions about files the user points it at.')
    await useLiveRuntime(cinna, agent.id)

    const token = `TOKEN-${randomBytes(4).toString('hex').toUpperCase()}`
    const outsideDir = join(cinna.sandbox.home, 'Outside Notes')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(outsideDir, 'marker.txt'), `${token}\n`)
    const outside = realpathSync(outsideDir)
    expect(outside.startsWith(realpathSync(agent.path))).toBe(false)

    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())

    const page = cinna.page
    await test.step('a new chat with the agent, then the folder mentioned into it', async () => {
      await page.getByRole('button', { name: 'Agents', exact: true }).click()
      await answerAgentsFolder(cinna)
      await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
      await expect(page.getByRole('heading', { name: 'What can I help with?', level: 1 })).toBeVisible()
      await cinna.electronApp.evaluate(({ app }, p) => {
        app.emit('open-file', { preventDefault() {} }, p)
      }, outside)
      // Outside every agent folder: no agent of its own, so the open chat's agent stays.
      await expect(page.getByTestId('path-ref-badge')).toHaveText(['Outside Notes'])
      await expect(page.getByRole('button', { name: `Remove agent ${AGENT}`, exact: true })).toBeVisible()
    })

    const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
    await input.fill(PROMPT)
    await input.press('Enter')

    const asks: string[] = []
    let turn: Turn | null = null
    await test.step('the turn ends; any ask is answered Allow once and recorded', async () => {
      await expect.poll(async () => {
        const ask = page.getByText(/^The agent is asking to /)
        if ((await ask.count()) > 0) {
          if (asks.length >= 4) return 'too many asks'
          // The block: its title and the resources listed under it.
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
    console.log(`live-path-mentions ${model}: asks ${JSON.stringify(asks)}`)
    console.log(`live-path-mentions tools ${JSON.stringify(settled.tools.map((t) => ({ name: t.toolName, input: t.toolInput, text: t.text.slice(0, 160) })))}`)
    console.log(`live-path-mentions reply ${JSON.stringify(settled.reply.slice(0, 300))}`)

    await test.step('the agent was sent the question and the folder’s reference line', async () => {
      expect(settled.userText).toBe(`${PROMPT}\n\nReferenced folder: \`${outside}\``)
    })

    await test.step('nothing was asked: the agent read the file outside its folder directly', async () => {
      expect(asks).toEqual([])
      const reads = settled.tools.filter((t) => JSON.stringify(t.toolInput ?? {}).includes(join(outside, 'marker.txt')))
      expect(reads.map((t) => t.toolName)).toEqual(['Read'])
    })

    await test.step('the reply is the token, which only marker.txt holds', async () => {
      expect(settled.errors).toEqual([])
      expect(settled.reply).toContain(token)
    })
  })
})
