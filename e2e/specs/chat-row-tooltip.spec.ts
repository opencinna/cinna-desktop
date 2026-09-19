import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * The sidebar chat row's summary tooltip: who the chat is with, who else took
 * part, when it started and how long it lasted — beside the row, hoverable,
 * one at a time, and absent for a row with nothing to say.
 *
 * Arranged entirely over IPC and with no model, engine or credential: two
 * hand-added A2A agents on a closed loopback port (never contacted — no turn
 * runs), a chat mode with no credential, and messages written through
 * `chat:add-message`. The summaries query is unpolled, so the seeding is
 * followed by a `relaunch()`.
 */

const AGENT = 'Tooltip Primary Agent'
const OTHER = 'Tooltip Second Agent'
const MODE = 'Tooltip Research Mode'
const AGENT_CHAT = 'E2E tooltip agent chat'
const MODE_CHAT = 'E2E tooltip mode chat'
const EMPTY_CHAT = 'E2E tooltip empty chat'

/** A loopback port nothing listens on: bound once, then closed. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** The row is a `div` with no role; its title span is its first child. */
const row = (cinna: CinnaApp, title: string) =>
  cinna.page.getByText(title, { exact: true }).locator('xpath=..')

test('a chat row shows a hoverable summary tooltip beside it, one at a time, and none for an empty chat', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const host = `http://127.0.0.1:${await closedPort()}`

  const seeded = await cinna.page.evaluate(async (input) => {
    await window.api.settings.set('autoChatTitles', false)
    const agentIds: string[] = []
    for (const name of [input.agent, input.other]) {
      const made = await window.api.agents.upsert({ name, protocol: 'a2a',
        cardUrl: `${input.host}/.well-known/agent-card.json`, endpointUrl: `${input.host}/a2a` })
      if (!made.success || !made.id) throw new Error(`Could not create agent ${name}`)
      agentIds.push(made.id)
    }
    const mode = await window.api.chatModes.upsert({ name: input.mode, colorPreset: 'blue' })

    // Oldest first: the list is newest-first, so the agent chat ends on top.
    const empty = await window.api.chat.create()
    await window.api.chat.update(empty.id, { title: input.emptyChat })

    const plain = await window.api.chat.create()
    await window.api.chat.update(plain.id, { title: input.modeChat, modeId: mode.id })
    await window.api.chat.addMessage(plain.id, { role: 'user', content: 'What is a tooltip?' })

    const bound = await window.api.chat.create()
    await window.api.chat.update(bound.id, { title: input.agentChat, agentId: agentIds[0], router: 'direct' })
    await window.api.chat.addOnDemandAgent(bound.id, agentIds[1])
    await window.api.chat.addMessage(bound.id, { role: 'user', content: 'First question' })
    await window.api.chat.addMessage(bound.id, { role: 'assistant', content: 'First answer' })
    await window.api.chat.addMessage(bound.id, { role: 'user', content: 'Second question' })

    const summaries = await window.api.chat.listSummaries()
    return { empty: summaries[empty.id], plain: summaries[plain.id], bound: summaries[bound.id], boundId: bound.id }
  }, { host, agent: AGENT, other: OTHER, mode: MODE, agentChat: AGENT_CHAT, modeChat: MODE_CHAT, emptyChat: EMPTY_CHAT })

  // What main believes, before any screen is involved.
  expect(seeded.bound).toMatchObject({ with: { kind: 'agent', name: AGENT }, others: [OTHER], messageCount: 3 })
  expect(seeded.plain).toMatchObject({ with: { kind: 'mode', name: MODE }, others: [], messageCount: 1 })
  expect(seeded.empty).toMatchObject({ with: { kind: 'none', name: '' }, others: [], messageCount: 0 })

  await cinna.relaunch()
  await cinna.skipOnboarding()

  const tooltip = cinna.page.getByRole('tooltip')
  await expect(row(cinna, AGENT_CHAT)).toBeVisible()
  await expect(tooltip).toHaveCount(0)

  await test.step('the agent chat: who, who else, when, how long — beside the row', async () => {
    await row(cinna, AGENT_CHAT).hover()
    await expect(tooltip).toHaveCount(1)
    await expect(tooltip).toBeVisible()
    await expect(tooltip.getByText(AGENT, { exact: true })).toBeVisible()
    await expect(tooltip.getByText(`with ${OTHER}`, { exact: true })).toBeVisible()
    await expect(tooltip.getByText('chat mode', { exact: true })).toHaveCount(0)
    // Three messages written within one second of each other, today.
    await expect(tooltip.locator('dt')).toHaveText(['Started', 'Lasted'])
    await expect(tooltip.locator('dd').nth(0)).toHaveText(/^Today /)
    await expect(tooltip.locator('dd').nth(1)).toHaveText('under a minute · 3 messages')
    await expect(row(cinna, AGENT_CHAT)).toHaveAttribute('aria-describedby', (await tooltip.getAttribute('id')) ?? 'missing')

    const rowBox = await row(cinna, AGENT_CHAT).boundingBox()
    const tipBox = await tooltip.boundingBox()
    if (!rowBox || !tipBox) throw new Error('row or tooltip has no box')
    const gap = tipBox.x - (rowBox.x + rowBox.width)
    expect(gap).toBeGreaterThan(0)
    expect(gap).toBeLessThanOrEqual(10)
    expect(Math.abs(tipBox.y - rowBox.y)).toBeLessThanOrEqual(1)
  })

  await test.step('the pointer crosses the gap onto the tooltip and it stays; far away, it goes', async () => {
    const rowBox = await row(cinna, AGENT_CHAT).boundingBox()
    const tipBox = await tooltip.boundingBox()
    if (!rowBox || !tipBox) throw new Error('row or tooltip has no box')
    const y = rowBox.y + rowBox.height / 2
    await cinna.page.mouse.move(rowBox.x + rowBox.width - 4, y)
    await cinna.page.mouse.move(tipBox.x + 40, tipBox.y + tipBox.height / 2, { steps: 12 })

    // Twice the 200 ms closing delay, sampled throughout: never gone in between.
    const counts: number[] = []
    const since = Date.now()
    await expect.poll(async () => {
      counts.push(await tooltip.count())
      return Date.now() - since
    }, { intervals: [50] }).toBeGreaterThan(400)
    expect(counts.length).toBeGreaterThan(3)
    expect(counts.every((count) => count === 1)).toBe(true)
    await expect(tooltip.getByText(AGENT, { exact: true })).toBeVisible()

    const size = cinna.page.viewportSize() ?? await cinna.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    await cinna.page.mouse.move(size.width - 40, size.height - 200, { steps: 6 })
    await expect(tooltip).toHaveCount(0)
  })

  await test.step('the mode chat: exactly one tooltip, naming the mode as a chat mode', async () => {
    await row(cinna, AGENT_CHAT).hover()
    await expect(tooltip.getByText(AGENT, { exact: true })).toBeVisible()
    await row(cinna, MODE_CHAT).hover()
    await expect(tooltip.getByText(MODE, { exact: true })).toBeVisible()
    await expect(tooltip).toHaveCount(1)
    await expect(tooltip.getByText('chat mode', { exact: true })).toBeVisible()
    await expect(tooltip.getByText(AGENT, { exact: true })).toHaveCount(0)
    // One message: a start, and nothing that lasted.
    await expect(tooltip.locator('dt')).toHaveText(['Started'])
  })

  await test.step('the empty chat: no tooltip, and the last one ends', async () => {
    await row(cinna, EMPTY_CHAT).hover()
    await expect(tooltip).toHaveCount(0)
    await expect(row(cinna, EMPTY_CHAT)).not.toHaveAttribute('aria-describedby', /.+/)
  })

  await test.step('a click on a hovered row still opens the chat, and leaves no tooltip', async () => {
    await row(cinna, AGENT_CHAT).hover()
    await expect(tooltip).toHaveCount(1)
    await cinna.page.getByText(AGENT_CHAT, { exact: true }).click()
    await expect(cinna.page.getByText('Second question', { exact: true })).toBeVisible()
    await expect(cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })).toBeVisible()
    await expect(tooltip).toHaveCount(0)
  })
})
