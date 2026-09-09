import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import electronPath from 'electron'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRoot } from '../playwright.config'
import { installCachedEngine } from './engine-cache'

/**
 * One launched app per test, in a sandbox nobody else can see.
 *
 * The sandbox is a fresh `HOME`: the app derives its agents home from
 * `homedir()` and refuses agent roots outside it, and the seam in
 * `src/main/index.ts` puts `userData` under it too. Without both, a fresh
 * profile registers the developer's real `~/Documents/CinnaAgents` as its home
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

export function makeSandbox(): Sandbox {
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
  // A spec's own variables go in *before* the sandbox ones, so no spec can
  // point the app at the developer's real `HOME` or profile by accident.
  for (const [key, value] of Object.entries(extra)) env[key] = value
  env.HOME = sandbox.home
  env.CINNA_USER_DATA = sandbox.userData
  // The suite launches a real app per test, and on macOS a real app that shows
  // a window takes the foreground. Playwright drives the renderer over CDP and
  // never needs it, so the app is told to stay in the background and the
  // machine stays usable while the tests run.
  env.CINNA_BACKGROUND_WINDOW = '1'
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
  extraEnv: Readonly<Record<string, string>> = {}
): Promise<{ electronApp: ElectronApplication; page: Page }> {
  const electronApp = await electron.launch({
    executablePath: electronPath as unknown as string,
    // The repo root, not the entry file: `app.getAppPath()` follows the argument,
    // and the kit contract is resolved as `<appPath>/resources/...`.
    // `--use-mock-keychain`: with HOME pointed at the sandbox, macOS resolves
    // the login keychain under it and `safeStorage.encryptString` fails with
    // "A keychain cannot be found to store …". Chromium's mock keychain keeps
    // the real safeStorage code path and never touches the user's keychain.
    args: [repoRoot, '--use-mock-keychain', ...extraArgs],
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
}

export const test = base.extend<{ cinna: CinnaApp } & CinnaOptions>({
  engine: [false, { option: true }],
  launchArgs: [[], { option: true }],
  env: [{}, { option: true }],
  cinna: async ({ engine, launchArgs, env }, use, testInfo) => {
    const sandbox = makeSandbox()
    if (engine) installCachedEngine(sandbox.userData)
    let current = await launch(sandbox, launchArgs, env)

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
        current = await launch(sandbox, extraArgs, env)
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
      }
    }

    await use(cinna)

    await current.electronApp.close()
    if (testInfo.status === testInfo.expectedStatus) {
      rmSync(sandbox.root, { recursive: true, force: true })
    } else {
      testInfo.annotations.push({ type: 'sandbox', description: sandbox.root })
    }
  }
})

export { expect } from '@playwright/test'

/**
 * Answer the agents-folder question, the way a first run does.
 *
 * Every test gets a fresh `$HOME`, so `$HOME/Documents/CinnaAgents` has never
 * been created and the app asks about it before writing there — on a real Mac
 * that write raises the system's Documents-folder prompt, and the dialog exists
 * so the prompt is not the first the user hears of it. Opening the Agents tab
 * is what raises the question, so a spec that goes on to press `+` finds the
 * dialog over it.
 *
 * A no-op when the app already has somewhere to put an agent — an adopted root,
 * or a home this test has already made.
 */
export async function answerAgentsFolder(cinna: CinnaApp): Promise<void> {
  // Decided from the two facts that decide it in the app, never from whether
  // the dialog happens to be up yet. It is raised when the agents list
  // *resolves*, not when the tab is clicked, so a visibility check races it —
  // and losing that race is silent: the helper returns, the dialog then lands
  // over whatever the spec did next, and a later step fails for a reason that
  // looks unrelated.
  //
  // Asked only when there is nowhere to put an agent: no registered root, and
  // no home folder on disk. A spec that adopted its own workshop first is never
  // asked, and waiting for a dialog that is not coming is the same flake in
  // reverse.
  const roots = await cinna.page.evaluate(() => window.api.localAgents.rootsList())
  if (roots.length > 0) return
  if (existsSync(join(cinna.sandbox.home, 'Documents', 'CinnaAgents'))) return
  // No visibility check: the button's own auto-wait is what covers the gap
  // between the click on the tab and the query that raises the dialog.
  const dialog = cinna.page.getByRole('dialog', { name: 'Where your agents will live' })
  await dialog.getByRole('button', { name: 'Create folder' }).click()
  await dialog.waitFor({ state: 'hidden' })
}

/** A directory under the sandbox `$HOME`, where the app's path rules allow agent roots. */
export function homeDir(cinna: CinnaApp, ...segments: string[]): string {
  const dir = join(cinna.sandbox.home, ...segments)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
