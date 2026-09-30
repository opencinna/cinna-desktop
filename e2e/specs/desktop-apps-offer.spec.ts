import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { RUNTIME_PINS } from '../../src/shared/runtimePins'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * The "Detected apps" offer on the new-chat screen: Claude Desktop / ChatGPT
 * found on this Mac, one button to run chats and agents on that subscription.
 * It shows only while nothing works yet (`hasWorkingRuntime`): a signed-in
 * `claude` / `codex`, one that is installed (pinned binary ready, or found on
 * PATH) with a login probe that cannot tell, or OpenCode as the Default
 * runtime with an enabled credential hides it, whatever the Default runtime is.
 *
 * The sandbox inherits the developer's real PATH — `claude` in
 * `~/.local/bin`, and `node_modules/.bin/codex` from `npm`/`make` — which
 * would hide the offer on this machine and not on another. So every test that
 * expects it first takes each directory holding a `claude` or `codex` off the
 * sandbox PATH ({@link takeCliOffPath}).
 *
 * Detection is pointed at planted bundles through `CINNA_DESKTOP_APP_ROOTS`,
 * which replaces `/Applications` and the macOS check — so the developer's own
 * installed apps never leak in, and "no apps" is an empty root, not a guess.
 *
 * Never a real sign-in: the Codex tests run a scripted `codex` whose
 * `login status` reads a marker file that its `codex login` writes, and the
 * Claude test has no `claude` on PATH, so the pinned-CLI step fails before any
 * login is reached.
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
 * Past onboarding to the new-chat screen. `skipOnboarding()` pins the Default
 * runtime to `opencode`; with no credential that is not a working runtime, so
 * it hides nothing.
 */
async function skipAndSettle(cinna: CinnaApp): Promise<void> {
  await cinna.skipOnboarding()
  await expect(newChatHeading(cinna)).toBeVisible()
  expect(await cinna.page.evaluate(() => window.api.engine.defaultRuntime().then((d) => d.engine))).toBe('opencode')
}

/**
 * Rewrite the sandbox's rc files with a PATH that has no directory holding a
 * `claude` or `codex` (plus `prepend`, when given), and restart so the login
 * shell the app reads its environment from picks it up.
 */
async function takeCliOffPath(cinna: CinnaApp, prepend?: string): Promise<void> {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((dir) =>
    ['claude', 'codex'].every((name) => {
      try {
        accessSync(join(dir, name), constants.X_OK)
        return false
      } catch {
        return true
      }
    })
  )
  const path = [...(prepend ? [prepend] : []), ...dirs].join(delimiter)
  for (const profile of ['.zprofile', '.zshrc', '.bash_profile', '.profile']) {
    writeFileSync(join(cinna.sandbox.home, profile), `export PATH=${JSON.stringify(path)}\n`)
  }
  await cinna.relaunch()
}

/**
 * A directory holding a scripted `name` that answers `--version` with
 * `version` and fails anything else — a CLI on PATH that is not the pinned one.
 */
function cliOnlyAnsweringVersion(cinna: CinnaApp, name: 'claude' | 'codex', version: string): string {
  const dir = join(cinna.sandbox.home, `path-${name}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, name),
    `#!${process.execPath}\nif (process.argv.includes('--version')) console.log(${JSON.stringify(version)})\nelse process.exit(1)\n`,
    { mode: 0o755 }
  )
  return dir
}

/** The CLI tools main detects on the (sandbox) PATH, by id. */
async function cliOnPath(cinna: CinnaApp): Promise<Record<string, boolean>> {
  const tools = await cinna.page.evaluate(() => window.api.localTools.list())
  return Object.fromEntries(
    ['claude', 'codex'].map((id) => [id, tools.find((tool) => tool.id === id)?.available ?? false])
  )
}

/**
 * A scripted `codex`, named through the explicit Codex path (the fixture has
 * the download switched off). `login status` answers from a marker file —
 * "Logged in using ChatGPT" once it exists, "Not logged in" before — and
 * `codex login` writes it, standing in for the browser sign-in. Every call's
 * arguments are appended to `calls`, so a test can see which steps ran.
 */
function installScriptedCodex(cinna: CinnaApp, { signedIn }: { signedIn: boolean }): { path: string; calls: string } {
  const dir = join(cinna.sandbox.home, 'scripted-codex')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'codex')
  const marker = join(dir, 'signed-in')
  const calls = join(dir, 'calls.log')
  if (signedIn) writeFileSync(marker, '')
  writeFileSync(
    path,
    `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2).join(' ')
appendFileSync(${JSON.stringify(calls)}, args + '\\n')
if (args === '--version') { console.log(${JSON.stringify(RUNTIME_PINS.codex.versionOutput)}); process.exit(0) }
if (args === 'login status') {
  if (existsSync(${JSON.stringify(marker)})) { console.error('Logged in using ChatGPT'); process.exit(0) }
  console.error('Not logged in'); process.exit(1)
}
if (args === 'login') { writeFileSync(${JSON.stringify(marker)}, ''); console.error('Successfully logged in'); process.exit(0) }
process.exit(2)
`,
    { mode: 0o755 }
  )
  return { path, calls }
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
    await takeCliOffPath(cinna)
    await expect(cinna.page.getByRole('button', { name: 'Skip for now' })).toBeVisible()
    await expect(banner(cinna)).toHaveCount(0)
    await cinna.skipOnboarding()
    await expect(banner(cinna).getByText(CHATGPT_SENTENCE, { exact: true })).toBeVisible()
    await expect(banner(cinna).getByRole('button')).toHaveText(['', 'Use ChatGPT'])
    await expect(banner(cinna).getByRole('button', { name: 'Dismiss' })).toBeVisible()
  })

  test('Dismiss hides it for good, across a restart', async ({ cinna }) => {
    await takeCliOffPath(cinna)
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

  test('Use ChatGPT, signed out: the connect signs in, and Codex becomes the Default runtime and the default chat mode', async ({ cinna }) => {
    await takeCliOffPath(cinna)
    await cinna.skipOnboarding()
    const codex = installScriptedCodex(cinna, { signedIn: false })
    await cinna.page.evaluate(async (path) => {
      await window.api.settings.set('localAgentsCodexPath', path)
      // An explicit-engine default, as onboarding's API-key mode is: a chat
      // runs on its mode's engine first, so connecting has to move it.
      await window.api.chatModes.upsert({ name: 'Default', engine: 'opencode', providerId: null, isDefault: true })
    }, codex.path)
    await expect.poll(() => cinna.page.evaluate(() => window.api.localTools.codexAuth())).toEqual({ state: 'logged_out' })
    // A fresh renderer, so the banner judges the scripted binary rather than
    // a login answer it cached before the path was set.
    await cinna.page.reload()
    await expect(banner(cinna).getByText(CHATGPT_SENTENCE, { exact: true })).toBeVisible()

    await banner(cinna).getByRole('button', { name: 'Use ChatGPT' }).click()
    await expect(banner(cinna)).toHaveCount(0)
    await expect(cinna.page.getByRole('alert')).toHaveCount(0)

    // The connect's sign-in step ran — the login was not already there.
    expect(readFileSync(codex.calls, 'utf8').split('\n')).toContain('login')
    expect(await cinna.page.evaluate(() => window.api.localTools.codexAuth())).toEqual({ state: 'logged_in', method: 'chatgpt' })
    expect(await cinna.page.evaluate(() => window.api.settings.getAll().then((s) => s.localAgentsDefaultEngine))).toBe('codex')
    expect(await cinna.page.evaluate(() => window.api.engine.defaultRuntime().then((d) => d.engine))).toBe('codex')
    const modes = await cinna.page.evaluate(() => window.api.chatModes.list())
    const defaults = modes.filter((mode) => mode.isDefault)
    expect(defaults.map((mode) => ({ name: mode.name, engine: mode.engine, providerId: mode.providerId }))).toEqual([
      { name: 'Codex', engine: 'codex', providerId: null }
    ])
    expect(await cinna.page.evaluate((key) => localStorage.getItem(key), DISMISSED_KEY)).toBe('["chatgpt"]')
  })

  test('a signed-in codex already works: no offer', async ({ cinna }) => {
    await takeCliOffPath(cinna)
    await skipAndSettle(cinna)
    const codex = installScriptedCodex(cinna, { signedIn: true })
    await cinna.page.evaluate((path) => window.api.settings.set('localAgentsCodexPath', path), codex.path)
    await expect.poll(() => cinna.page.evaluate(() => window.api.localTools.codexAuth())).toEqual({
      state: 'logged_in',
      method: 'chatgpt'
    })
    await cinna.page.reload()
    await expect(newChatHeading(cinna)).toBeVisible()
    // Codex is not the Default runtime: a login is enough on its own.
    expect(await cinna.page.evaluate(() => window.api.engine.defaultRuntime().then((d) => d.engine))).toBe('opencode')
    await expect(banner(cinna)).toHaveCount(0)
    expect(await cinna.page.evaluate((key) => localStorage.getItem(key), DISMISSED_KEY)).toBeNull()

    // Control: the same screen without the Codex path (no binary, so its
    // `unknown` is not a login) offers ChatGPT.
    await cinna.page.evaluate(() => window.api.settings.set('localAgentsCodexPath', ''))
    await cinna.page.reload()
    await expect(banner(cinna).getByText(CHATGPT_SENTENCE, { exact: true })).toBeVisible()
  })

  test('a codex on PATH counts as installed: no offer', async ({ cinna }) => {
    // The login probe asks the pinned or configured binary, never the PATH
    // copy, so with no pinned copy here it stays `unknown`.
    await takeCliOffPath(cinna, cliOnlyAnsweringVersion(cinna, 'codex', RUNTIME_PINS.codex.versionOutput))
    await skipAndSettle(cinna)
    expect(await cliOnPath(cinna)).toEqual({ claude: false, codex: true })
    expect(await cinna.page.evaluate(() => window.api.localTools.codexAuth())).toEqual({ state: 'unknown' })
    await expect(banner(cinna)).toHaveCount(0)

    // Control: the same sandbox with that directory off the PATH offers ChatGPT.
    await takeCliOffPath(cinna)
    await expect(newChatHeading(cinna)).toBeVisible()
    expect(await cliOnPath(cinna)).toEqual({ claude: false, codex: false })
    await expect(banner(cinna).getByText(CHATGPT_SENTENCE, { exact: true })).toBeVisible()
  })

  test('OpenCode with an enabled API key already works: no offer', async ({ cinna }) => {
    await takeCliOffPath(cinna)
    await skipAndSettle(cinna)
    const id = await cinna.page.evaluate(async () => {
      // Never called: the banner only asks whether a usable credential exists.
      const { id } = await window.api.providers.upsert({ type: 'openai', name: 'OpenAI', apiKey: 'e2e-openai-key', enabled: true })
      return id
    })
    await cinna.page.reload()
    await expect(newChatHeading(cinna)).toBeVisible()
    await expect(banner(cinna)).toHaveCount(0)

    // Control: the same key switched off is no credential to run on.
    await cinna.page.evaluate((providerId) => window.api.providers.upsert({ id: providerId, type: 'openai', name: 'OpenAI', enabled: false }), id)
    expect(
      (await cinna.page.evaluate(() => window.api.providers.list())).map((p) => ({ enabled: p.enabled, hasApiKey: p.hasApiKey }))
    ).toEqual([{ enabled: false, hasApiKey: true }])
    await cinna.page.reload()
    await expect(banner(cinna).getByText(CHATGPT_SENTENCE, { exact: true })).toBeVisible()
  })
})

test.describe('Claude Desktop and ChatGPT installed', () => {
  test.use({ env: { CINNA_DESKTOP_APP_ROOTS: appRoot('both', ['claude', 'chatgpt']) } })

  test('both are offered in one sentence', async ({ cinna }) => {
    await takeCliOffPath(cinna)
    await skipAndSettle(cinna)
    await expect(banner(cinna).getByText(BOTH_SENTENCE, { exact: true })).toBeVisible()
    await expect(banner(cinna).getByRole('button')).toHaveText(['', 'Use Claude', 'Use ChatGPT'])
  })
})

test.describe('Claude Desktop installed', () => {
  test.use({ env: { CINNA_DESKTOP_APP_ROOTS: appRoot('claude', ['claude']) } })

  test('a claude on PATH counts as installed: no offer', async ({ cinna }) => {
    // Not the pinned version, so the pinned-binary look finds nothing to reuse
    // and the login probe has nothing to ask: `unknown`, with `claude` on PATH.
    await takeCliOffPath(cinna, cliOnlyAnsweringVersion(cinna, 'claude', '2.0.0 (Claude Code)'))
    await skipAndSettle(cinna)
    expect(await cliOnPath(cinna)).toEqual({ claude: true, codex: false })
    expect(await cinna.page.evaluate(() => window.api.engine.claudeBinary().then((b) => b.state))).not.toBe('ready')
    expect(await cinna.page.evaluate(() => window.api.localTools.claudeAuth().then((a) => a.state))).toBe('unknown')
    await expect(banner(cinna)).toHaveCount(0)

    // Control: the same sandbox with that directory off the PATH offers Claude.
    await takeCliOffPath(cinna)
    await expect(newChatHeading(cinna)).toBeVisible()
    expect(await cliOnPath(cinna)).toEqual({ claude: false, codex: false })
    await expect(banner(cinna).getByText(CLAUDE_SENTENCE, { exact: true })).toBeVisible()
  })

  test('Use Claude with no Claude Code to be had: the reason shows and the offer stays', async ({ cinna }) => {
    // No `claude` on the sandbox's PATH, so the pinned-CLI step can only
    // download — which the fixture has switched off. That failure comes before
    // the login probe, so no sign-in can start on any machine.
    await takeCliOffPath(cinna)
    await skipAndSettle(cinna)
    expect(await cliOnPath(cinna)).toEqual({ claude: false, codex: false })
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
