import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import electronPath from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRoot } from '../playwright.config'
import { installCachedEngine } from './engine-cache'
import { checkLiveEngine, NO_AGENT_TURN, type LiveEngineCheck } from './mainLog'
import { beginRealLogin, endRealLogin, makeRealLoginDirs, pinRealLoginProfile, type RealLogin } from './realLogin'
import { CLAUDE_API_AUTH, pinClaudeApiProfile, type ClaudeApiAuth } from './claudeApiAuth'

/**
 * One launched app per test, in a sandbox nobody else can see.
 *
 * The sandbox is a fresh `HOME`: the app derives its agents home from
 * `homedir()` and refuses agent roots outside it, and the seam in
 * `src/main/index.ts` puts `userData` under it too. Without both, a fresh
 * profile registers the developer's real `~/CinnaAgents` as its home
 * and the test is running against their files — the spike that preceded this
 * suite did exactly that once.
 *
 * `PATH` is written into the sandbox's shell rc files: the app probes the
 * login shell for its environment, and a home with no rc files yields a bare
 * `PATH` in which `uv` and `opencode` do not exist.
 */
export interface Sandbox {
  /** The sandbox root; removed after a passing test, kept after a failure. */
  root: string
  /** `$HOME` inside the app. */
  home: string
  /** Where `app.getPath('userData')` points. */
  userData: string
  /**
   * The `HOME` the app is launched with, when it is not {@link home}: only on
   * a real-login run (`realLogin.ts`), where it is the developer's real `HOME`
   * and `home` is a throwaway `~/.cinna-e2e-<engine>-*` folder under it.
   */
  appHome?: string
}

export interface CinnaApp {
  sandbox: Sandbox
  readonly electronApp: ElectronApplication
  /** The main window (`index.html`), never the tray panel. */
  readonly page: Page
  /**
   * Quit and start again in the same sandbox, as a user restarting the app.
   *
   * Deliberately does **not** repeat `launchArgs`: a restart is the user
   * reopening the app, and a one-shot launch argument (a `cinna://` deep link
   * the OS appended) is not part of that. Pass `extraArgs` to repeat one on
   * purpose.
   */
  relaunch(extraArgs?: readonly string[]): Promise<void>
  /** Make the next OS directory picker return `dir` and any confirm box say yes. */
  stubDirectoryPicker(dir: string): Promise<void>
  /** Get past the first-run screen the way a user who has no key yet would. */
  skipOnboarding(): Promise<void>
}

export function makeSandbox(realLogin: RealLogin | null = null): Sandbox {
  // The real `HOME` already has its own rc files; nothing is written into them.
  if (realLogin) return makeRealLoginDirs(realLogin)
  const root = mkdtempSync(join(tmpdir(), 'cinna-e2e-'))
  const home = join(root, 'home')
  const userData = join(root, 'userData')
  mkdirSync(home, { recursive: true })
  mkdirSync(userData, { recursive: true })
  const realPath = process.env.PATH ?? ''
  const exportPath = `export PATH=${JSON.stringify(realPath)}\n`
  writeFileSync(join(home, '.zprofile'), exportPath)
  writeFileSync(join(home, '.zshrc'), exportPath)
  writeFileSync(join(home, '.bash_profile'), exportPath)
  writeFileSync(join(home, '.profile'), exportPath)
  return { root, home, userData }
}

function launchEnv(sandbox: Sandbox, extra: Readonly<Record<string, string>>): Record<string, string> {
  const realHome = process.env.HOME ?? ''
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  // No dashboard tile warms up at launch: a spec's tiles run only when it
  // shows them. Set before `extra`, so a spec of the warm-up can turn it on.
  env.CINNA_DASHBOARD_WARMUP = 'off'
  // A spec's own variables go in *before* the sandbox ones, so no spec can
  // point the app at the developer's real `HOME` or profile by accident.
  for (const [key, value] of Object.entries(extra)) env[key] = value
  env.HOME = sandbox.appHome ?? sandbox.home
  env.CINNA_USER_DATA = sandbox.userData
  // The suite launches a real app per test, and on macOS a real app that shows
  // a window takes the foreground. Playwright drives the renderer over CDP and
  // never needs it, so the app is told to stay in the background and the
  // machine stays usable while the tests run.
  env.CINNA_BACKGROUND_WINDOW = '1'
  // **No test ever downloads the Codex CLI.** Cinna installs its own pinned
  // copy on first use (~90 MB), and a spec that reached that path would both
  // hit the network and then run the *real* CLI under a test's name. A spec
  // that drives Codex points the explicit `localAgentsCodexPath` setting at its
  // scripted CLI — the same seam the OpenCode fakes use — and with this set,
  // one that forgot to fails in words instead. Applied after `extra`, like
  // `HOME`, so no spec can switch it back on.
  env.CINNA_CODEX_DOWNLOAD = 'off'
  // The same for Claude Code, at ~215 MB a sandbox. One difference a spec
  // author must know: Cinna reuses a `claude` on PATH that reports *exactly*
  // the pinned version, and the sandbox carries the developer's real PATH — so
  // on a machine whose Claude Code happens to be the pin a Claude session
  // resolves to it, and on any other machine it fails here in words. A spec
  // that needs a Claude binary therefore sets `localAgentsClaudePath` itself
  // and depends on neither.
  env.CINNA_CLAUDE_DOWNLOAD = 'off'
  // And for Antigravity's ACP server (~110 MB on macOS, ~330 MB on Linux).
  // Nothing on PATH is ever reused for it, so a spec that drives Antigravity
  // sets `localAgentsAntigravityPath` itself.
  env.CINNA_ANTIGRAVITY_DOWNLOAD = 'off'
  // And for git (~62 MB), which Cinna fetches in the background whenever the
  // machine has no usable git of its own — as a CI Mac without the command
  // line developer tools does. A spec never waits on it; it must never pull it.
  env.CINNA_GIT_DOWNLOAD = 'off'
  // And for the uv pre-warm (the managed uv plus `uv python install`), which
  // starts whenever a spec creates an agent. Bare-mac keeps it on.
  env.CINNA_UV_PREWARM = 'off'
  // Reuse the developer's tool caches so `uv run` in a test does not
  // re-provision an interpreter per sandbox.
  env.UV_CACHE_DIR ??= join(realHome, '.cache', 'uv')
  env.XDG_CACHE_HOME ??= join(realHome, '.cache')
  // The cross-repo integration run installs the cinna-cli checkout being
  // developed beside this app rather than the pinned PyPI release — see
  // `localCliSource()` in `src/main/localdev/toolchain.ts`. Passed through
  // under the app's own variable name so the product reads one thing and the
  // suite configures it under a `CINNA_E2E_*` name like every other knob here.
  const cliSource = (process.env.CINNA_E2E_CLI_SOURCE ?? '').trim()
  if (cliSource) env.CINNA_CLI_SOURCE = cliSource
  return env
}

/**
 * Launch the built app in `sandbox`, with `extraArgs` appended to argv and
 * `extraEnv` merged into its environment.
 *
 * `extraArgs` is how a spec drives something the app only learns from its
 * command line — today that is `--cinna-connect-intent=cinna://connect?server=…`,
 * the test-only form of the `cinna://` deep link (`src/shared/connectIntent.ts`):
 * a real `open-url` cannot be raised from Playwright, and the app never
 * registers the scheme when `CINNA_USER_DATA` is set, so this is the only way
 * into that funnel. Anything else the app reads from argv goes here too.
 *
 * `extraEnv` is the same idea for what the app reads from its *environment* —
 * today `OLLAMA_HOST`, which decides the first host the Ollama probe tries. It
 * is per-launch rather than a `process.env` assignment in a `beforeAll` on
 * purpose: the fixture copies `process.env` wholesale, so a variable set there
 * is inherited by every app every other spec in the same worker launches, and
 * one forgotten `afterAll` would point them all at a server that has since
 * stopped listening.
 */
export async function launch(
  sandbox: Sandbox,
  extraArgs: readonly string[] = [],
  extraEnv: Readonly<Record<string, string>> = {},
  mainRequire: readonly string[] = []
): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const electronApp = await electron.launch({
    executablePath: electronPath as unknown as string,
    // The repo root, not the entry file: `app.getAppPath()` follows the argument,
    // and the kit contract is resolved as `<appPath>/resources/...`.
    // `--use-mock-keychain`: with HOME pointed at the sandbox, macOS resolves
    // the login keychain under it and `safeStorage.encryptString` fails with
    // "A keychain cannot be found to store …". Chromium's mock keychain keeps
    // the real safeStorage code path and never touches the user's keychain.
    // `-r <file>` must come before the app path: Electron reads node options only there.
    args: [...mainRequire.flatMap((file) => ['-r', file]), repoRoot, '--use-mock-keychain', ...extraArgs],
    cwd: repoRoot,
    env: launchEnv(sandbox, extraEnv),
    timeout: 60_000
  })
  const isMain = (page: Page): boolean => page.url().endsWith('index.html')
  const page =
    electronApp.windows().find(isMain) ??
    (await electronApp.waitForEvent('window', { predicate: isMain, timeout: 60_000 }))
  await page.waitForLoadState('domcontentloaded')
  return { electronApp, page }
}

export interface CinnaOptions {
  /**
   * Put the pinned engine binary into the sandbox before launch, as a real
   * install has it after its first download. Off by default: only a spec that
   * makes a folder agent *answer* needs it. `test.use({ engine: true })`.
   */
  engine: boolean
  /**
   * Extra argv for the app's *first* launch, e.g.
   * `test.use({ launchArgs: ['--cinna-connect-intent=cinna://connect?server=https://example.com'] })`.
   * `relaunch()` starts without them unless it is given its own.
   */
  launchArgs: readonly string[]
  /**
   * Extra environment for every launch of this test's app, including
   * `relaunch()` — a restart inherits the machine it is restarting on.
   *
   * `test.use({ env: { OLLAMA_HOST: 'http://127.0.0.1:1234' } })`. The
   * sandbox's own variables (`HOME`, `CINNA_USER_DATA`) are applied after
   * these and cannot be overridden from here. Nothing is written to the test
   * process's `process.env`, so it cannot reach any other spec.
   *
   * The object is read at launch, which is after `beforeAll` — so a spec whose
   * value is only known then (a port its own server just bound) can pass a
   * module-level object here and fill it in.
   */
  env: Readonly<Record<string, string>>
  /**
   * Run on the developer's own Claude Code or Codex login: the app gets the
   * real `HOME` (userData stays throwaway), `skipOnboarding()` makes the engine
   * the Default runtime with `binary` as its path, and the engine's session
   * records are cleaned afterwards — see `realLogin.ts`. Null (the default) is
   * the ordinary sandbox. Set by `liveEngineOptions()`, never by hand.
   */
  realLogin: RealLogin | null
  /**
   * After a passing test, prove from the main process's stdout/stderr that its
   * agent turns ran on this engine and binary (`mainLog.ts`). Set by
   * `liveEngineOptions()`; null (the default) checks nothing.
   */
  liveEngineCheck: LiveEngineCheck | null
  /**
   * The optional capabilities (Settings → Features → Capabilities) that
   * `skipOnboarding()` turns on. Both by default, so a spec that drives Notes
   * or Dashboards finds their tabs as before they became optional; a spec of
   * the fresh-user default sets `test.use({ capabilities: [] })`.
   */
  capabilities: readonly ('notes' | 'dashboards')[]
  /**
   * Absolute paths of CommonJS files loaded into the main process before the
   * app's own code, on every launch including `relaunch()` — for a stub that
   * must already be in place when main's startup runs (an `electronApp.evaluate`
   * comes after it). `NODE_OPTIONS` cannot carry them: Playwright deletes it.
   * See `openExternalRecorder.cjs`.
   */
  mainRequire: readonly string[]
}

export const test = base.extend<{ cinna: CinnaApp } & CinnaOptions>({
  engine: [false, { option: true }],
  launchArgs: [[], { option: true }],
  env: [{}, { option: true }],
  realLogin: [null, { option: true }],
  liveEngineCheck: [null, { option: true }],
  capabilities: [['notes', 'dashboards'], { option: true }],
  mainRequire: [[], { option: true }],
  cinna: async ({ engine, launchArgs, env, realLogin: requestedLogin, liveEngineCheck, capabilities, mainRequire }, use, testInfo) => {
    // `CINNA_E2E_CLAUDE_AUTH=api_key` (`claudeApiAuth.ts`): a Claude real-login
    // run becomes an ordinary sandbox in API Token mode on the `.env` key.
    const claudeApi: ClaudeApiAuth | null = CLAUDE_API_AUTH && requestedLogin?.engine === 'claude'
      ? { binary: requestedLogin.binary }
      : null
    const realLogin = claudeApi ? null : requestedLogin
    const sandbox = makeSandbox(realLogin)
    const realRun = realLogin ? beginRealLogin() : null
    if (engine) installCachedEngine(sandbox.userData)
    // The main process's output across every launch of this test, for `liveEngineCheck`.
    const mainLog: string[] = []
    const capture = (app: ElectronApplication): void => {
      app.process().stdout?.on('data', (chunk) => mainLog.push(String(chunk)))
      app.process().stderr?.on('data', (chunk) => mainLog.push(String(chunk)))
    }
    let current = await launch(sandbox, launchArgs, env, mainRequire)
    capture(current.electronApp)

    const cinna: CinnaApp = {
      sandbox,
      get electronApp() {
        return current.electronApp
      },
      get page() {
        return current.page
      },
      async relaunch(extraArgs: readonly string[] = []) {
        await current.electronApp.close()
        current = await launch(sandbox, extraArgs, env, mainRequire)
        capture(current.electronApp)
      },
      async stubDirectoryPicker(dir: string) {
        await current.electronApp.evaluate(({ dialog }, picked) => {
          dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
          dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
        }, dir)
      },
      async skipOnboarding() {
        // After a relaunch the choice is already persisted and the shell shows
        // straight away; wait for whichever of the two screens comes first.
        const page = current.page
        const skip = page.getByRole('button', { name: 'Skip for now' })
        const shell = page.getByRole('button', { name: 'Chats', exact: true })
        await skip.or(shell).first().waitFor()
        if (await skip.isVisible()) await skip.click()
        await shell.waitFor()
        // Main's installation-global app settings, written as the user's choice
        // (`settings:set` needs the activated profile the shell now has). Main
        // announces the change, so the open window re-reads it without a reload;
        // the spec waits for the tabs so nothing races the re-read.
        if (capabilities.length > 0) {
          await page.evaluate(async (on) => {
            for (const name of on) await window.api.settings.set(name === 'notes' ? 'notesCapability' : 'dashboardsCapability', 'on')
          }, [...capabilities])
          for (const name of capabilities) {
            await page.getByRole('button', { name: name === 'notes' ? 'Notes' : 'Dashboards', exact: true }).waitFor()
          }
        }
        /**
         * **Pin the Default runtime to the OpenCode runner for every spec.**
         *
         * The sandbox exports the developer's *real* `PATH` into its shell
         * profiles (see `makeSandbox`) so the app can find `git` and the tools
         * a spec needs. That means detection inside the sandbox also finds the
         * developer's real `claude` — and since this userData is fresh, the
         * first launch would lock the Default runtime to **Claude Agent**. Every
         * folder agent whose manifest names no engine would then dispatch to
         * the Claude launcher instead of the `fakeAcpEngine` shim: the suite
         * would drive the developer's own Claude Code, spend their tokens, and
         * fail on a machine that has no `claude` at all.
         *
         * Set here rather than before launch because `settings:set` requires an
         * activated user, which is exactly what the line above has just done.
         * The write re-indexes the agent rows, so anything the startup lock had
         * already cached is corrected. A spec that wants the Claude engine says
         * so in the agent's own manifest, which outranks this.
         */
        if (claudeApi) {
          // API Token mode: Claude Agent as the Default runtime, on the `.env` Anthropic key.
          await pinClaudeApiProfile(page, claudeApi)
          return
        }
        if (realLogin) {
          // The one exception: a real-login run makes its engine the Default runtime on purpose.
          await pinRealLoginProfile(page, sandbox.home, realLogin)
          return
        }
        await page.evaluate(() =>
          window.api.settings.set('localAgentsDefaultEngine', 'opencode')
        )
      }
    }

    /** A failed live-engine check: thrown only after the sandbox and `main.log` are kept beside the trace. */
    let engineCheckError: unknown = null
    try {
      await use(cinna)
    } finally {
      await current.electronApp.close()
      if (realLogin && realRun) {
        // Pass or fail: nothing of the run may stay under the real `HOME`.
        const { removed, realAgentsHomeUnchanged } = endRealLogin(realLogin, sandbox.home, realRun)
        testInfo.annotations.push({ type: 'real-login cleanup', description: removed.join('\n') })
        if (!realAgentsHomeUnchanged) throw new Error('the real agents home (~/CinnaAgents or ~/Documents/CinnaAgents) changed during a real-login run')
      }
      // After the cleanup, so a failed check never leaves anything under the real `HOME`.
      if (liveEngineCheck && testInfo.status === 'passed') {
        const expectsTurn = !testInfo.annotations.some((note) => note.type === NO_AGENT_TURN)
        try {
          const summary = checkLiveEngine(mainLog.join(''), liveEngineCheck, expectsTurn)
          console.log(`live engine: ${summary}`)
          testInfo.annotations.push({ type: 'live engine', description: summary })
        } catch (err) {
          engineCheckError = err
        }
      }
    }
    if (engineCheckError === null && testInfo.status === testInfo.expectedStatus) {
      // The pinned-skill caches under userData (`catalog-skills/`,
      // `marketplace-skills/`) are read-only by design (files 0444, folders
      // 0555), and `rmSync` cannot empty a folder it may not write: EACCES.
      try {
        execFileSync('chmod', ['-R', 'u+w', sandbox.root], { stdio: 'ignore' })
      } catch {
        // nothing read-only, or already gone
      }
      // Claude's CLI still writes its MCP log (`~/Library/Caches/claude-cli-nodejs/…/mcp-logs-cinna/`)
      // under the sandbox HOME for a moment after the app closed, while rmSync is emptying a large
      // userData; the folder then fills again under it (ENOTEMPTY). A second pass finds it settled.
      for (let attempt = 1; ; attempt++) {
        try {
          rmSync(sandbox.root, { recursive: true, force: true })
          break
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt >= 10) throw err
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
    } else {
      testInfo.annotations.push({ type: 'sandbox', description: sandbox.root })
      // The main process's own account of the failure, beside the trace.
      writeFileSync(testInfo.outputPath('main.log'), mainLog.join('').replace(/\x1b\[[0-9;]*m/g, ''))
    }
    if (engineCheckError !== null) throw engineCheckError
  }
})

export { expect } from '@playwright/test'

/**
 * Wait for the agents home the Agents tab creates when it opens. The default,
 * `~/CinnaAgents` under the sandbox `$HOME`, is not a guarded folder, so the
 * tab creates it with nothing to answer; a list read alone never does.
 * A no-op when this sandbox already has an adopted root or agents home.
 */
export async function answerAgentsFolder(cinna: CinnaApp): Promise<void> {
  const roots = await cinna.page.evaluate(() => window.api.localAgents.rootsList())
  if (roots.length > 0) return
  // All callers open Agents first, which is what asks main to create it.
  await expect
    .poll(async () => (await cinna.page.evaluate(() => window.api.localAgents.list())).homeMissing, {
      message: 'the Agents tab creates the agents home'
    })
    .toBe(false)
}

/** A directory under the sandbox `$HOME`, where the app's path rules allow agent roots. */
export function homeDir(cinna: CinnaApp, ...segments: string[]): string {
  const dir = join(cinna.sandbox.home, ...segments)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
