import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * Two agents in one chat, routed by the **user**, with no LLM provider
 * configured anywhere in the sandbox.
 *
 * That is the headline of phase 4 (`19ebcd8`): before it, a second agent in a
 * chat forced the local model into the middle of it (`orchestrated`, a boolean
 * that could not say "several agents, and the *user* routes"), so somebody with
 * no AI credentials could not have two agents talk to them at all. Now the
 * composer's badge reads **You route**, a chip addresses the next message, and
 * each agent is handed the thread it missed ahead of the user's text.
 *
 * ## What is real and what is not
 *
 * The two **agents** are `node:http` servers this file owns, speaking A2A: a
 * v0.3 agent card and a JSON-RPC `message/send`, the same minimal shape
 * `driver-readiness.spec.ts` uses. Hand-added A2A agents are the one agent kind
 * that needs **no credential at all** — a folder agent's launcher refuses
 * before it spawns anything unless a credential resolves a model
 * (`configGenerator`'s `credential_unavailable` / `no_model` skips), so the
 * fake ACP harness could not have carried the "no provider anywhere" claim
 * this test exists to make. Everything between the composer and the wire is the
 * product: `newChatRouter`, `chats.router`, `run:send`'s dispatch,
 * `buildCatchUpPacket`, the per-agent cursor, the A2A driver and client.
 *
 * ## The assertion that cannot pass with the mechanism deleted
 *
 * The second agent's reply is **computed from what it was sent**: it answers
 * with the code only if the code is in its prompt, and says so plainly if it is
 * not. So `Scribe read the vault code from the thread: quince-8842` on screen
 * is the packet arriving, not merely a turn completing — with
 * `buildCatchUpPacket` returning null the same screen would read `Scribe saw no
 * vault code in what it was sent.` The wire is then asserted directly too: the
 * transcript line labelled with the *other* agent's name, the user's earlier
 * message to that agent, and the typed text last.
 *
 * ## What it proves
 *
 * - Picking a second agent in the composer moves the badge from `Remote agent
 *   connection` to `You route this chat` — no model, no credential, no chat mode.
 * - The first message goes to the first agent picked, and its reply is labelled
 *   with that agent's name in the transcript.
 * - A chip is an address: clicking the other agent's chip flips `aria-pressed`
 *   and the next message goes there.
 * - The second agent's turn carries the catch-up packet, and it is the packet
 *   that makes the answer possible.
 * - The first agent's own first turn carries **no** packet — nothing was missed.
 * - `providers.list()` and `chatModes.list()` are empty at the end, and the chat
 *   row names no provider, model or mode: nothing could have gone through
 *   `chatStreamingService`.
 *
 * ## What it does not
 *
 * The cursor's *advance* on a completed turn only as far as one round trip
 * shows it (a third message back to the first agent would pin the second
 * packet; `threadContextService.test.ts` covers the cursor arithmetic, and
 * `run.routing.test.ts` the dispatch table). The `[+]` capability picker is not
 * used and cannot be: `hasAnyDestination` hides `Add to chat` for a profile with
 * no Cinna account and no provider, which is exactly this profile. The
 * `coordinator` toggle, and any packet capping.
 */

const LEDGER = 'Ledger'
const SCRIBE = 'Scribe'

/** Produced only by the first agent; it is in neither message the user types. */
const CODE = 'quince-8842'
const LEDGER_REPLY = `Ledger here — the vault code is ${CODE}.`
/** The second agent's two possible answers. Which one it gives is the test. */
const SCRIBE_FOUND = `Scribe read the vault code from the thread: ${CODE}`
const SCRIBE_BLIND = 'Scribe saw no vault code in what it was sent.'

const MESSAGE_1 = 'Ledger, what is the vault code?'
const MESSAGE_2 = 'Scribe, write the vault code into the report.'

interface FakeAgent {
  name: string
  origin: string
  server: Server
  /** The text of every `message/send` this agent was handed, in order. */
  prompts: string[]
}

/**
 * The smallest A2A agent the desktop's client accepts, with a reply that is a
 * function of the prompt — which is what makes the catch-up packet observable
 * from the screen and not only from the wire.
 */
async function startAgent(name: string, reply: (prompt: string) => string): Promise<FakeAgent> {
  const prompts: string[] = []
  const agent = { name, origin: '', server: undefined as unknown as Server, prompts }
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          name,
          description: `A fake A2A agent owned by human-routing.spec.ts (${name})`,
          url: `${agent.origin}/a2a`,
          protocolVersion: '0.3.0',
          version: '1.0.0',
          capabilities: { streaming: false },
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          skills: []
        })
      )
      return
    }
    if (req.method === 'POST' && req.url === '/a2a') {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const rpc = JSON.parse(body) as {
          id: number | string
          method: string
          params?: { message?: { parts?: { kind: string; text?: string }[] } }
        }
        const text = (rpc.params?.message?.parts ?? [])
          .filter((p) => p.kind === 'text')
          .map((p) => p.text ?? '')
          .join('')
        if (rpc.method === 'message/send') prompts.push(text)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              kind: 'message',
              messageId: `e2e-${name}-${prompts.length}`,
              role: 'agent',
              // Per-agent: sessions are keyed by (chat, agent), and two agents
              // sharing one context id would hide a mix-up rather than show it.
              contextId: `e2e-context-${name}`,
              parts: [{ kind: 'text', text: reply(text) }]
            }
          })
        )
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  agent.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  agent.server = server
  return agent as FakeAgent
}

/** Register a fake as a hand-added A2A agent, and answer with its row id. */
async function addAgent(cinna: CinnaApp, agent: FakeAgent): Promise<string> {
  const created = await cinna.page.evaluate(
    ({ name, origin }) =>
      window.api.agents.upsert({
        name,
        protocol: 'a2a',
        cardUrl: `${origin}/.well-known/agent-card.json`,
        endpointUrl: `${origin}/a2a`
      }),
    { name: agent.name, origin: agent.origin }
  )
  if (!created.success || !created.id) throw new Error(`agents.upsert failed: ${created.error}`)
  return created.id
}

function input(page: Page) {
  return page.getByRole('combobox', { name: 'Type a message...', exact: true })
}

/** Pick an agent from the composer's `@` popup. */
async function mention(page: Page, name: string): Promise<void> {
  await input(page).fill('@')
  const popup = page.getByRole('listbox', { name: 'Agents and MCP servers' })
  await popup.getByRole('option').filter({ hasText: name }).click()
}

/**
 * The assistant bubble holding `text`, so an agent's name label can be asserted
 * where it is drawn rather than anywhere on the page — the chips below the
 * composer carry both names too. `MessageBubble`'s root is `relative group`.
 */
function bubble(page: Page, text: string) {
  return page.locator('div.relative.group').filter({ hasText: text }).last()
}

test('two agents in one chat, routed by the user, with no LLM provider configured', async ({
  cinna
}) => {
  test.setTimeout(120_000)
  const agents: FakeAgent[] = []
  try {
    const ledger = await startAgent(LEDGER, () => LEDGER_REPLY)
    const scribe = await startAgent(SCRIBE, (prompt) =>
      prompt.includes(CODE) ? SCRIBE_FOUND : SCRIBE_BLIND
    )
    agents.push(ledger, scribe)

    await cinna.skipOnboarding()
    const ledgerId = await addAgent(cinna, ledger)
    const scribeId = await addAgent(cinna, scribe)
    // Rows seeded over IPC are stale in the composer's agent query; a restart
    // is the reliable arrangement.
    await cinna.relaunch()
    await cinna.skipOnboarding()

    await test.step('the profile has no LLM provider at all', async () => {
      const page = cinna.page
      expect(await page.evaluate(() => window.api.providers.list())).toEqual([])
      expect(await page.evaluate(() => window.api.chatModes.list())).toEqual([])
    })

    await test.step('picking a second agent moves the badge from Remote to You route', async () => {
      const page = cinna.page
      await mention(page, LEDGER)
      await expect(page.getByRole('status', { name: 'Remote agent connection' })).toBeVisible()
      await mention(page, SCRIBE)
      await expect(page.getByRole('status', { name: 'You route this chat' })).toBeVisible()
      await expect(page.getByRole('status', { name: 'Remote agent connection' })).toHaveCount(0)
    })

    await test.step('the first message goes to the first agent picked, and its reply is labelled', async () => {
      const page = cinna.page
      await input(page).fill(MESSAGE_1)
      await input(page).press('Enter')
      await expect(page.getByText(LEDGER_REPLY, { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(bubble(page, LEDGER_REPLY).getByText(LEDGER, { exact: true })).toBeVisible()
      // The chat carried the pick through: still routed by the user.
      await expect(page.getByRole('status', { name: 'You route this chat' })).toBeVisible()
      expect(scribe.prompts, 'the other agent was not sent anything').toEqual([])
    })

    await test.step('a chip is an address: the next message goes to the other agent', async () => {
      const page = cinna.page
      // Sticky by default: the agent the last user message was addressed to.
      const ledgerChip = page.getByRole('button', {
        name: `Agent “${LEDGER}” answers your next message`
      })
      await expect(ledgerChip).toHaveAttribute('aria-pressed', 'true')
      const scribeChip = page.getByRole('button', {
        name: `Address your next message to “${SCRIBE}”`
      })
      await expect(scribeChip).toHaveAttribute('aria-pressed', 'false')
      await scribeChip.click()
      await expect(
        page.getByRole('button', { name: `Agent “${SCRIBE}” answers your next message` })
      ).toHaveAttribute('aria-pressed', 'true')
      await expect(
        page.getByRole('button', { name: `Address your next message to “${LEDGER}”` })
      ).toHaveAttribute('aria-pressed', 'false')

      await input(page).fill(MESSAGE_2)
      await input(page).press('Enter')
    })

    await test.step('the second agent answers from what the first one said', async () => {
      const page = cinna.page
      // The answer is computed from the prompt: this line exists only because
      // the packet arrived. Without it the agent says so, in the other string.
      await expect(page.getByText(SCRIBE_FOUND, { exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(SCRIBE_BLIND, { exact: true })).toHaveCount(0)
      await expect(bubble(page, SCRIBE_FOUND).getByText(SCRIBE, { exact: true })).toBeVisible()
    })

    await test.step('the catch-up packet is on the wire, and only where something was missed', async () => {
      expect(scribe.prompts).toHaveLength(1)
      const packet = scribe.prompts[0]
      expect(packet, 'the other agent’s turn, under its own name').toContain(
        `[${LEDGER}] ${LEDGER_REPLY}`
      )
      expect(packet, 'and the message it was answering').toContain(`[user] ${MESSAGE_1}`)
      expect(
        packet.endsWith(MESSAGE_2),
        'the user’s own text comes last, unchanged'
      ).toBe(true)
      // The first agent answered first and had missed nothing: no packet at all,
      // not an empty preamble.
      expect(ledger.prompts).toEqual([MESSAGE_1])
    })

    await test.step('who said what is recorded, and nothing went through a model', async () => {
      const page = cinna.page
      const chat = await page.evaluate(async () => {
        const [row] = await window.api.chat.list()
        const detail = await window.api.chat.get(row.id)
        return {
          router: row.router,
          providerId: detail?.providerId ?? null,
          modelId: detail?.modelId ?? null,
          modeId: detail?.modeId ?? null,
          agentId: detail?.agentId ?? null,
          messages: (detail?.messages ?? []).map((m) => ({
            role: m.role,
            content: m.content,
            addressedAgentId: m.addressedAgentId ?? null,
            sourceAgentId: m.sourceAgentId ?? null
          }))
        }
      })
      expect(chat.router).toBe('human')
      expect({ providerId: chat.providerId, modelId: chat.modelId, modeId: chat.modeId }).toEqual({
        providerId: null,
        modelId: null,
        modeId: null
      })
      // No root: in a chat the user routes, every agent is attached and none is
      // the chat's counterparty.
      expect(chat.agentId).toBeNull()
      expect(chat.messages).toEqual([
        { role: 'user', content: MESSAGE_1, addressedAgentId: ledgerId, sourceAgentId: null },
        { role: 'assistant', content: LEDGER_REPLY, addressedAgentId: null, sourceAgentId: ledgerId },
        { role: 'user', content: MESSAGE_2, addressedAgentId: scribeId, sourceAgentId: null },
        { role: 'assistant', content: SCRIBE_FOUND, addressedAgentId: null, sourceAgentId: scribeId }
      ])
      // Still true after two turns: nothing configured a provider on the way.
      expect(await page.evaluate(() => window.api.providers.list())).toEqual([])
      expect(await page.evaluate(() => window.api.chatModes.list())).toEqual([])
    })
  } finally {
    for (const agent of agents) {
      await new Promise<void>((resolve) => agent.server.close(() => resolve()))
    }
  }
})
