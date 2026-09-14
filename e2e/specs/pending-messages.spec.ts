import { test, expect, type CinnaApp } from '../fixtures/app'
import { customAcpCommand, type CustomAcpCommand } from '../fixtures/customAcpCommand'
import type { FakeAcpScript } from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'

/**
 * Messages sent while an agent turn is still running: steered into it, or
 * queued behind it.
 *
 * ## What is real
 *
 * The agent is a command-line ACP agent (no folder, no credential) whose
 * command is the scriptable fake `fakeAcpAgent.mjs`, added through the real
 * `custom-agent:test` / `custom-agent:save` handlers. Everything from the
 * composer to `_session/steering` and `session/prompt` on the fake's stdin is
 * the product: `run:start` → `runQueueService.submit`, the ACP driver's
 * steering window, `run:queue-changed`, `useRunQueue`, `QueuedMessages` and
 * `ChatInput`. The fake's JSONL log is the wire witness.
 *
 * ## How a turn is held open
 *
 * - Steering: the fake advertises `initialize._meta.steering.supported` and its
 *   prompt blocks on `awaitSteer`, so the follow-up is the only thing that lets
 *   the turn continue. A short scripted `delay` after the second chunk keeps the
 *   turn live while the live order is asserted.
 * - Queue and drain: no steering advertisement; the turn parks on a permission
 *   ask, and **Allow once** is what completes it. The drained turn runs the
 *   same script, so it asks again.
 * - Stop / edit / composer: no steering; the prompt blocks on `awaitCancel`.
 *
 * ## What it does not cover
 *
 * A real Claude Code or Codex steer, a steer that lands late (`saved`), a
 * refused drain, several queued messages merged into one turn, a message
 * addressed to a different agent in a human-routed chat, and the too-late edit
 * notice.
 */

const AGENT = 'Release Notes Fake'
const PROMPT = 'Draft the release notes for 0.4.3.'
const FOLLOW_UP = 'Mention the Linux artifacts too.'
const EDITED = 'Mention the Linux and macOS artifacts.'
const BEFORE = 'Reading the changelog: ash-3301.'
const AFTER = 'Linux artifacts added: elm-7719.'

const chunk = (text: string) => ({
  kind: 'update' as const,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
})

const identity = { agentInfo: { name: AGENT, version: '1.0.0-e2e' } }

/**
 * Advertises steering; the turn cannot continue until a steer arrives.
 *
 * The `delay` after `awaitSteer` is load-bearing: the fake releases the wait
 * before its `injected` answer is written, and the driver splits the turn at
 * the answer. With no delay the second chunk reaches the app first and merges
 * into the part before the message (the driver's own contract test waits 150ms
 * for the same reason).
 */
const STEERS: FakeAcpScript = {
  initialize: { response: { ...identity, _meta: { steering: { supported: true } } } },
  prompt: {
    emit: [chunk(BEFORE), { kind: 'awaitSteer', after: 0 }, { kind: 'delay', ms: 300 }, chunk(AFTER), { kind: 'delay', ms: 4_000 }]
  }
}

/** No steering; the turn parks on a permission ask until the user answers. */
const PARKS_ON_PERMISSION: FakeAcpScript = {
  initialize: { response: identity },
  prompt: { emit: [chunk(BEFORE), { kind: 'permission' }, chunk(AFTER)] }
}

/** No steering; the turn runs until it is stopped. */
const RUNS_UNTIL_STOPPED: FakeAcpScript = {
  initialize: { response: identity },
  prompt: { emit: [chunk(BEFORE), { kind: 'awaitCancel' }], response: { stopReason: 'cancelled' } }
}

const IDLE_PLACEHOLDER = 'Type a message...'
const RUNNING_PLACEHOLDER = 'Send a follow-up · Esc Esc to stop'

/**
 * The composer by role, not by placeholder: for ~260ms after a chat switch the
 * chat curtain (`ChatTransition`) keeps an inert, aria-hidden clone of the
 * previous view — its textarea and placeholder included — which a placeholder
 * query also matches and a role query does not.
 */
const composer = (cinna: CinnaApp, placeholder: string) =>
  cinna.page.getByRole('combobox', { name: placeholder, exact: true })
const stopButton = (cinna: CinnaApp) => cinna.page.getByRole('button', { name: 'Stop', exact: true })
const sendButton = (cinna: CinnaApp) => cinna.page.getByRole('button', { name: 'Send', exact: true })
const queuedRows = (cinna: CinnaApp) => cinna.page.locator('[data-queued-message]')

/** The command-line agent, added through the real test-then-save handlers, then a restart. */
async function arrange(cinna: CinnaApp, script: FakeAcpScript): Promise<CustomAcpCommand> {
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const peer = customAcpCommand(cinna, script)
  const saved = await cinna.page.evaluate(async ({ config, name }) => {
    const probe = await window.api.customAgents.test({ config })
    return window.api.customAgents.save({ name, config, testToken: probe.token })
  }, { config: peer.config, name: AGENT })
  expect(saved.id).toBeTruthy()
  // Agents saved over IPC are invisible to the sidebar's query until a restart.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  return peer
}

/** Agents → the agent's row → its composer; send the first message and wait for the turn to run. */
async function startTurn(cinna: CinnaApp, peer: CustomAcpCommand): Promise<string> {
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await cinna.page.getByRole('button', { name: AGENT, exact: true }).click()
  const input = composer(cinna, IDLE_PLACEHOLDER)
  await input.fill(PROMPT)
  await input.press('Enter')
  await expect(cinna.page.getByText(BEFORE, { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(stopButton(cinna)).toBeVisible()
  expect(peer.received('session/prompt').map((entry) => entry.params?.prompt)).toEqual([[{ type: 'text', text: PROMPT }]])
  const [chat] = await cinna.page.evaluate(() => window.api.chat.list())
  return chat.id
}

async function sendFollowUp(cinna: CinnaApp, text: string): Promise<void> {
  const input = composer(cinna, RUNNING_PLACEHOLDER)
  await input.fill(text)
  await input.press('Enter')
  await expect(input).toHaveValue('')
}

async function savedRows(cinna: CinnaApp, chatId: string): Promise<{ role: string; content: string }[]> {
  return cinna.page.evaluate(async (id) => {
    const detail = await window.api.chat.get(id)
    return (detail?.messages ?? []).map((message) => ({ role: message.role, content: message.content }))
  }, chatId)
}

/** The transcript's paragraphs that are one of this spec's strings, in document order. */
async function transcriptOrder(cinna: CinnaApp): Promise<string[]> {
  const known = [PROMPT, BEFORE, FOLLOW_UP, AFTER]
  const texts = await cinna.page.getByRole('paragraph').allTextContents()
  return texts.map((text) => text.trim()).filter((text) => known.includes(text))
}

test('1 a follow-up is steered into the running turn and saved between its output', async ({ cinna }) => {
  test.setTimeout(90_000)
  const peer = await arrange(cinna, STEERS)
  const chatId = await startTurn(cinna, peer)

  await test.step('the follow-up lands between the output before and after it, while the turn runs', async () => {
    await sendFollowUp(cinna, FOLLOW_UP)
    await expect.poll(() => peer.received('_session/steering').map((entry) => entry.params?.prompt))
      .toEqual([[{ type: 'text', text: FOLLOW_UP }]])
    await expect.poll(() => transcriptOrder(cinna)).toEqual([PROMPT, BEFORE, FOLLOW_UP, AFTER])
    await expect(stopButton(cinna)).toBeVisible()
    await expect(queuedRows(cinna)).toHaveCount(0)
  })

  await test.step('the turn ends and the rows are saved in that order', async () => {
    await expect(stopButton(cinna)).toHaveCount(0, { timeout: 15_000 })
    await expect.poll(() => savedRows(cinna, chatId)).toEqual([
      { role: 'user', content: PROMPT },
      { role: 'assistant', content: BEFORE },
      { role: 'user', content: FOLLOW_UP },
      { role: 'assistant', content: AFTER }
    ])
    // Steered, not sent as a turn of its own.
    expect(peer.received('session/prompt')).toHaveLength(1)
  })

  await test.step('after a restart the reopened chat shows the same order', async () => {
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.getByText(PROMPT, { exact: true }).first().click()
    await expect.poll(() => transcriptOrder(cinna)).toEqual([PROMPT, BEFORE, FOLLOW_UP, AFTER])
    await expect(cinna.page.getByText(FOLLOW_UP, { exact: true })).toHaveCount(1)
  })
})

test('2 a follow-up for a turn that cannot steer is queued, then sent as the next turn', async ({ cinna }) => {
  test.setTimeout(90_000)
  const peer = await arrange(cinna, PARKS_ON_PERMISSION)
  const chatId = await startTurn(cinna, peer)
  const row = queuedRows(cinna)

  await test.step('the follow-up shows as a queued bubble', async () => {
    await expect(cinna.page.getByRole('button', { name: 'Allow once', exact: true })).toBeEnabled()
    await sendFollowUp(cinna, FOLLOW_UP)
    await expect(row).toHaveCount(1)
    await expect(row.getByText(FOLLOW_UP, { exact: true })).toBeVisible()
    await expect(row.getByText('Queued', { exact: true })).toBeVisible()
    expect(await cinna.page.evaluate((id) => window.api.run.queueList(id), chatId))
      .toEqual({ held: false, items: [expect.objectContaining({ content: FOLLOW_UP })] })
    expect(peer.received('_session/steering')).toEqual([])
  })

  await test.step('hovering its [x] asks "Cancel?"', async () => {
    await row.getByRole('button', { name: 'Cancel queued message', exact: true }).hover()
    await expect(row.getByText('Cancel?', { exact: true })).toBeVisible()
    await expect(row.getByText('Queued', { exact: true })).toBeHidden()
    await composer(cinna, RUNNING_PLACEHOLDER).hover()
    await expect(row.getByText('Queued', { exact: true })).toBeVisible()
  })

  await test.step('the turn completes and the queued message is sent as the next turn', async () => {
    await cinna.page.getByRole('button', { name: 'Allow once', exact: true }).click()
    await expect.poll(() => peer.received('session/prompt').map((entry) => entry.params?.prompt)).toEqual([
      [{ type: 'text', text: PROMPT }],
      [{ type: 'text', text: FOLLOW_UP }]
    ])
    // The drained turn runs the same script, so it parks on its own ask.
    await cinna.page.getByRole('button', { name: 'Allow once', exact: true }).click()
    await expect(stopButton(cinna)).toHaveCount(0, { timeout: 15_000 })
  })

  await test.step('exactly one copy of the message remains, as the saved user row', async () => {
    await expect(row).toHaveCount(0)
    await expect(cinna.page.getByText(FOLLOW_UP, { exact: true })).toHaveCount(1)
    await expect.poll(async () => (await savedRows(cinna, chatId)).filter((r) => r.role === 'user').map((r) => r.content))
      .toEqual([PROMPT, FOLLOW_UP])
    expect(await cinna.page.evaluate((id) => window.api.run.queueList(id), chatId)).toEqual({ held: false, items: [] })
  })
})

test('3 Esc Esc with a message queued stops the turn and puts the text back in the input', async ({ cinna }) => {
  test.setTimeout(90_000)
  const peer = await arrange(cinna, RUNS_UNTIL_STOPPED)
  const chatId = await startTurn(cinna, peer)

  await sendFollowUp(cinna, FOLLOW_UP)
  await expect(queuedRows(cinna).getByText('Queued', { exact: true })).toBeVisible()

  const running = composer(cinna, RUNNING_PLACEHOLDER)
  await running.press('Escape')
  await running.press('Escape')

  await expect(stopButton(cinna)).toHaveCount(0)
  await expect(composer(cinna, IDLE_PLACEHOLDER)).toHaveValue(FOLLOW_UP)
  await expect(queuedRows(cinna)).toHaveCount(0)
  await expect.poll(() => peer.received('session/cancel').length).toBe(1)
  // Held, not drained: no second prompt, and nothing saved for the follow-up.
  expect(peer.received('session/prompt')).toHaveLength(1)
  expect((await savedRows(cinna, chatId)).filter((r) => r.role === 'user').map((r) => r.content)).toEqual([PROMPT])
  expect(await cinna.page.evaluate((id) => window.api.run.queueList(id), chatId)).toEqual({ held: false, items: [] })
})

test('4 ArrowUp recalls a queued message for editing, and Enter saves the edit in place', async ({ cinna }) => {
  test.setTimeout(90_000)
  const peer = await arrange(cinna, RUNS_UNTIL_STOPPED)
  const chatId = await startTurn(cinna, peer)
  const row = queuedRows(cinna)
  const input = composer(cinna, RUNNING_PLACEHOLDER)

  await sendFollowUp(cinna, FOLLOW_UP)
  await expect(row.getByText('Queued', { exact: true })).toBeVisible()

  await test.step('ArrowUp in the empty input enters edit mode', async () => {
    await input.focus()
    await input.press('ArrowUp')
    await expect(input).toHaveValue(FOLLOW_UP)
    await expect(cinna.page.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
    await expect(row.getByText('Editing', { exact: true })).toBeVisible()
    await expect(row.getByText('Queued', { exact: true })).toBeHidden()
  })

  await test.step('Enter saves the edit into the same queued bubble', async () => {
    await input.fill(EDITED)
    await input.press('Enter')
    await expect(row).toHaveCount(1)
    await expect(row.getByText(EDITED, { exact: true })).toBeVisible()
    await expect(row.getByText('Queued', { exact: true })).toBeVisible()
    await expect(input).toHaveValue('')
    await expect(cinna.page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
    await expect(cinna.page.getByText(FOLLOW_UP, { exact: true })).toHaveCount(0)
    const view = await cinna.page.evaluate((id) => window.api.run.queueList(id), chatId)
    expect(view.items.map((item) => item.content)).toEqual([EDITED])
    expect(peer.received('session/prompt')).toHaveLength(1)
  })
})

test('5 while a turn runs the composer offers Stop, and typing reveals Send without moving Stop', async ({ cinna }) => {
  test.setTimeout(90_000)
  const peer = await arrange(cinna, RUNS_UNTIL_STOPPED)
  await startTurn(cinna, peer)
  const input = composer(cinna, RUNNING_PLACEHOLDER)
  const stop = stopButton(cinna)

  await expect(input).toHaveValue('')
  await expect(stop).toBeVisible()
  await expect(stop).toHaveAttribute('title', 'Stop (Esc Esc)')
  await expect(sendButton(cinna)).toHaveCount(0)
  const before = await stop.boundingBox()
  expect(before).not.toBeNull()

  await input.pressSequentially('x')
  await expect(sendButton(cinna)).toBeVisible()
  await expect(sendButton(cinna)).toBeEnabled()
  expect(await stop.boundingBox()).toEqual(before)
  const send = await sendButton(cinna).boundingBox()
  expect(send!.x).toBeGreaterThan(before!.x + before!.width - 1)
})
