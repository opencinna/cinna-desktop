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

function launchEnv(sandbox: Sandbox): Record<string, string> {
  const realHome = process.env.HOME ?? ''
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
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
 * Launch the built app in `sandbox`, with `extraArgs` appended to argv.
 *
 * `extraArgs` is how a spec drives something the app only learns from its
 * command line — today that is `--cinna-connect-intent=cinna://connect?server=…`,
 * the test-only form of the `cinna://` deep link (`src/shared/connectIntent.ts`):
 * a real `open-url` cannot be raised from Playwright, and the app never
 * registers the scheme when `CINNA_USER_DATA` is set, so this is the only way
 * into that funnel. Anything else the app reads from argv goes here too.
 */
export async function launch(
  sandbox: Sandbox,
  extraArgs: readonly string[] = []
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
    env: launchEnv(sandbox),
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
}

export const test = base.extend<{ cinna: CinnaApp } & CinnaOptions>({
  engine: [false, { option: true }],
  launchArgs: [[], { option: true }],
  cinna: async ({ engine, launchArgs }, use, testInfo) => {
    const sandbox = makeSandbox()
    if (engine) installCachedEngine(sandbox.userData)
    let current = await launch(sandbox, launchArgs)

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
        current = await launch(sandbox, extraArgs)
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

/** A directory under the sandbox `$HOME`, where the app's path rules allow agent roots. */
export function homeDir(cinna: CinnaApp, ...segments: string[]): string {
  const dir = join(cinna.sandbox.home, ...segments)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}
