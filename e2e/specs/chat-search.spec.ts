import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * Chat search (⌘F / Ctrl+F): the open chat's own search, the all-chats
 * overlay, and the agent chips that narrow it.
 *
 * No model, engine or credential. Chats and their user / assistant messages
 * are written over IPC (`chat.create` / `update` / `addMessage`, with
 * `autoChatTitles` off); the agents of the chip test are hand-added A2A rows
 * on a closed loopback port, never contacted. The Chats list and its
 * summaries are not polled, so seeding is followed by a `relaunch()`.
 *
 * Each searched chat is padded with filler turns, so the transcript scrolls
 * and the matching message starts out of view: "in view" after a pick is the
 * jump's doing, not the chat's opening position.
 */

const FILLER_TURNS = 14

/** A loopback port nothing listens on: bound once, then closed. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

interface SeedChat {
  title: string
  /** Written first, oldest. */
  early: { role: 'user' | 'assistant'; content: string }[]
  /** Written after the filler, newest. */
  late?: { role: 'user' | 'assistant'; content: string }[]
  agentId?: string
}

/** Create the chats over IPC, oldest first, each padded with filler turns between `early` and `late`. */
async function seedChats(cinna: CinnaApp, chats: SeedChat[]): Promise<string[]> {
  return cinna.page.evaluate(async ({ chats, filler }) => {
    await window.api.settings.set('autoChatTitles', false)
    const ids: string[] = []
    for (const spec of chats) {
      const chat = await window.api.chat.create()
      await window.api.chat.update(chat.id, { title: spec.title, ...(spec.agentId ? { agentId: spec.agentId, router: 'direct' } : {}) })
      for (const m of spec.early) await window.api.chat.addMessage(chat.id, m)
      for (let i = 1; i <= filler; i++) {
        await window.api.chat.addMessage(chat.id, { role: 'user', content: `Filler question ${i} in ${spec.title}, about nothing in particular.` })
        await window.api.chat.addMessage(chat.id, {
          role: 'assistant',
          content: `Filler answer ${i}.\n\nA paragraph long enough to take some room in the transcript, so that the chat scrolls.\n\nAnd a second paragraph for the same reason.`
        })
      }
      for (const m of spec.late ?? []) await window.api.chat.addMessage(chat.id, m)
      ids.push(chat.id)
    }
    return ids
  }, { chats, filler: FILLER_TURNS })
}

const chatRow = (cinna: CinnaApp, title: string) =>
  cinna.page.locator('.app-sidebar-wrap').getByText(title, { exact: true })

/** A message's rendered body in the live transcript (never the switch curtain's clone). */
const messageBody = (cinna: CinnaApp, text: string) =>
  cinna.page.locator('[data-message-id]:not(.chat-transition-snapshot *)').filter({ hasText: text })

const chatField = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: 'Search this chat', exact: true })
const allField = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: 'Search all chats', exact: true })
const results = (cinna: CinnaApp) => cinna.page.getByRole('listbox', { name: 'Search results', exact: true })

/** Open a chat from the sidebar and wait for its newest message and the end of the switch curtain. */
async function openChat(cinna: CinnaApp, title: string, newest: string): Promise<void> {
  await chatRow(cinna, title).click()
  await expect(messageBody(cinna, newest)).toBeVisible()
  await expect(cinna.page.locator('.chat-transition-snapshot')).toHaveCount(0)
}

const OLD_HIT = 'The pelican colony nests on the northern cliffs every spring.'
const NEW_HIT = 'Yes — the pelican chicks fledge by late summer.'
const NEWEST_A = 'Thanks, that is all for today.'
const OTHER_TITLE = 'E2E search other chat'
const OTHER_TEXT = 'Nothing to see in this one.'

test('in one chat: ⌘F opens the bar focused, results after the pause, a pick scrolls to the message and closes, ⌘F keeps the query, Esc closes, another chat closes it', async ({ cinna }) => {
  const TITLE = 'E2E search birds chat'
  await cinna.skipOnboarding()
  await seedChats(cinna, [
    { title: OTHER_TITLE, early: [{ role: 'user', content: OTHER_TEXT }] },
    {
      title: TITLE,
      early: [{ role: 'user', content: OLD_HIT }, { role: 'assistant', content: 'Noted.' }],
      late: [
        { role: 'user', content: 'When do the chicks leave the nest?' },
        { role: 'assistant', content: NEW_HIT },
        { role: 'user', content: NEWEST_A }
      ]
    }
  ])
  await cinna.relaunch()
  await cinna.skipOnboarding()

  await openChat(cinna, TITLE, NEWEST_A)
  // The chat opens at its bottom: the older match is out of view until the jump.
  await expect(messageBody(cinna, OLD_HIT)).not.toBeInViewport()

  await test.step('⌘F: the bar, its field focused', async () => {
    await cinna.page.keyboard.press('ControlOrMeta+f')
    await expect(chatField(cinna)).toBeVisible()
    await expect(chatField(cinna)).toBeFocused()
    await expect(results(cinna)).toHaveCount(0)
  })

  await test.step('a term in two messages: two result cards, after the pause', async () => {
    await chatField(cinna).pressSequentially('pelican')
    await expect(results(cinna).getByRole('option')).toHaveCount(2)
    await expect(cinna.page.locator('[data-chat-search="chat"] .chat-search-count')).toHaveText('2 matches')
    // Newest nearest the bar: the older message is the first card.
    await expect(results(cinna).getByRole('option').first()).toContainText(OLD_HIT)
    await expect(results(cinna).getByRole('option').last()).toContainText(NEW_HIT)
  })

  await test.step('a click on the older card closes the search and scrolls that message into view', async () => {
    await results(cinna).getByRole('option').first().click()
    await expect(chatField(cinna)).toHaveCount(0)
    await expect(messageBody(cinna, OLD_HIT)).toBeInViewport()
  })

  await test.step('⌘F again: the query is still there; Esc closes', async () => {
    await cinna.page.keyboard.press('ControlOrMeta+f')
    await expect(chatField(cinna)).toBeFocused()
    await expect(chatField(cinna)).toHaveValue('pelican')
    await expect(results(cinna).getByRole('option')).toHaveCount(2)
    await cinna.page.keyboard.press('Escape')
    await expect(chatField(cinna)).toHaveCount(0)
  })

  await test.step('opening another chat while the search is open closes it', async () => {
    await cinna.page.keyboard.press('ControlOrMeta+f')
    await expect(chatField(cinna)).toBeVisible()
    await openChat(cinna, OTHER_TITLE, OTHER_TEXT)
    await expect(chatField(cinna)).toHaveCount(0)
    await expect(allField(cinna)).toHaveCount(0)
  })
})

test('all chats: ⌘F with no chat open groups results by chat, a pick opens the other chat at the message, a term with no match says so', async ({ cinna }) => {
  const FIRST = 'E2E search ferns chat'
  const SECOND = 'E2E search orchids chat'
  const FIRST_HIT = 'Water the greenhouse ferns twice a week.'
  const SECOND_HIT = 'Orchids in the greenhouse like indirect light.'
  const FIRST_NEWEST = 'Ferns done.'
  const SECOND_NEWEST = 'Orchids done.'
  await cinna.skipOnboarding()
  await seedChats(cinna, [
    { title: SECOND, early: [{ role: 'user', content: SECOND_HIT }, { role: 'assistant', content: 'Understood.' }], late: [{ role: 'user', content: SECOND_NEWEST }] },
    { title: FIRST, early: [{ role: 'assistant', content: FIRST_HIT }], late: [{ role: 'user', content: FIRST_NEWEST }] }
  ])
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await expect(cinna.page.getByRole('heading', { name: 'What can I help with?', level: 1 })).toBeVisible()

  await test.step('⌘F on the new-chat screen opens all chats: a term in two chats, grouped under both titles', async () => {
    await cinna.page.keyboard.press('ControlOrMeta+f')
    await expect(allField(cinna)).toBeFocused()
    await expect(chatField(cinna)).toHaveCount(0)
    await allField(cinna).pressSequentially('greenhouse')
    await expect(results(cinna).getByRole('region')).toHaveCount(2)
    const first = results(cinna).getByRole('region', { name: FIRST, exact: true })
    const second = results(cinna).getByRole('region', { name: SECOND, exact: true })
    await expect(first.getByRole('option')).toHaveCount(1)
    await expect(first.getByRole('option')).toContainText(FIRST_HIT)
    await expect(second.getByRole('option')).toHaveCount(1)
    await expect(second.getByRole('option')).toContainText(SECOND_HIT)
    await expect(cinna.page.locator('[data-chat-search="all"] .chat-search-count')).toHaveText('2 in 2 chats')
  })

  await test.step('a term with no match: the no-matches state', async () => {
    await allField(cinna).fill('xylophone')
    await expect(cinna.page.getByText('No matches for “xylophone”', { exact: true })).toBeVisible()
    await expect(results(cinna)).toHaveCount(0)
    await expect(cinna.page.locator('[data-chat-search="all"] .chat-search-count')).toHaveText('No matches')
    await cinna.page.keyboard.press('Escape')
    await expect(allField(cinna)).toHaveCount(0)
  })

  await openChat(cinna, FIRST, FIRST_NEWEST)

  await test.step('the Chats header’s Search chats button opens all chats over an open chat', async () => {
    await cinna.page.locator('.group\\/chats-header').hover()
    await cinna.page.getByRole('button', { name: 'Search chats', exact: true }).click()
    await expect(allField(cinna)).toBeFocused()
    await expect(allField(cinna)).toHaveValue('xylophone')
    await allField(cinna).fill('greenhouse')
    await expect(results(cinna).getByRole('region')).toHaveCount(2)
  })

  await test.step('a pick in the other chat opens it, closes the search and brings the message into view', async () => {
    await results(cinna).getByRole('region', { name: SECOND, exact: true }).getByRole('option').click()
    await expect(allField(cinna)).toHaveCount(0)
    await expect(messageBody(cinna, SECOND_NEWEST)).toHaveCount(1)
    await expect(messageBody(cinna, FIRST_NEWEST)).toHaveCount(0)
    await expect(messageBody(cinna, SECOND_HIT)).toBeInViewport()
  })
})

test('all chats: agent chips appear only after a query, filter the groups, and All agents clears the filter', async ({ cinna }) => {
  const HERON = 'Heron Agent'
  const OWL = 'Owl Agent'
  const HERON_CHAT = 'E2E search heron chat'
  const OWL_CHAT = 'E2E search owl chat'
  await cinna.skipOnboarding()
  const host = `http://127.0.0.1:${await closedPort()}`
  const agentIds = await cinna.page.evaluate(async ({ host, names }) => {
    const ids: string[] = []
    for (const name of names) {
      const made = await window.api.agents.upsert({ name, protocol: 'a2a', cardUrl: `${host}/.well-known/agent-card.json`, endpointUrl: `${host}/a2a` })
      if (!made.success || !made.id) throw new Error(`Could not create agent ${name}`)
      ids.push(made.id)
    }
    return ids
  }, { host, names: [HERON, OWL] })
  await seedChats(cinna, [
    { title: HERON_CHAT, agentId: agentIds[0], early: [{ role: 'user', content: 'Plan the marsh survey route.' }, { role: 'assistant', content: 'The marsh survey starts at dawn.' }] },
    { title: OWL_CHAT, agentId: agentIds[1], early: [{ role: 'user', content: 'Where is the marsh hide?' }] }
  ])
  await cinna.relaunch()
  await cinna.skipOnboarding()

  const chips = cinna.page.getByRole('group', { name: 'Limit to agents', exact: true })
  const chip = (name: string) => chips.getByRole('button', { name, exact: true })

  await cinna.page.keyboard.press('ControlOrMeta+f')
  await expect(allField(cinna)).toBeFocused()
  await expect(cinna.page.getByText(/^Search messages across every chat\./)).toBeVisible()
  await expect(chips).toHaveCount(0)

  await allField(cinna).pressSequentially('marsh')
  await expect(results(cinna).getByRole('region')).toHaveCount(2)
  await expect(chip('All agents')).toHaveAttribute('aria-pressed', 'true')
  await expect(chip(`${HERON} 2`)).toHaveAttribute('aria-pressed', 'false')
  await expect(chip(`${OWL} 1`)).toHaveAttribute('aria-pressed', 'false')

  await chip(`${OWL} 1`).click()
  await expect(chip(`${OWL} 1`)).toHaveAttribute('aria-pressed', 'true')
  await expect(results(cinna).getByRole('region', { name: OWL_CHAT, exact: true })).toBeVisible()
  await expect(results(cinna).getByRole('region', { name: HERON_CHAT, exact: true })).toHaveCount(0)
  await expect(cinna.page.locator('[data-chat-search="all"] .chat-search-count')).toHaveText('1 in 1 chat')

  await chip('All agents').click()
  await expect(chip('All agents')).toHaveAttribute('aria-pressed', 'true')
  await expect(results(cinna).getByRole('region')).toHaveCount(2)
})
