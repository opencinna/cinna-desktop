import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * The "Detected apps" offer on the new-chat screen: Claude Desktop / ChatGPT
 * found on this Mac, one button to run chats and agents on that subscription.
 *
 * Detection is pointed at planted bundles through `CINNA_DESKTOP_APP_ROOTS`,
 * which replaces `/Applications` and the macOS check — so the developer's own
 * installed apps never leak in, and "no apps" is an empty root, not a guess.
 *
 * Never a real sign-in: the Codex test runs a scripted `codex` that answers
 * `login status` as logged in, and the Claude test takes `claude` off the
 * sandbox PATH so the pinned-CLI step fails before any login is reached.
 */

const CLAUDE_SENTENCE =
  "Claude Desktop is installed — use your Claude subscription as Cinna's default for chats and agents."
const CHATGPT_SENTENCE = "ChatGPT is installed — use your ChatGPT subscription as Cinna's default for chats and agents."
const BOTH_SENTENCE =
  "Claude Desktop and ChatGPT are installed — use either subscription as Cinna's default for chats and agents."
const DISMISSED_KEY = 'cinna-desktop-apps-dismissed'

/** A fake bundle: the one file detection opens, carrying the vendor's bundle id. */
function plantApp(root: string, bundle: string, bundleId: string): void {
  const contents = join(root, bundle, 'Contents')
  mkdirSync(contents, { recursive: true })
  writeFileSync(
    join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>\n`
  )
}

const roots = mkdtempSync(join(tmpdir(), 'cinna-e2e-apps-'))
function appRoot(name: string, apps: Array<'claude' | 'chatgpt'>): string {
  const dir = join(roots, name)
  mkdirSync(dir, { recursive: true })
  if (apps.includes('claude')) plantApp(dir, 'Claude.app', 'com.anthropic.claudefordesktop')
  if (apps.includes('chatgpt')) plantApp(dir, 'ChatGPT.app', 'com.openai.codex')
  return dir
}
test.afterAll(() => rmSync(roots, { recursive: true, force: true }))

const banner = (cinna: CinnaApp) => cinna.page.getByRole('region', { name: 'Detected apps' })
const newChatHeading = (cinna: CinnaApp) =>
  cinna.page.getByRole('heading', { level: 1, name: 'What can I help with?' })

/**
 * Skip, then restart once so the renderer's cached Default runtime is the
 * fixture's `opencode` pin rather than whatever the first launch locked to
 * (the developer's real `claude` on PATH makes that Claude, which hides the
 * Claude Desktop offer — correctly).
 */
async function skipAndSettle(cinna: CinnaApp): Promise<void> {
  await cinna.skipOnboarding()
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await expect(newChatHeading(cinna)).toBeVisible()
  expect(await cinna.page.evaluate(() => window.api.engine.defaultRuntime().then((d) => d.engine))).toBe('opencode')
}

test.describe('no desktop apps', () => {
  test.use({ env: { CINNA_DESKTOP_APP_ROOTS: appRoot('none', []) } })

  test('nothing detected: no banner on the new-chat screen', async ({ cinna }) => {
    await skipAndSettle(cinna)
    expect(await cinna.page.evaluate(() => window.api.localTools.desktopApps())).toEqual([])
    await expect(banner(cinna)).toHaveCount(0)
  })
})

test.describe('ChatGPT installed', () => {
  test.use({ env: { CINNA_DESKTOP_APP_ROOTS: appRoot('chatgpt', ['chatgpt']) } })

  test('not offered during onboarding, offered once it is skipped', async ({ cinna }) => {
    await expect(cinna.page.getByRole('button', { name: 'Skip for now' })).toBeVisible()
    await expect(banner(cinna)).toHaveCount(0)
    await cinna.skipOnboarding()
    await expect(banner(cinna).getByText(CHATGPT_SENTENCE, { exact: true })).toBeVisible()
    await expect(banner(cinna).getByRole('button')).toHaveText(['', 'Use ChatGPT'])
    await expect(banner(cinna).getByRole('button', { name: 'Dismiss' })).toBeVisible()
  })

  test('Dismiss hides it for good, across a restart', async ({ cinna }) => {
    await cinna.skipOnboarding()
    await banner(cinna).getByRole('button', { name: 'Dismiss' }).click()
    await expect(banner(cinna)).toHaveCount(0)
    expect(await cinna.page.evaluate((key) => localStorage.getItem(key), DISMISSED_KEY)).toBe('["chatgpt"]')

    await cinna.relaunch()
    await cinna.skipOnboarding()
    await expect(newChatHeading(cinna)).toBeVisible()
    // Still detected — the dismissal, not detection, is what keeps it away.
    expect(await cinna.page.evaluate(() => window.api.localTools.desktopApps())).toEqual([
      { id: 'chatgpt', label: 'ChatGPT', engine: 'codex' }
    ])
    await expect(banner(cinna)).toHaveCount(0)

    // Control: without the stored dismissal the same screen offers it again.
    await cinna.page.evaluate((key) => localStorage.removeItem(key), DISMISSED_KEY)
    await cinna.page.reload()
    await expect(banner(cinna).getByText(CHATGPT_SENTENCE, { exact: true })).toBeVisible()
  })

  test('Use ChatGPT, already signed in: Codex becomes the Default runtime and the default chat mode', async ({ cinna }) => {
    await cinna.skipOnboarding()
    // A scripted `codex` named by the explicit Codex path — the fixture has
    // the download switched off. It answers `--version` and `login status`
    // ("Logged in using ChatGPT"), so the connect never reaches a sign-in.
    const bin = join(cinna.sandbox.home, 'bin')
    mkdirSync(bin)
    const codex = join(bin, 'codex')
    writeFileSync(
      codex,
      `#!${process.execPath}\n${readFileSync(resolve('src/main/agents/drivers/acp/testSupport/fakeCodexAppServer.mjs'), 'utf8')}`,
      { mode: 0o755 }
    )
    await cinna.page.evaluate(async (path) => {
      await window.api.settings.set('localAgentsCodexPath', path)
      // An explicit-engine default, as onboarding's API-key mode is: a chat
      // runs on its mode's engine first, so connecting has to move it.
      await window.api.chatModes.upsert({ name: 'Default', engine: 'opencode', providerId: null, isDefault: true })
    }, codex)
    await expect.poll(() => cinna.page.evaluate(() => window.api.localTools.codexAuth())).toEqual({
      state: 'logged_in',
      method: 'chatgpt'
    })

    await banner(cinna).getByRole('button', { name: 'Use ChatGPT' }).click()
    await expect(banner(cinna)).toHaveCount(0)
    await expect(cinna.page.getByRole('alert')).toHaveCount(0)

    expect(await cinna.page.evaluate(() => window.api.settings.getAll().then((s) => s.localAgentsDefaultEngine))).toBe('codex')
    expect(await cinna.page.evaluate(() => window.api.engine.defaultRuntime().then((d) => d.engine))).toBe('codex')
    const modes = await cinna.page.evaluate(() => window.api.chatModes.list())
    const defaults = modes.filter((mode) => mode.isDefault)
    expect(defaults.map((mode) => ({ name: mode.name, engine: mode.engine, providerId: mode.providerId }))).toEqual([
      { name: 'Codex', engine: 'codex', providerId: null }
    ])
    expect(await cinna.page.evaluate((key) => localStorage.getItem(key), DISMISSED_KEY)).toBe('["chatgpt"]')
  })
})

test.describe('Claude Desktop and ChatGPT installed', () => {
  test.use({ env: { CINNA_DESKTOP_APP_ROOTS: appRoot('both', ['claude', 'chatgpt']) } })

  test('both are offered in one sentence', async ({ cinna }) => {
    await skipAndSettle(cinna)
    await expect(banner(cinna).getByText(BOTH_SENTENCE, { exact: true })).toBeVisible()
    await expect(banner(cinna).getByRole('button')).toHaveText(['', 'Use Claude', 'Use ChatGPT'])
  })
})

test.describe('Claude Desktop installed', () => {
  test.use({ env: { CINNA_DESKTOP_APP_ROOTS: appRoot('claude', ['claude']) } })

  test('Use Claude with no Claude Code to be had: the reason shows and the offer stays', async ({ cinna }) => {
    // Take every `claude` off the sandbox's PATH, so the pinned-CLI step can
    // only download — which the fixture has switched off. That failure comes
    // before the login probe, so no sign-in can start on any machine.
    const path = (process.env.PATH ?? '')
      .split(delimiter)
      .filter((dir) => {
        try {
          accessSync(join(dir, 'claude'), constants.X_OK)
          return false
        } catch {
          return true
        }
      })
      .join(delimiter)
    for (const profile of ['.zprofile', '.zshrc', '.bash_profile', '.profile']) {
      writeFileSync(join(cinna.sandbox.home, profile), `export PATH=${JSON.stringify(path)}\n`)
    }
    await cinna.relaunch()
    await skipAndSettle(cinna)
    expect((await cinna.page.evaluate(() => window.api.localTools.list())).find((tool) => tool.id === 'claude')?.available ?? false).toBe(false)
    await expect(banner(cinna).getByText(CLAUDE_SENTENCE, { exact: true })).toBeVisible()

    await banner(cinna).getByRole('button', { name: 'Use Claude' }).click()
    const reason = 'Set a Claude path in Settings: downloading Claude Code is switched off in this environment.'
    await expect(banner(cinna).getByRole('alert')).toHaveText(reason)
    // The line truncates on one row; the whole reason is its tooltip.
    await expect(banner(cinna).getByRole('alert')).toHaveAttribute('title', reason)
    await expect(banner(cinna).getByText(CLAUDE_SENTENCE, { exact: true })).toBeVisible()
    await expect(banner(cinna).getByRole('button', { name: 'Use Claude' })).toBeEnabled()
    expect(await cinna.page.evaluate(() => window.api.settings.getAll().then((s) => s.localAgentsDefaultEngine))).toBe('opencode')
    expect(await cinna.page.evaluate((key) => localStorage.getItem(key), DISMISSED_KEY)).toBeNull()
  })
})
