import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { answerAgentsFolder, expect, test, type CinnaApp } from '../fixtures/app'
import { ANTHROPIC_API_KEY, anthropicKeyProblem, seedAnthropicCredential } from '../fixtures/claudeApiAuth'
import { LIVE_REQUESTED } from '../fixtures/live'
import { claudeBinary, expectNoAgentTurn } from '../fixtures/liveEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { MANIFEST_FILE } from '../../src/shared/kit/manifest'

/**
 * **Claude Agent on an API token** (Settings → Local Agents → "Claude Agent
 * signs in with": Subscription | API Token).
 *
 * In API Token mode main adds the chosen Anthropic credential to the `claude`
 * child as `ANTHROPIC_API_KEY`, plus `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` so
 * the agent's own Bash and MCP subprocesses never inherit it
 * (`claudeEnv.ts`). The sandbox `HOME` has no Claude login at all, so a turn
 * that completes here ran on the key and nothing else.
 *
 * 1. Free: with no Anthropic credential, the API Token segment is disabled
 *    and says why on hover.
 * 2. Billed, one short `haiku` turn on `.env`'s `ANTHROPIC_API_KEY`: the mode
 *    is chosen in the UI, the row and the agent's Runtime panel name the
 *    credential, the agent runs `printenv ANTHROPIC_API_KEY` in its Bash tool
 *    and the turn completes, and the key is nowhere — not in the transcript
 *    DOM, not in the stored messages, not in any file of the sandbox.
 *
 * Not proven here: that the key is what the *CLI* authenticated with in a way
 * other than "there is no other login under this HOME"; `ANTHROPIC_BASE_URL`
 * credentials; pool retirement when the mode changes.
 */

const AGENT = 'Token Ledger'
const CREDENTIAL = 'E2E Anthropic'
const NO_CREDENTIAL = 'No Anthropic AI credential found'
/** Computed by the shell, so the prompt does not contain it. */
const MARKER = `scrub-${1234 + 4321}`
const COMMAND = 'printenv ANTHROPIC_API_KEY; echo "scrub-$((1234+4321))"'

const BINARY = claudeBinary()

test.use({ liveEngineCheck: BINARY ? { engine: 'claude', binary: BINARY } : null })

test.beforeEach(() => {
  test.skip(!LIVE_REQUESTED, 'live specs run only through make e2e-live or make e2e-one SPEC=<live spec>')
  test.skip(BINARY === null, 'no Claude Code binary (set CINNA_E2E_CLAUDE_PATH, or install ~/.local/bin/claude)')
})

async function openLocalAgentsSettings(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(page.getByText('Default runtime', { exact: true })).toBeVisible()
}

/**
 * Claude Agent as the Default runtime, on its Claude Path — **over IPC, never
 * by pressing its card**. Picking an installed runtime asks its login and, on
 * a definite "logged out", starts the real `claude` login
 * (`runtimeSetupService`: "Waiting for sign-in in your browser…"), which opens
 * a browser tab on the developer's machine. The sandbox `HOME` is logged out
 * by construction, and the mode is still Subscription at that point.
 * Arranged before Settings opens, so the card is selected on first paint.
 */
async function arrangeClaudeRuntime(cinna: CinnaApp): Promise<void> {
  await cinna.page.evaluate(async (path) => {
    await window.api.settings.set('localAgentsClaudePath', path)
    await window.api.settings.set('localAgentsDefaultEngine', 'claude')
  }, BINARY!)
  // A setting written over IPC is not pushed to the renderer's cached query.
  await cinna.page.reload()
  await cinna.page.getByRole('button', { name: 'Chats', exact: true }).waitFor()
}

async function expectClaudeSelected(cinna: CinnaApp): Promise<void> {
  await expect(cinna.page.getByRole('button', { name: /^Claude Agent/ })).toHaveAttribute('aria-pressed', 'true')
}

/** Every regular file under `dir` that contains `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = []
  const walk = (current: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && statSync(path).size < 200 * 1024 * 1024) {
        if (readFileSync(path).includes(needle)) hits.push(path)
      }
    }
  }
  walk(dir)
  return hits
}

test('with no Anthropic credential, API Token is disabled and says why', async ({ cinna }) => {
  expectNoAgentTurn()
  await cinna.skipOnboarding()
  await arrangeClaudeRuntime(cinna)
  await openLocalAgentsSettings(cinna)
  await expectClaudeSelected(cinna)

  const group = cinna.page.getByRole('group', { name: 'Claude Agent signs in with', exact: true })
  await expect(group.getByRole('button', { name: 'Subscription', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const apiToken = group.getByRole('button', { name: 'API Token', exact: true })
  await expect(apiToken).toBeDisabled()
  await expect(group.getByTitle(NO_CREDENTIAL, { exact: true })).toContainText('API Token')
  await expect(cinna.page.getByText('Turns run on your own Claude login and its plan.', { exact: true })).toBeVisible()
  expect(await cinna.page.evaluate(() => window.api.settings.getAll().then((all) => all.claudeAuthMode))).toBe('subscription')
})

test('@live a Claude agent on the API token runs one turn, and the key reaches neither its tools nor the transcript', async ({ cinna }) => {
  test.skip(ANTHROPIC_API_KEY === '', 'ANTHROPIC_API_KEY is not set in .env')
  test.setTimeout(240_000)
  await cinna.skipOnboarding()

  // Arrange: the credential and a kit agent pinned to Claude on haiku.
  const credentialId = await seedAnthropicCredential(cinna.page, CREDENTIAL)
  // Free: a key Anthropic refuses would fail the turn with the same words, on every engine path.
  const keyProblem = await anthropicKeyProblem(cinna.page, credentialId)
  test.skip(keyProblem !== null, keyProblem ?? '')
  const root = await addAgentRoot(cinna)
  const created = await createFolderAgent(cinna, root, AGENT, AGENT)
  const stamp = created.stamps[MANIFEST_FILE]
  expect(stamp, `the scaffolded ${MANIFEST_FILE} has a stamp`).toBeTruthy()
  const saved = await cinna.page.evaluate((input) => window.api.localAgents.updateField({
    agentId: input.agentId,
    update: { field: 'runtime', value: { engine: 'claude', credential: null, modelId: 'haiku', complexity: null } },
    expectedStamp: input.stamp
  }), { agentId: created.id, stamp: stamp! })
  expect(saved.ok, saved.ok ? '' : saved.message).toBe(true)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  // After skipOnboarding, which pins OpenCode on every launch.
  await arrangeClaudeRuntime(cinna)
  const page = cinna.page

  await test.step('API Token is chosen in Settings, and the row names the credential', async () => {
    await openLocalAgentsSettings(cinna)
    await expectClaudeSelected(cinna)
    const group = page.getByRole('group', { name: 'Claude Agent signs in with', exact: true })
    const apiToken = group.getByRole('button', { name: 'API Token', exact: true })
    await expect(apiToken).toBeEnabled()
    await apiToken.click()
    await expect(apiToken).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText(`Turns bill to the owner of “${CREDENTIAL}”.`, { exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.api.settings.getAll().then((all) => all.claudeAuthMode))).toBe('api_key')
    // No login was started on the way: the sandbox is logged out and nothing pressed the card.
    await expect(page.getByText('Waiting for sign-in in your browser…', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Back', exact: true }).click()
  })

  await test.step('the agent’s Runtime panel says it runs on the API token', async () => {
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await answerAgentsFolder(cinna)
    await page.getByRole('button', { name: AGENT, exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const panel = page.getByRole('region', { name: 'Runs with' })
    // The model is named as the runtime's catalogue lists it (`Haiku 5.5`); the version is not this spec's business.
    await expect(panel.getByText(new RegExp(`^Claude Agent runs on the API token “${CREDENTIAL}”, on Haiku [\\d.]+\\.$`))).toBeVisible()
  })

  let chatId = ''
  await test.step('one turn runs printenv in the agent’s Bash, and completes', async () => {
    await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
    const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
    // The scaffold's own rules forbid printing a credential, so the ask is framed as the check it is.
    await input.fill(`We are checking that no API key leaks into your shell. Run this exact command with your Bash tool, once: ${COMMAND}\nThen reply with its output verbatim and nothing else.`)
    await input.press('Enter')
    // On haiku the CLI has no auto-mode reviewer and asks for Bash: allow it once.
    const allow = page.getByRole('button', { name: 'Allow once', exact: true })
    const answer = page.getByText(MARKER).first()
    await expect(allow.or(answer).first()).toBeVisible({ timeout: 120_000 })
    if (await allow.isVisible()) await allow.click()
    await expect(answer).toBeVisible({ timeout: 120_000 })
    // A fresh profile: this turn's chat is the only one.
    const chats = await page.evaluate(() => window.api.chat.list())
    expect(chats.map((chat) => chat.title).length, 'chats in the profile').toBe(1)
    chatId = chats[0].id
    await expect.poll(() => page.evaluate((id) => window.api.chat.get(id).then((chat) => chat?.activeRunId ?? null), chatId),
      { message: 'the turn ends', timeout: 120_000 }).toBeNull()
  })

  await test.step('the key is in neither the transcript, the stored messages, nor any sandbox file', async () => {
    const dom = await page.content()
    expect(dom.includes(ANTHROPIC_API_KEY), 'the key is in the transcript DOM').toBe(false)
    const messages = await page.evaluate((id) => window.api.chat.get(id).then((chat) => chat?.messages ?? []), chatId)
    const stored = JSON.stringify(messages)
    expect(stored).toContain(MARKER)
    expect(stored.includes(ANTHROPIC_API_KEY), 'the key is in the stored messages').toBe(false)
    expect(stored).toContain('printenv ANTHROPIC_API_KEY')
    // Every file of the sandbox: userData (DB, logs, session records) and the throwaway HOME (the CLI's own records).
    expect(filesContaining(cinna.sandbox.root, ANTHROPIC_API_KEY), 'sandbox files holding the key').toEqual([])
  })
})
