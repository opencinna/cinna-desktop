import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'
import { RUNTIME_PINS } from '../../src/shared/runtimePins'
import {
  findContractCodex, startFakeProvider, writeProviderConfig,
  type FakeProvider, type ProviderReply, type ProviderTurn
} from '../../src/main/agents/drivers/acp/contracts/codexHarness'
import { startEgressTrap, type EgressTrap } from '../../src/main/agents/drivers/acp/contracts/claudeHarness'

/**
 * Level 2, the no-billing variant: the whole flow through the **built app**, on
 * the **real pinned CLI** and the real adapter, against a loopback fake
 * provider. No login, no credential, no provider request. The billed twin, on
 * the user's real login, is `scripts/live/runtime-flow.mjs` (`make live-flow`);
 * the steps are the ones the contract registries' `flow` fields name
 * (`FLOW_STEPS` in `contracts/codex.contract.ts`):
 *
 *   A  plain chat on the Default runtime, then its title — Codex's own thread
 *      title, since a chat whose root runs on Codex gets no Cinna AI title
 *   B  a specialist @-added mid-chat, called through Cinna's MCP server
 *   C  continuity: a later turn remembers the first
 *   D  a specialist attached before the first turn
 *
 * **Opt-in, and it never downloads.** It runs only where the pinned binary is
 * already in the contract cache (`make contract ENGINE=codex` puts it there) and
 * skips with that sentence everywhere else.
 *
 * How the app-spawned CLI reaches the fake, using only what production offers:
 * `CODEX_HOME` exported from the sandbox's shell profile (the launcher passes
 * it through — `buildCodexEnv`) names a home whose `config.toml` routes the
 * model provider to loopback and whose `auth.json` holds a dummy API key, so
 * the login probe answers "logged in". The proxy variables reach the child from
 * the app's own environment (`envMerge.ts`), which is how the egress trap sees
 * what the CLI tried to reach.
 *
 * The fake is deliberately not omniscient: it answers the specialist's code
 * word and the continuity word **out of the request it was sent**, so a relayed
 * word proves the folder's instructions and the chat's history really reached
 * the model.
 */

const PLAIN_WORD = 'pine-4417'
const CODE_WORD = 'maple-7731'
const SPECIALIST = 'Vault Keeper'
/** What the fake answers the CLI's own title request with: the chat's title on Codex. */
const CODEX_TITLE = 'Flow thread'
const MODEL = 'gpt-5.5'
const ASK = `Use your tool for the agent "${SPECIALIST}" to ask it for the project code word, then tell me the code word it gave you.`
/**
 * Hosts the CLI tried **on its own** with its model provider on loopback, as
 * observed on 0.155.0 (2026-09-18) — why it contacts each is NOT established
 * here. This is weaker than "no attempt at all": what the spec asserts is that
 * every model request went to the loopback endpoint, and that every other
 * attempt was a CONNECT the trap refused before TLS (nothing was sent) to a host
 * on this list. Same shape as the contract entry `claude.provider.no-real-egress`;
 * Codex has no such entry yet. A host not listed fails the run on purpose —
 * extend the list only after looking at what the new host is for.
 */
const KNOWN_REFUSED_HOSTS = ['chatgpt.com:443', 'github.com:443', 'api.github.com:443']

const text = (value: string): ProviderReply => ({ kind: 'text', text: value })

/** What a model would do with each request — decided from the request alone. */
function decide(turn: ProviderTurn): ProviderReply {
  // The CLI's own requests (contract entry `codex.provider.auxiliary-request`).
  if (turn.kind === 'title') return text(JSON.stringify({ title: CODEX_TITLE }))
  if (turn.kind === 'compaction') return text('Summary: nothing to hand over.')
  // Cinna's AI-title utility session — which a Codex chat must never start (step A).
  if (turn.systemText.includes('You generate concise chat titles.')) return text('CINNA AI TITLE')
  // The specialist: only its folder's AGENTS.md says this.
  const memory = /The code word is \*\*([a-z]+-\d+)\*\*/.exec(`${turn.systemText}\n${turn.userText}`)
  if (memory) return text(`The code word is ${memory[1]}.`)
  if (turn.lastUserText.includes('Use your tool for the agent')) {
    if (turn.pendingOutputs > 0) return text(`The specialist said: ${turn.outputs.at(-1) ?? 'nothing'}`)
    const tool = turn.tools.find((name) => /vault/i.test(name))
    return tool
      ? { kind: 'tool', name: tool.split('.').pop() ?? tool, args: JSON.stringify({ message: 'What is the project code word?' }) }
      : text(`NO SPECIALIST TOOL WAS OFFERED: ${turn.tools.join(', ')}`)
  }
  if (turn.lastUserText.includes('very first word')) {
    const first = /Reply with exactly this and nothing else: ([a-z]+-\d+)/.exec(turn.userText)
    return text(first ? first[1] : 'THE FIRST TURN IS NOT IN THIS REQUEST')
  }
  const plain = /Reply with exactly this and nothing else: ([a-z]+-\d+)/.exec(turn.lastUserText)
  return text(plain ? plain[1] : 'OK')
}

const composer = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })

interface ChatMessage { role: string; content: unknown; toolCallId?: string | null; toolName?: string | null; toolError?: boolean | null; toolAgentId?: string | null }
const chatOf = async (cinna: CinnaApp, id: string): Promise<{ id: string; title: string | null; router: string | null; agentId: string | null; messages: ChatMessage[] }> =>
  (await cinna.page.evaluate((chatId) => window.api.chat.get(chatId), id)) as never

/**
 * Asks answered by {@link allowAsks}. A conductor's own Cinna tool calls are
 * allowed without one, so steps B and D expect none at all.
 */
let asksAnswered = 0

/** Answer a permission ask the way the live flow does, so a nested ask cannot park the run. */
async function allowAsks(cinna: CinnaApp): Promise<void> {
  for (const name of [/^Allow/i, /^Approve/i]) {
    const button = cinna.page.getByRole('button', { name }).first()
    if (await button.isVisible().catch(() => false)) {
      asksAnswered++
      await button.click().catch(() => undefined)
    }
  }
}

/** Send, then wait until the chat holds an assistant message containing `expected` and the turn is over. */
async function sendAndExpect(cinna: CinnaApp, message: string, chatId: () => Promise<string | null>, expected: string): Promise<void> {
  await composer(cinna).fill(message)
  await composer(cinna).press('Enter')
  await expect.poll(async () => {
    await allowAsks(cinna)
    const id = await chatId()
    if (!id) return 'no chat yet'
    const messages = (await chatOf(cinna, id)).messages
    const failed = messages.find((entry) => entry.role === 'error')
    if (failed) return `error row: ${String(failed.content).slice(0, 300)}`
    return messages.filter((entry) => entry.role === 'assistant').map((entry) => String(entry.content)).join('\n')
  }, { timeout: 120_000, intervals: [500] }).toContain(expected)
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 })
}

function makeSpecialist(cinna: CinnaApp): string {
  const dir = homeDir(cinna, 'vault-keeper')
  const memory = `# ${SPECIALIST}\n\nYou keep this project's code word. The code word is **${CODE_WORD}**.\nWhen anyone asks for the code word, answer with it directly. Do not use tools for that.\n`
  writeFileSync(join(dir, 'AGENTS.md'), memory)
  writeFileSync(join(dir, 'CLAUDE.md'), memory)
  writeFileSync(join(dir, 'README.md'), `# ${SPECIALIST}\n`)
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: dir, stdio: 'pipe' }) }
  git('init', '-q'); git('add', '-A')
  git('-c', 'user.email=flow@example.invalid', '-c', 'user.name=flow', 'commit', '-q', '-m', 'initial')
  return dir
}

async function adoptSpecialist(cinna: CinnaApp, dir: string): Promise<{ id: string; name: string }> {
  await cinna.stubDirectoryPicker(dir)
  const pick = await cinna.page.evaluate(() => window.api.localAgents.folderPick())
  if (pick.cancelled) throw new Error('the stubbed folder picker was cancelled')
  if (pick.refusal !== null) throw new Error(`folder refused: ${String(pick.refusal)}`)
  const added = await cinna.page.evaluate((input) => window.api.localAgents.folderAdd(input), { path: pick.path, relPaths: pick.found.map((entry) => entry.relPath) })
  if (!added.ok) throw new Error(`folder-add refused: ${added.message}`)
  const listed = await cinna.page.evaluate(() => window.api.localAgents.list())
  const agent = listed.agents.find((entry) => entry.path === dir || entry.path?.startsWith(dir))
  if (!agent) throw new Error('no agent row for the specialist folder')
  const out = await cinna.page.evaluate((input) => window.api.localAgents.setRuntime(input.agentId, input.runtime),
    { agentId: agent.id, runtime: { engine: 'codex' as const, credential: null, modelId: null, complexity: null } })
  if (!out.ok) throw new Error(`set-runtime refused: ${out.message}`)
  return { id: agent.id, name: agent.name }
}

/* ------------------------------------------------------------------- Codex */

// Filled in `beforeAll`: `test.use` keeps the object by reference and the fixture reads it at launch.
const proxyEnv: Record<string, string> = {}
let provider: FakeProvider
let trap: EgressTrap

test.describe('Codex', () => {
  const binary = findContractCodex(RUNTIME_PINS.codex.cli)
  test.skip(process.platform === 'win32', 'The Codex restricted-chat policy is POSIX-only.')
  // `override` is how a *candidate* is named for the contract; the app would refuse it as not the pin.
  test.skip(binary?.source !== 'cache',
    `Opt-in: needs the pinned Codex ${RUNTIME_PINS.codex.cli} in the contract cache, and this spec never downloads. Install it with: make contract ENGINE=codex`)
  test.use({ env: proxyEnv })

  test.beforeAll(async () => {
    provider = await startFakeProvider(decide)
    trap = await startEgressTrap()
    const proxy = `http://127.0.0.1:${trap.port}`
    Object.assign(proxyEnv, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' })
  })
  test.afterAll(async () => {
    await provider?.close()
    await trap?.close()
  })

  test('the whole flow A–D runs on the real pinned Codex CLI against a fake provider: all model traffic on loopback, every other attempt refused', async ({ cinna }, testInfo) => {
    test.setTimeout(8 * 60_000)
    // An isolated Codex home: the loopback provider, and a dummy API-key login
    // so the production login probe answers. `requires_openai_auth = false`
    // keeps even that dummy out of the requests.
    const codexHome = join(cinna.sandbox.home, 'codex-home')
    mkdirSync(codexHome)
    writeProviderConfig(codexHome, provider.port, MODEL)
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-cinna-e2e-dummy-not-a-real-key' }))
    for (const profile of ['.zprofile', '.zshrc', '.bash_profile', '.profile']) {
      appendFileSync(join(cinna.sandbox.home, profile), `\nexport CODEX_HOME='${codexHome}'\n`)
    }
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(async (path) => {
      await window.api.settings.set('localAgentsCodexPath', path)
      await window.api.settings.set('localAgentsDefaultEngine', 'codex')
      await window.api.settings.set('autoChatTitles', true)
    }, binary!.path)
    // Polled: until the binary service has taken up the path just saved, the probe has nothing to ask and says `unknown`.
    await expect.poll(() => cinna.page.evaluate(() => window.api.localTools.codexAuth()), { timeout: 30_000 }).toEqual({ state: 'logged_in' })
    expect(await cinna.page.evaluate(() => window.api.providers.list())).toEqual([])
    const specialist = await adoptSpecialist(cinna, makeSpecialist(cinna))

    const firstChat = async (): Promise<string | null> => (await cinna.page.evaluate(() => window.api.chat.list()))[0]?.id ?? null

    await test.step('A — plain chat on the Default runtime, then Codex’s own title for it', async () => {
      await sendAndExpect(cinna, `Reply with exactly this and nothing else: ${PLAIN_WORD}`, firstChat, PLAIN_WORD)
      const chat = await chatOf(cinna, (await firstChat())!)
      const agents = await cinna.page.evaluate(() => window.api.agents.list())
      expect(agents.find((agent) => agent.id === chat.agentId)).toMatchObject({ conductor: true })
      // Codex's generated title, not its placeholder (the prompt verbatim) and not Cinna's AI title.
      await expect.poll(async () => (await chatOf(cinna, chat.id)).title, { timeout: 60_000 }).toBe(CODEX_TITLE)
      expect(provider.turns.filter((turn) => turn.systemText.includes('You generate concise chat titles.')), 'Cinna ran its own AI title for a Codex chat').toEqual([])
      // The restricted-chat policy, as the provider saw it: nothing native was offered.
      const plainTurn = provider.turns.find((turn) => turn.kind === 'conversation' && turn.lastUserText.includes(PLAIN_WORD))
      expect(plainTurn, 'the plain turn never reached the fake provider').toBeTruthy()
      expect(plainTurn!.tools.filter((name) => /shell|exec|apply_patch|view_image|web_search/i.test(name))).toEqual([])
    })

    const chatId = (await firstChat())!
    const rootAgentId = (await chatOf(cinna, chatId)).agentId

    await test.step('B — a specialist @-added mid-chat is called through Cinna’s MCP server', async () => {
      await composer(cinna).fill('@')
      await cinna.page.getByRole('listbox', { name: 'Agents and MCP servers' }).getByRole('option').filter({ hasText: specialist.name }).click()
      await expect.poll(async () => (await chatOf(cinna, chatId)).router).toBe('coordinator')
      expect((await chatOf(cinna, chatId)).agentId).toBe(rootAgentId)
      const attached = await cinna.page.evaluate((id) => window.api.chat.listOnDemandAgents(id), chatId)
      expect(attached.map((entry) => entry.agentId)).toEqual([specialist.id])
      asksAnswered = 0
      await sendAndExpect(cinna, ASK, async () => chatId, CODE_WORD)
      expect(asksAnswered, 'a Cinna tool call of the conductor raised a permission ask').toBe(0)
      const toolRows = (await chatOf(cinna, chatId)).messages.filter((entry) => entry.toolCallId)
      expect(toolRows.length).toBeGreaterThan(0)
      expect(toolRows.filter((entry) => entry.toolError)).toEqual([])
      expect(toolRows.some((entry) => entry.toolAgentId === specialist.id)).toBe(true)
    })

    await test.step('C — a later turn remembers the first', async () => {
      const before = (await chatOf(cinna, chatId)).messages.length
      await sendAndExpect(cinna, 'What was the very first word I asked you to reply with in this chat? Answer with just that word.', async () => chatId, PLAIN_WORD)
      const messages = (await chatOf(cinna, chatId)).messages
      expect(String(messages.slice(before).reverse().find((entry) => entry.role === 'assistant')?.content)).toContain(PLAIN_WORD)
      expect(messages.filter((entry) => entry.role === 'error')).toEqual([])
    })

    await test.step('D — a specialist attached before the first turn', async () => {
      const chat = await cinna.page.evaluate(async (agentId) => {
        const created = await window.api.chat.create()
        await window.api.chat.update(created.id, { router: 'coordinator', title: 'Flow D' })
        await window.api.chat.addOnDemandAgent(created.id, agentId)
        return window.api.chat.get(created.id)
      }, specialist.id)
      const agents = await cinna.page.evaluate(() => window.api.agents.list())
      expect(agents.find((agent) => agent.id === chat!.agentId)).toMatchObject({ conductor: true })
      await cinna.page.reload()
      await cinna.page.getByRole('button', { name: 'Chats', exact: true }).waitFor()
      await cinna.page.getByText('Flow D', { exact: true }).first().click()
      asksAnswered = 0
      await sendAndExpect(cinna, ASK, async () => chat!.id, CODE_WORD)
      expect(asksAnswered, 'a Cinna tool call of the conductor raised a permission ask').toBe(0)
      const toolRows = (await chatOf(cinna, chat!.id)).messages.filter((entry) => entry.toolCallId)
      expect(toolRows.length).toBeGreaterThan(0)
      expect(toolRows.filter((entry) => entry.toolError)).toEqual([])
    })

    await test.step('all model traffic went to loopback, and every other attempt was refused by the trap', async () => {
      // Everything the model was asked went to the loopback endpoint…
      expect(provider.turns.length).toBeGreaterThan(5)
      expect([...new Set(provider.turns.map((turn) => turn.path))]).toEqual(['/v1/responses'])
      // …and everything else the CLI routed through the proxy was refused by
      // the trap before a TLS handshake: the recorded list *is* the blocked list.
      // As in the Claude contract, this covers proxy-honouring traffic — a record, not a firewall.
      const refused = [...new Set(trap.attempts)]
      testInfo.annotations.push({ type: 'egress attempts (all refused)', description: refused.join(', ') || 'none' })
      expect(refused.filter((host) => !KNOWN_REFUSED_HOSTS.includes(host)), 'the CLI tried a host this spec has never seen').toEqual([])
    })
  })
})
