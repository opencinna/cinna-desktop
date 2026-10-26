import { test, expect, type CinnaApp } from '../fixtures/app'
import { heldA2aAgent } from '../fixtures/heldA2aAgent'
import type { SessionTelemetry } from '../../src/shared/sessionTelemetry'

/**
 * The composer's prompt-cache notice: an open chat whose last model request
 * was long enough ago that its prompt cache has gone cold, over a context big
 * enough to matter, says so above the composer — what the next message costs
 * and a **New chat** that opens the new-chat screen set up like this chat.
 *
 * No model, engine or credential. The agent is a loopback A2A fixture
 * (`heldA2aAgent`) that serves its card, so readiness has nothing to say — an
 * unreachable one shows "Can’t reach this agent.", which takes the notice's
 * slot — and is never sent a message. The chats are made over IPC, and each one's
 * `session_telemetry` row (the last reading main keeps per chat) is written
 * through a second handle on the sandbox database — there is no IPC that sets
 * one, and a real turn could not date its request three hours back. Main reads
 * a row once and holds it, so a `relaunch()` follows the write.
 *
 * The reading: Claude on an API key, `claude-sonnet-4-6` (priced: $3 input,
 * $3.75 5-minute write, $0.30 read per MTok), last request 3 hours ago —
 * past Anthropic's longest TTL (1 h), so `expired`, not `probably`. 120K of
 * context re-written at the 5m write rate is $0.45; read warm, $0.036 → $0.04.
 */

const AGENT = 'Writer'
const COLD = 'E2E cold chat'
const AGENT_CHAT = 'E2E agent chat'
const SMALL = 'E2E small chat'
const MODEL = 'claude-sonnet-4-6'
const HOUR = 3_600_000

const NOTICE_TEXT = 'Prompt cache expired (idle 3 h). Next message ~$0.45, not $0.04. A new chat starts without history.'

/** A Claude API-key session's last reading: `used` tokens of context, last request at `lastRequestAt`. */
function telemetryOf(chatId: string, used: number, lastRequestAt: number): SessionTelemetry {
  const tokens = { input: 2_000, output: 1_500, cacheRead: used - 2_000, cacheWrite: 0 }
  return {
    chatId,
    engine: 'claude',
    auth: { kind: 'api_key' },
    model: { selected: MODEL, resolved: MODEL, source: 'init' },
    context: { used, size: 200_000, sizeAuthoritative: true, sessionId: `session-${chatId}`, model: MODEL },
    totals: { tokens, costSource: 'estimated', turns: 1, tokenScope: 'turn', byModel: { [MODEL]: tokens }, lastTurn: tokens, bySession: {} },
    cache: { lastRequestAt, ttlMs: 5 * 60_000, ttlSource: 'observed', expiresAt: lastRequestAt + 5 * 60_000 },
    updatedAt: lastRequestAt
  }
}

/** Write `rows` into `session_telemetry` through a second handle on the sandbox database. */
async function seedTelemetry(cinna: CinnaApp, rows: SessionTelemetry[]): Promise<void> {
  await cinna.electronApp.evaluate(({ app }, input) => {
    if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${input.userData}/cinna.db`, { fileMustExist: true })
    try {
      const insert = db.prepare('INSERT OR REPLACE INTO session_telemetry (chat_id, json, updated_at) VALUES (?, ?, ?)')
      for (const row of input.rows) insert.run(row.chatId, JSON.stringify(row), row.updatedAt)
    } finally { db.close() }
  }, { userData: cinna.sandbox.userData, rows })
}

const chatRow = (cinna: CinnaApp, title: string) => cinna.page.getByText(title, { exact: true })
const notice = (cinna: CinnaApp) => cinna.page.getByRole('region', { name: 'Prompt cache notice', exact: true })

/** Open `title` from the Chats list and wait for its seeded message. */
async function openChat(cinna: CinnaApp, title: string): Promise<void> {
  await chatRow(cinna, title).click()
  await expect(cinna.page.getByText(`Hello from ${title}`, { exact: true }).first()).toBeVisible()
}

test('a cold prompt cache over a large context shows the notice; Dismiss holds across chats; New chat opens the new-chat screen set up like the chat; a small context shows none', async ({ cinna }) => {
  const a2a = await heldA2aAgent()
  try {
    await cinna.skipOnboarding()
    const agentId = await a2a.register(cinna, AGENT)

    const ids = await cinna.page.evaluate(async (input) => {
      await window.api.settings.set('autoChatTitles', false)
      const make = async (title: string, patch: Record<string, unknown>): Promise<string> => {
        const chat = await window.api.chat.create()
        await window.api.chat.update(chat.id, { title, ...patch })
        await window.api.chat.addMessage(chat.id, { role: 'user', content: `Hello from ${title}` })
        return chat.id
      }
      return {
        cold: await make(input.cold, {}),
        agentChat: await make(input.agentChat, { agentId: input.agentId, router: 'direct' }),
        small: await make(input.small, {})
      }
    }, { agentId, cold: COLD, agentChat: AGENT_CHAT, small: SMALL })

    const lastRequestAt = Date.now() - 3 * HOUR
    await seedTelemetry(cinna, [
      telemetryOf(ids.cold, 120_000, lastRequestAt),
      telemetryOf(ids.agentChat, 120_000, lastRequestAt),
      telemetryOf(ids.small, 20_000, lastRequestAt)
    ])
    await cinna.relaunch()
    await cinna.skipOnboarding()

    // What main believes, before any screen is involved.
    const seen = await cinna.page.evaluate((id) => window.api.sessionTelemetry.get(id), ids.cold)
    expect(seen).toMatchObject({ ok: true, telemetry: { context: { used: 120_000 }, cache: { lastRequestAt } } })

    await test.step('a cold cache over 120K of context: the notice, with New chat and Dismiss', async () => {
      await openChat(cinna, COLD)
      await expect(notice(cinna)).toBeVisible()
      await expect(notice(cinna).locator('p')).toHaveText(NOTICE_TEXT)
      await expect(notice(cinna).getByRole('button', { name: 'New chat', exact: true })).toBeVisible()
      await expect(notice(cinna).getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible()
    })

    await test.step('a 20K context: no notice, though the cache is just as cold', async () => {
      await openChat(cinna, SMALL)
      await expect(notice(cinna)).toHaveCount(0)
    })

    await test.step('Dismiss hides it, and it stays hidden after switching chats and back', async () => {
      await openChat(cinna, COLD)
      await expect(notice(cinna)).toBeVisible()
      await notice(cinna).getByRole('button', { name: 'Dismiss', exact: true }).click()
      await expect(notice(cinna)).toHaveCount(0)

      await openChat(cinna, SMALL)
      await openChat(cinna, COLD)
      await expect(notice(cinna)).toHaveCount(0)
    })

    await test.step('New chat from an agent chat: the new-chat screen with the same agent, nothing sent', async () => {
      const before = await cinna.page.evaluate(async (id) => ({
        chats: (await window.api.chat.list()).length,
        messages: (await window.api.chat.get(id))?.messages?.length
      }), ids.agentChat)

      await openChat(cinna, AGENT_CHAT)
      // An open chat's agent chip is the agent's name; the new-chat screen's offers removal.
      await expect(cinna.page.getByRole('button', { name: AGENT, exact: true })).toBeVisible()
      await expect(cinna.page.getByRole('button', { name: `Remove agent ${AGENT}`, exact: true })).toHaveCount(0)
      await expect(notice(cinna).locator('p')).toHaveText(NOTICE_TEXT)
      await notice(cinna).getByRole('button', { name: 'New chat', exact: true }).click()

      await expect(cinna.page.getByRole('heading', { name: 'What can I help with?', level: 1 })).toBeVisible()
      await expect(cinna.page.getByRole('button', { name: `Remove agent ${AGENT}`, exact: true })).toBeVisible()
      await expect(cinna.page.getByRole('status', { name: 'Remote agent connection', exact: true })).toBeVisible()
      await expect(notice(cinna)).toHaveCount(0)

      const after = await cinna.page.evaluate(async (id) => ({
        chats: (await window.api.chat.list()).length,
        messages: (await window.api.chat.get(id))?.messages?.length,
        chat: await window.api.chat.get(id)
      }), ids.agentChat)
      expect(after.chats).toBe(before.chats)
      expect(after.messages).toBe(before.messages)
      expect(after.chat).toMatchObject({ title: AGENT_CHAT, agentId, router: 'direct' })

      // The old chat is still there, as it was: its notice too, since nothing was sent or dismissed.
      await openChat(cinna, AGENT_CHAT)
      await expect(notice(cinna).locator('p')).toHaveText(NOTICE_TEXT)
      expect(a2a.calls).toHaveLength(0)
    })
  } finally {
    await a2a.close()
  }
})
