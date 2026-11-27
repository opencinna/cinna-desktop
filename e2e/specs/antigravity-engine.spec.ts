import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { FAKE_MODEL_DENIAL, signInAntigravityHome, writeFakeAntigravity, writeFakeSecurity, writeScriptedAntigravity } from '../fixtures/fakeAntigravity'
import { MANIFEST_FILE } from '../../src/shared/kit/manifest'
import { repoRoot } from '../playwright.config'

/**
 * Google Antigravity as a runtime, with no network and no Google account.
 *
 * **What is deterministic here, and what is not.** Main reads the login from
 * the user's Antigravity home (`~/.gemini/antigravity-acp/settings.json`) and,
 * on macOS, the login keychain (`security find-generic-password -s gemini -a
 * antigravity-acp`, exit code only). Under the sandbox `HOME` the settings file
 * does not exist, and `security` finds no keychain there either (exit 44) — so
 * the first two tests are **logged out**, on any machine, whatever the
 * developer's own login. The launcher refuses a logged-out home before
 * spawning the server, so the fake's `session/new` → `-32000 Authentication
 * required` answer is never reached — those tests assert that no session
 * request arrives at all.
 *
 * The **signed-in** describe makes the sandbox home read as logged in without
 * any keychain: `signInAntigravityHome` writes `settings.json` (`oauth-personal`)
 * and the Linux token file, and `writeFakeSecurity` puts a `security` that
 * finds every item (exit 0) first on main's `PATH`. Its tests run whole turns:
 * on the scripted ACP agent (the permission policy), and on the fake server's
 * `silent-provider-error` mode — `session/prompt` never answered, a 503 written
 * into the server's own transcript under the folder's isolated `GEMINI_HOME`
 * (`<agent>/.cinna/antigravity`) — which the driver polls every 5 s and turns
 * into a notice. The generic "No reply from Antigravity after 90 s" notice is
 * only asserted absent at the end: no test waits 90 s, so its suppression by
 * a shown provider error is covered by the driver's unit tests, not here.
 *
 * Nothing downloads: the fixture sets `CINNA_ANTIGRAVITY_DOWNLOAD=off`, and a
 * test that needs a server names the scripted one (`fakeAntigravity.ts`) as the
 * Antigravity Path, whose `authenticate` is held the way a browser sign-in
 * holds the real one.
 */

async function openSettings(cinna: CinnaApp, section: string): Promise<void> {
  const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
  await cinna.page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await cinna.page.getByRole('button', { name: section, exact: true }).click()
}

/** Where each control is, rounded to the pixel: equal before and after means nothing moved. */
async function boxes(locators: Record<string, Locator>): Promise<Record<string, { x: number; y: number; width: number; height: number }>> {
  const out: Record<string, { x: number; y: number; width: number; height: number }> = {}
  for (const [name, locator] of Object.entries(locators)) {
    const box = await locator.boundingBox()
    if (!box) throw new Error(`${name} has no box`)
    out[name] = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
  }
  return out
}

const NOT_LOGGED_IN = 'Antigravity is not logged in.'
const DOWNLOAD_OFF = 'Set an Antigravity path in Settings: downloading Antigravity is switched off in this environment.'
const COMPOSER_NOT_LOGGED_IN =
  "Antigravity is not signed in to Google. Choose Log in above the message box or on the agent's Settings tab."
const TERMS = 'Antigravity is Google’s software, with its own terms and telemetry. Logging in runs it on your Google account.'
/** A runtime card's chip ignores presses this long after the card is selected (the double-click guard). */
const CHIP_SETTLE_MS = 450
const LOGIN_PENDING = /^(Getting Antigravity ready…|Waiting for sign-in in your browser…)$/
const PROMPT = 'Summarise the notes folder in one line'
const PROVIDER_NOTE = 'Gemini answered an error (503): The model is currently unreachable.'
/** Element screenshots of the warning notice, live and saved, for a look by hand. */
const SHOTS = join(repoRoot, 'e2e', 'test-results', 'antigravity-engine')
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `--color-severity-warning-text` as the computed `color` an element wearing it reports. */
async function warningTextColor(cinna: CinnaApp): Promise<string> {
  return cinna.page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--color-severity-warning-text)'
    document.body.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
}

test('Antigravity as the Default runtime: selecting installs nothing, Install with downloads off says so, and Log in on a configured server moves nothing', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const page = cinna.page
  // The sandbox HOME has no Antigravity login, on every machine (see the header).
  expect(await page.evaluate(() => window.api.localTools.antigravityAuth())).toEqual({ state: 'logged_out' })

  await openSettings(cinna, 'Agents Config')
  await expect(page.getByText('Default runtime', { exact: true })).toBeVisible()
  const choice = page.getByRole('button', { name: /^Antigravity / })
  await expect(choice).toHaveAccessibleName('Antigravity Not installed')
  await choice.click()
  await expect(choice).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.evaluate(() => window.api.settings.getAll().then((all) => all.localAgentsDefaultEngine))).toBe('antigravity')

  // Selecting downloads nothing: the card offers Install, and the line names Google's terms.
  const install = page.getByRole('button', { name: 'Install', exact: true })
  await expect(install).toBeVisible()
  // Never pressed: it opens Google's site in a real browser.
  await expect(page.getByRole('button', { name: 'Google’s Antigravity terms', exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.api.engine.antigravityBinary())).toEqual(expect.objectContaining({ state: 'unresolved' }))

  // Install needs the server, and with downloads off there is none: said in words, with Retry on the card.
  await page.waitForTimeout(CHIP_SETTLE_MS)
  await install.click()
  await expect(page.getByText(DOWNLOAD_OFF, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  await expect(choice).toHaveAccessibleName('Antigravity Unavailable')
  const tip = page.getByRole('button', { name: 'About Antigravity’s terms', exact: true })
  await expect(tip).toBeVisible()
  await tip.click()
  await expect(page.getByText(TERMS, { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText(TERMS, { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => window.api.engine.antigravityBinary())).toEqual({ state: 'failed', error: DOWNLOAD_OFF })

  // A configured server (the scripted one) is unverified, and logged out it offers Log in on the card.
  const fake = writeFakeAntigravity(cinna)
  await page.evaluate((path) => window.api.settings.set('localAgentsAntigravityPath', path), fake.path)
  await expect(choice).toHaveAccessibleName('Antigravity unverified')
  await page.reload()
  await openSettings(cinna, 'Agents Config')
  await expect(choice).toHaveAccessibleName('Antigravity unverified')
  await expect(choice).toHaveAttribute('aria-pressed', 'true')
  const status = page.getByText(NOT_LOGGED_IN, { exact: true })
  const logIn = page.getByRole('button', { name: 'Log in', exact: true })
  await expect(status).toBeVisible()
  await expect(logIn).toBeVisible()
  await expect(tip).toBeVisible()
  expect(await page.evaluate(() => window.api.engine.resolveAntigravity())).toMatchObject({ state: 'ready', path: fake.path, source: 'configured' })

  const watched = {
    status,
    tip,
    choice,
    next: page.getByRole('combobox', { name: 'Credential OpenCode runs on', exact: true }),
    heading: page.getByRole('heading', { name: 'Tasks', level: 2, exact: true })
  }
  const before = await boxes(watched)
  await page.waitForTimeout(CHIP_SETTLE_MS)
  await logIn.click()
  // The sign-in runs on the configured server: initialize, then authenticate, held like a browser sign-in.
  await expect.poll(() => fake.received().map((request) => request.method)).toEqual(['initialize', 'authenticate'])
  expect(fake.received('authenticate')[0].params).toEqual({ methodId: 'oauth-personal' })
  const pending = page.getByText(LOGIN_PENDING)
  await expect(pending).toHaveText('Waiting for sign-in in your browser…')
  await expect(page.getByRole('status').filter({ hasText: 'Logging in…' })).toBeVisible()
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
  await expect(cancel).toBeVisible()
  // The sentence starts on the same line in the same place (its box is the row's flexible
  // remainder, a few pixels narrower beside Cancel); everything else is exact.
  const during = await boxes({ ...watched, status: pending })
  const at = ({ x, y, height }: { x: number; y: number; height: number }) => ({ x, y, height })
  expect({ ...during, status: at(during.status) }).toEqual({ ...before, status: at(before.status) })

  await cancel.click()
  await expect(status).toBeVisible()
  await expect(logIn).toBeVisible()
  expect(await boxes(watched)).toEqual(before)
  // Logged out, nothing ever asked the server for a session.
  expect(fake.received('session/new')).toEqual([])
})

test('an Antigravity folder agent shows its runtime, Flash tiers and an in-place Log in', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const fake = writeFakeAntigravity(cinna)
  await cinna.page.evaluate((path) => window.api.settings.set('localAgentsAntigravityPath', path), fake.path)
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, 'Gemini Runner', 'Gemini Runner')
  const saved = await cinna.page.evaluate((input) => window.api.localAgents.updateField({
    agentId: input.agentId,
    update: { field: 'runtime', value: { engine: 'antigravity', credential: null, modelId: null, complexity: 'medium' } },
    expectedStamp: input.stamp
  }), { agentId: agent.id, stamp: agent.stamps[MANIFEST_FILE]! })
  expect(saved.ok).toBe(true)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: agent.name, exact: true }).click()

  // The landing view: the summary names the engine, the Flash level Medium resolves to, and the missing login.
  const summary = page.getByRole('group', { name: 'Runtime summary', exact: true })
  await expect(summary.getByText('Antigravity', { exact: true })).toBeVisible()
  await expect(summary.getByText('Gemini 3.8 Flash (medium)', { exact: true })).toBeVisible()
  await expect(summary.getByText('Sign-in required', { exact: true })).toBeVisible()

  // The composer refuses with the launcher's sentence, offering Log in beside the terms.
  const warning = page.getByText(COMPOSER_NOT_LOGGED_IN, { exact: true })
  await expect(warning).toBeVisible()
  const composer = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await composer.fill('Hello Antigravity')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  const tip = page.getByRole('button', { name: 'About Antigravity’s terms', exact: true })
  const logIn = page.getByRole('button', { name: 'Log in', exact: true })
  await expect(tip).toBeVisible()
  const watched = { warning, tip, composer, logIn }
  // Measured once the notice panel has finished rising into place (280 ms), not mid-animation.
  await page.locator('.composer-notice-panel').evaluate((panel) => Promise.all(panel.getAnimations().map((a) => a.finished)))
  const before = await boxes(watched)
  await logIn.click()
  await expect.poll(() => fake.received().map((request) => request.method)).toEqual(['initialize', 'authenticate'])
  const pending = page.getByRole('button', { name: LOGIN_PENDING })
  await expect(pending).toHaveText('Waiting for sign-in in your browser…')
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  // The button widens with its pending label, but it starts where Log in did, and nothing else moves.
  const during = await boxes({ warning, tip, composer, logIn: pending })
  expect({ ...during, logIn: { x: during.logIn.x, y: during.logIn.y, height: during.logIn.height } })
    .toEqual({ ...before, logIn: { x: before.logIn.x, y: before.logIn.y, height: before.logIn.height } })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(logIn).toBeVisible()
  await expect(warning).toBeVisible()
  expect(await boxes(watched)).toEqual(before)
  await expect(composer).toHaveValue('Hello Antigravity')

  // The agent's Settings: Runs on names Antigravity; the tier select's default is the server's Flash level.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Runs with', exact: true })
  const runsOn = panel.getByRole('combobox', { name: 'Runs on', exact: true })
  await expect(runsOn).toHaveValue('engine:antigravity')
  await expect(runsOn.locator('optgroup[label="Google Antigravity"] option')).toHaveText(['Antigravity'])
  const tier = panel.getByRole('combobox', { name: 'Work complexity', exact: true })
  await expect(tier).toHaveValue('medium')
  await expect(tier.locator('option')).toHaveText(['Default (Flash high)', 'Simple', 'Medium', 'Complex'])
  await expect(panel.getByText('Antigravity unverified', { exact: true })).toBeVisible()
  await expect(panel.getByText(NOT_LOGGED_IN, { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Log in', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'About Antigravity’s terms', exact: true })).toBeVisible()

  // Simple is Flash at its low level — written to the folder, and named back on the landing view.
  await tier.selectOption('simple')
  await expect.poll(() => JSON.parse(readFileSync(join(agent.path, MANIFEST_FILE), 'utf8')).runtime)
    .toEqual({ engine: 'antigravity', complexity: 'simple' })
  await page.getByRole('button', { name: 'Start chat', exact: true }).click()
  await expect(summary.getByText('Gemini 3.8 Flash (low)', { exact: true })).toBeVisible()

  // Logged out, the server was only ever asked to sign in — never for a session.
  expect(fake.received().map((request) => request.method)).toEqual(['initialize', 'authenticate'])
})

test.describe('signed in, on Ask for approval', () => {
  // The macOS login probe asks `security` on main's PATH; a shim first there
  // reads as signed in without touching any real keychain (Linux reads the
  // home's token file, which `signInAntigravityHome` writes).
  const ENV: Record<string, string> = {}
  let shims = ''
  test.use({ env: ENV })
  test.beforeAll(() => {
    shims = mkdtempSync(join(tmpdir(), 'cinna-e2e-security-'))
    writeFakeSecurity(shims)
    ENV.PATH = `${shims}:${process.env.PATH ?? ''}`
  })
  test.afterAll(() => { if (shims) rmSync(shims, { recursive: true, force: true }) })

  test('an edit inside the agent’s folder runs without asking; a command outside the rule still asks', async ({ cinna }) => {
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
    const root = await addAgentRoot(cinna)
    const agent = await createFolderAgent(cinna, root, 'Gemini Policy', 'Gemini Policy')
    const saved = await cinna.page.evaluate((input) => window.api.localAgents.updateField({
      agentId: input.agentId,
      update: { field: 'runtime', value: { engine: 'antigravity', credential: null, modelId: null, complexity: 'medium' } },
      expectedStamp: input.stamp
    }), { agentId: agent.id, stamp: agent.stamps[MANIFEST_FILE]! })
    expect(saved.ok).toBe(true)
    const OPTIONS = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }]
    // The real 1.3.0 shapes: an edit names its absolute location, a command its line and cwd.
    const fake = writeScriptedAntigravity(cinna, { prompt: { emit: [
      { kind: 'permission', options: OPTIONS, toolCall: { toolCallId: 'edit-1', kind: 'edit', status: 'pending', title: 'create_file',
        locations: [{ path: join(agent.path, 'notes', 'probe.txt') }] } },
      { kind: 'permission', options: OPTIONS, toolCall: { toolCallId: 'cmd-1', kind: 'execute', status: 'pending', title: 'rm notes/probe.txt',
        rawInput: { CommandLine: 'rm notes/probe.txt', Cwd: agent.path, WaitMsBeforeAsync: 500 } } },
      { kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Policy turn done.' } } }
    ] } })
    await cinna.page.evaluate((path) => window.api.settings.set('localAgentsAntigravityPath', path), fake.path)
    signInAntigravityHome(cinna.sandbox.home)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    const page = cinna.page
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await answerAgentsFolder(cinna)
    await page.getByRole('button', { name: agent.name, exact: true }).click()
    const composer = page.getByRole('combobox', { name: 'Type a message...', exact: true })
    await composer.fill('Edit a note, then remove it')
    await composer.press('Enter')

    // The command parks — so the edit before it was already answered, and by Cinna: nobody clicked.
    const deny = page.getByRole('button', { name: 'Deny', exact: true })
    await expect(deny).toHaveCount(1)
    expect(fake.answers('session/request_permission').map((entry) => entry.result))
      .toEqual([{ outcome: { outcome: 'selected', optionId: 'allow' } }])
    await deny.click()
    await expect(page.getByText('Policy turn done.', { exact: true })).toBeVisible()
    expect(fake.answers('session/request_permission').map((entry) => entry.result)).toEqual([
      { outcome: { outcome: 'selected', optionId: 'allow' } },
      { outcome: { outcome: 'selected', optionId: 'deny' } }
    ])
    // Ask for approval is the server's `default` mode; the policy is Cinna's alone.
    expect(fake.received('session/set_mode').map((entry) => entry.params?.modeId)).toEqual(['default'])
    // Nothing remembered: the policy writes no grant.
    expect(await page.evaluate((id) => window.api.localAgents.grantsList(id), agent.id)).toEqual([])
  })
  test('a silent turn whose server transcript logs a 503 shows the provider error, not the model’s denial, and Stop ends it', async ({ cinna }) => {
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
    const root = await addAgentRoot(cinna)
    const agent = await createFolderAgent(cinna, root, 'Gemini Silent', 'Gemini Silent')
    const saved = await cinna.page.evaluate((input) => window.api.localAgents.updateField({
      agentId: input.agentId,
      update: { field: 'runtime', value: { engine: 'antigravity', credential: null, modelId: null, complexity: 'medium' } },
      expectedStamp: input.stamp
    }), { agentId: agent.id, stamp: agent.stamps[MANIFEST_FILE]! })
    expect(saved.ok).toBe(true)
    const fake = writeFakeAntigravity(cinna, { mode: 'silent-provider-error' })
    await cinna.page.evaluate((path) => window.api.settings.set('localAgentsAntigravityPath', path), fake.path)
    signInAntigravityHome(cinna.sandbox.home)
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    const page = cinna.page
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await answerAgentsFolder(cinna)
    await page.getByRole('button', { name: agent.name, exact: true }).click()
    const composer = page.getByRole('combobox', { name: 'Type a message...', exact: true })
    await composer.fill(PROMPT)
    await composer.press('Enter')

    // The server never answers; the note comes from its own transcript (polled every 5 s).
    const warning = page.locator('[data-notice-tone="warning"]')
    const note = warning.getByText(PROVIDER_NOTE, { exact: true })
    await expect(note).toBeVisible({ timeout: 15_000 })
    await expect(note).not.toContainText(PROMPT)
    // Read out once through the transcript's own live region, not by the row.
    await expect(page.getByTestId('notice-warning-announcer')).toHaveText(PROVIDER_NOTE)
    // A warning notice: the warning colour, a triangle, never muted.
    await expect(warning).toHaveCount(1)
    // Live only, the row adds how to act on it; the saved text is the note alone.
    await expect(warning).toHaveText(`${PROVIDER_NOTE} Stop ends the turn.`)
    await expect(warning).toHaveCSS('color', await warningTextColor(cinna))
    await expect(warning.locator('svg.lucide-triangle-alert, svg.lucide-alert-triangle')).toHaveCount(1)
    await warning.screenshot({ path: join(SHOTS, 'notice-warning-live.png'), animations: 'disabled' })
    // Written where the app reads it: the isolated folder's own Antigravity home.
    expect(fake.transcripts()).toEqual([expect.stringMatching(new RegExp(`^${escape(join(agent.path, '.cinna', 'antigravity', 'antigravity-acp', 'brain'))}/ses-silent-`))])
    expect(fake.received('session/update')).toEqual([])
    await expect(page.getByText(FAKE_MODEL_DENIAL)).toHaveCount(0)

    const stop = page.getByRole('button', { name: 'Stop', exact: true })
    await expect(stop).toBeVisible()
    const liveBox = await warning.boundingBox()
    await stop.click()
    await expect(stop).toHaveCount(0)
    expect(fake.received('session/cancel')).toHaveLength(1)
    // Stopped cleanly: the turn leaves the prompt and the note, persisted as a notice row —
    // no error row, no assistant text, and the MODEL denial nowhere.
    const [chat] = await page.evaluate(() => window.api.chat.list())
    expect((await page.evaluate((id) => window.api.chat.get(id), chat.id))?.messages.map(({ role, content }) => ({ role, content })))
      .toEqual([{ role: 'user', content: PROMPT }, { role: 'agent_transition', content: PROVIDER_NOTE }])
    // Persisted, a warning notice keeps its tone and stays expanded even in compact mode:
    // no dot to open, nothing to click.
    expect((await page.evaluate((id) => window.api.chat.get(id), chat.id))?.messages[1].parts)
      .toEqual([{ kind: 'notice', text: PROVIDER_NOTE, tone: 'warning' }])
    await expect(page.getByRole('button', { name: 'Show agent notice', exact: true })).toHaveCount(0)
    await expect(warning).toHaveCount(1)
    await expect(warning).toHaveText(PROVIDER_NOTE)
    await expect(warning).toHaveCSS('color', await warningTextColor(cinna))
    // The saved row takes the live one's place: it does not move up or down.
    const savedBox = await warning.boundingBox()
    expect(Math.abs(savedBox!.y - liveBox!.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(savedBox!.x - liveBox!.x)).toBeLessThanOrEqual(1)
    await warning.screenshot({ path: join(SHOTS, 'notice-warning-saved.png'), animations: 'disabled' })
    await expect(page.getByText(FAKE_MODEL_DENIAL)).toHaveCount(0)
    // The generic notice is due only after 90 s of silence, which this test never waits for:
    // it is absent here because the turn ended first, not proven suppressed by the provider error.
    await expect(page.getByText(/^No reply from Antigravity/)).toHaveCount(0)
  })
})
