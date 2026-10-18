import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'
import { LIVE_ENGINE, liveEngineOptions, requireLiveEngine, seedLiveModel, useLiveRuntime } from '../fixtures/liveEngine'
import { adoptFolder } from '../fixtures/dispatcher'

/**
 * @live — **two real Claude Code sessions on one agent at the same time**, and
 * the active-session warning between them
 * (`docs/agents/local_agents/active_session_warning.md`).
 *
 * A bare folder agent on the developer's own Claude Code login (the
 * real-`HOME` exception, `realLogin.ts`), approval *Ask every time*. Chat A
 * asks it to compute 17 × 23 with a shell command, so its turn parks on the
 * permission ask and stays running for as long as the test wants — no race
 * on how fast the model writes. With A running, the agent's new-chat
 * composer shows the warning row; Send starts chat B (12 × 12, no tools),
 * which completes while A is still parked. Then the row's **Open** goes to A,
 * Allow once lets it finish, and the row is gone.
 *
 * Witnesses: each answer is a number not in its prompt (391, 144); A's turn
 * still running (`activeRunId`) when B's answer is saved; the engine check
 * (`mainLog.ts`) that the turns completed on `claude`.
 *
 * ## Running it, and cost
 *
 * Claude only (the parked ask is what makes the overlap deterministic):
 * `CINNA_E2E_LIVE_ENGINE=claude CINNA_E2E_LIVE_MODEL=simple make e2e-one SPEC=e2e/specs/live-active-sessions.spec.ts`
 * — two short turns on haiku on the developer's own Claude subscription.
 */

test.use(liveEngineOptions())
test.beforeEach(() => {
  requireLiveEngine()
  test.skip(LIVE_ENGINE.name !== 'claude', 'Claude only: chat A parks on a Claude permission ask (CINNA_E2E_LIVE_ENGINE=claude)')
})

const HEADING = 'Abacus Desk'
const PROMPT_A = 'Use your Bash tool to run exactly this command: python3 -c "print(17*23)" — then reply with only the number it printed.'
const PROMPT_B = 'What is 12 times 12? Reply with only the number. Do not use any tools.'
const INSTRUCTIONS = [
  `# ${HEADING}`,
  '',
  'You answer short arithmetic questions. Do exactly what each message asks, and reply as briefly as it asks.',
  ''
].join('\n')
const RUNNING_COMPOSER = 'Send a follow-up · Esc Esc to stop'

const panel = (cinna: CinnaApp) => cinna.page.getByRole('status', { name: 'Agent status' })
const composer = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })

async function openAgentComposer(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await cinna.page.locator('.app-sidebar-wrap').getByRole('button', { name: HEADING, exact: true }).click()
  await expect(cinna.page.getByRole('heading', { level: 1, name: HEADING })).toBeVisible()
}

async function chats(cinna: CinnaApp, agentId: string) {
  return cinna.page.evaluate(async (id) => {
    const list = await window.api.chat.list()
    const mine = list.filter((chat) => chat.agentId === id)
    return Promise.all(mine.map(async (chat) => {
      const full = await window.api.chat.get(chat.id)
      return {
        id: chat.id,
        activeRunId: full?.activeRunId ?? null,
        user: (full?.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content).join('\n'),
        assistant: (full?.messages ?? []).filter((m) => m.role === 'assistant').map((m) => m.content).join('\n')
      }
    }))
  }, agentId)
}

test('@live two real turns on one agent run side by side: the new-chat warning names the parked one, Send starts the second, and Open returns to the first', async ({ cinna }) => {
  test.setTimeout(8 * 60_000)
  await cinna.skipOnboarding()
  console.log(`live-active-sessions engine: ${await seedLiveModel(cinna)}`)
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const folder = homeDir(cinna, 'abacus-desk')
  writeFileSync(join(folder, 'CLAUDE.md'), INSTRUCTIONS)
  const agentId = await adoptFolder(cinna, folder)
  await useLiveRuntime(cinna, agentId)
  const approval = await cinna.page.evaluate((id) => window.api.localAgents.setClaudeApproval(id, 'ask'), agentId)
  expect(approval.ok, JSON.stringify(approval)).toBe(true)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  let chatA = ''
  await test.step('chat A: the agent asks to run its command, and the turn waits on the ask', async () => {
    await openAgentComposer(cinna)
    await expect(panel(cinna).getByText(/is already running in/)).toHaveCount(0)
    await composer(cinna).fill(PROMPT_A)
    await composer(cinna).press('Enter')
    await expect(cinna.page.getByText('The agent is asking to run a command')).toBeVisible({ timeout: 3 * 60_000 })
    const mine = await chats(cinna, agentId)
    expect(mine).toHaveLength(1)
    chatA = mine[0].id
    expect(mine[0].activeRunId).not.toBeNull()
  })

  let sentence = ''
  await test.step('a new chat with the agent: the warning row names chat A, and Send starts chat B beside it', async () => {
    await openAgentComposer(cinna)
    const active = await cinna.page.evaluate(() => window.api.agentSessions.active())
    expect(active.ok && active.sessions.map((s) => s.chatId)).toEqual([chatA])
    const title = active.ok ? active.sessions[0].title : null
    sentence = `${HEADING} is already running in ${title ? `“${title}”` : 'a chat'}. Make sure this request won’t conflict with it.`
    await expect(panel(cinna).getByText(sentence, { exact: true })).toBeVisible({ timeout: 15_000 })
    await composer(cinna).fill(PROMPT_B)
    await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await composer(cinna).press('Enter')
    await expect(cinna.page.getByRole('combobox', { name: RUNNING_COMPOSER, exact: true })).toBeVisible({ timeout: 30_000 })
  })

  await test.step('chat B completes with 144 while chat A is still running', async () => {
    await expect.poll(async () => (await chats(cinna, agentId)).find((chat) => chat.user.includes('12 times 12'))?.assistant ?? '',
      { timeout: 3 * 60_000, intervals: [1000] }).toMatch(/\b144\b/)
    const a = (await chats(cinna, agentId)).find((chat) => chat.id === chatA)
    expect(a?.activeRunId ?? null).not.toBeNull()
  })

  await test.step('the row’s Open goes to chat A, where Allow once lets it finish with 391', async () => {
    await expect.poll(async () => (await chats(cinna, agentId)).every((chat) => chat.id === chatA || chat.activeRunId === null), { timeout: 60_000 }).toBe(true)
    await cinna.page.getByRole('button', { name: 'New Chat', exact: true }).click()
    await openAgentComposer(cinna)
    await expect(panel(cinna).getByText(sentence, { exact: true })).toBeVisible({ timeout: 15_000 })
    await panel(cinna).getByRole('button', { name: 'Open', exact: true }).click()
    await expect(cinna.page.getByText('The agent is asking to run a command')).toBeVisible()
    await cinna.page.getByRole('button', { name: 'Allow once', exact: true }).click()
    await expect.poll(async () => (await chats(cinna, agentId)).find((chat) => chat.id === chatA)?.activeRunId ?? null,
      { timeout: 3 * 60_000, intervals: [1000] }).toBeNull()
    expect((await chats(cinna, agentId)).find((chat) => chat.id === chatA)?.assistant ?? '').toMatch(/\b391\b/)
  })

  await test.step('with nothing running, the new-chat composer has no warning row', async () => {
    await cinna.page.getByRole('button', { name: 'New Chat', exact: true }).click()
    await openAgentComposer(cinna)
    await expect(cinna.page.getByText(/is already running in/)).toHaveCount(0, { timeout: 15_000 })
  })
})
