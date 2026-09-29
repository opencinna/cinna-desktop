import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { MANIFEST_FILE } from '../../src/shared/kit/manifest'
import { costOf } from '../../src/shared/modelPricing'

/**
 * Session telemetry in the verbose message popup.
 *
 * Only the Claude and Codex launchers report telemetry (`telemetryEngineOf`),
 * so the agent is a Codex folder agent. The Electron launcher, the pinned
 * `codex-acp` adapter, the ACP driver and the UI are real; the peer behind the
 * adapter is `fakeCodexAppServer.mjs`, named through the explicit Codex path
 * setting. Its `Report token usage` turn sends the app-server's own
 * `thread/tokenUsage/updated`, which the adapter turns into a `usage_update`
 * and the prompt answer's `usage` / `_meta.quota` — so the numbers the popup
 * shows travelled the whole way. No real Codex, login or model request.
 */

const AGENT = 'Codex Meter'
/** Priced in `shared/modelPricing.ts`: Codex reports no cost, so the popup's is the table's. */
const MODEL = 'gpt-5.4'
const PLAIN = 'Hello Codex'
const METERED = 'Report token usage'

async function installFakeCodex(cinna: CinnaApp): Promise<string> {
  const bin = join(cinna.sandbox.home, 'bin')
  mkdirSync(bin)
  const executable = join(bin, 'codex')
  writeFileSync(executable, `#!${process.execPath}\n${readFileSync(resolve('src/main/agents/drivers/acp/testSupport/fakeCodexAppServer.mjs'), 'utf8')}`, { mode: 0o755 })
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  for (const profile of ['.zprofile', '.zshrc', '.bash_profile', '.profile']) {
    const file = join(cinna.sandbox.home, profile)
    writeFileSync(file, readFileSync(file, 'utf8') + `\nexport PATH=${quote(bin)}:$PATH\nexport CODEX_HOME=${quote(cinna.sandbox.home)}\n`)
  }
  return executable
}

const composer = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })

async function send(cinna: CinnaApp, text: string, reply: string): Promise<void> {
  await composer(cinna).fill(text)
  await composer(cinna).press('Enter')
  await expect(cinna.page.getByText(reply, { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(cinna.page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
}

/** Opens the `nth` message's metadata popup and answers its `key: value` rows as main-side JSON. */
async function openPopup(cinna: CinnaApp, nth: number): Promise<Record<string, string>> {
  await cinna.page.getByRole('button', { name: 'Show message metadata', exact: true }).nth(nth).click()
  const popup = cinna.page.locator('div.font-mono').filter({ has: cinna.page.getByText('contentLength:', { exact: false }) })
  await expect(popup).toHaveCount(1)
  const rows: Record<string, string> = {}
  for (const row of await popup.locator(':scope > div').all()) {
    const [key, value] = await row.locator('span').allTextContents()
    rows[key.replace(/: $/, '')] = value
  }
  return rows
}

async function closePopup(cinna: CinnaApp): Promise<void> {
  await cinna.page.mouse.click(5, 5)
  await expect(cinna.page.locator('div.font-mono').filter({ hasText: 'contentLength:' })).toHaveCount(0)
}

test('the verbose popup of a Codex turn that reported usage shows its telemetry; other messages show none', async ({ cinna }) => {
  test.setTimeout(120_000)
  const executable = await installFakeCodex(cinna)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  await cinna.page.evaluate((path) => window.api.settings.set('localAgentsCodexPath', path), executable)
  // `unknown` until the binary service has taken up the just-saved path.
  await expect.poll(() => cinna.page.evaluate(() => window.api.localTools.codexAuth())).toEqual({ state: 'logged_in', method: 'chatgpt' })

  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, AGENT)
  const saved = await cinna.page.evaluate((input) => window.api.localAgents.updateField({
    agentId: input.id, expectedStamp: input.stamp,
    update: { field: 'runtime', value: { engine: 'codex', credential: null, modelId: input.model, complexity: null } }
  }), { id: agent.id, stamp: agent.stamps[MANIFEST_FILE]!, model: MODEL })
  expect(saved.ok).toBe(true)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  // The metered turn first: it opens the session, so the adapter's running
  // total has a known start. The plain turn reports no usage at all.
  await test.step('two turns: one with a usage report, one without', async () => {
    await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
    await answerAgentsFolder(cinna)
    await cinna.page.getByRole('button', { name: AGENT, exact: true }).click()
    await send(cinna, METERED, 'Usage reported: 2100 tokens.')
    await send(cinna, PLAIN, 'Hello from Codex.')
  })

  const [chat] = await cinna.page.evaluate(() => window.api.chat.list())
  const messages = await cinna.page.evaluate(async (id) => (await window.api.chat.get(id))!.messages
    .map((m) => ({ id: m.id, role: m.role, content: m.content, telemetry: m.telemetry })), chat.id)

  await test.step('main saved telemetry on the metered reply only', () => {
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', METERED], ['assistant', 'Usage reported: 2100 tokens.'], ['user', PLAIN], ['assistant', 'Hello from Codex.']
    ])
    expect([0, 2, 3].map((i) => messages[i].telemetry)).toEqual([null, null, null])
    expect(messages[1].telemetry).toMatchObject({ model: MODEL, tokenScope: 'turn', costSource: 'estimated' })
  })

  await test.step('switch to verbose mode through the Interface menu', async () => {
    await expect(cinna.page.getByRole('button', { name: 'Show message metadata', exact: true })).toHaveCount(0)
    await cinna.page.getByRole('button', { name: 'Interface', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Switch to verbose mode', exact: true }).click()
    await expect(cinna.page.getByRole('button', { name: 'Switch to compact mode', exact: true })).toBeVisible()
    await cinna.page.keyboard.press('Escape')
    await expect(cinna.page.getByRole('button', { name: 'Show message metadata', exact: true })).toHaveCount(4)
  })

  await test.step('the metered reply lists model, tokens with their scope, cost and duration', async () => {
    const rows = await openPopup(cinna, 1)
    expect(rows.id).toBe(messages[1].id)
    expect(rows.role).toBe('assistant')
    expect(rows).toHaveProperty('telemetry')
    const telemetry = JSON.parse(rows.telemetry) as Record<string, unknown>
    // The thread's running total (2000 input of which 600 cached, 100 output),
    // not the last request's 1200 / 50: the turn's scope, every request counted.
    const tokens = { input: 1400, output: 100, cacheRead: 600, cacheWrite: 0 }
    const cost = costOf(MODEL, tokens, { contextTokens: 1200 })!
    expect(cost).toBeGreaterThan(0)
    expect(telemetry).toEqual({
      model: MODEL,
      tokens: { scope: 'turn', ...tokens },
      cost: `$${Number(cost.toPrecision(4))} (estimated)`,
      durationMs: expect.any(Number)
    })
    expect(telemetry.durationMs as number).toBeGreaterThan(0)
    // Above the parts, so a long parts list cannot push it below the fold.
    expect(Object.keys(rows).indexOf('telemetry')).toBeLessThan(Object.keys(rows).indexOf('parts'))
    await closePopup(cinna)
  })

  await test.step('the plain reply and a user message have no telemetry block', async () => {
    for (const [nth, role] of [[3, 'assistant'], [0, 'user']] as const) {
      const rows = await openPopup(cinna, nth)
      expect(rows.id).toBe(messages[nth].id)
      expect(rows.role).toBe(role)
      expect(rows).not.toHaveProperty('telemetry')
      await closePopup(cinna)
    }
  })
})
