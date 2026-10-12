import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, type Dirent } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * **The real-login exception to the sandbox rule**, for a live spec run on
 * Claude Code or Codex (`CINNA_E2E_LIVE_ENGINE`, `liveEngine.ts`).
 *
 * Those CLIs find the developer's login only through the real `HOME` (Claude's
 * keychain entry, `~/.codex/auth.json`), so the app is launched with the real
 * `HOME` — the narrow exception `live-sharing-skill-engines.spec.ts` (T2.3b,
 * T2.3c) introduced, with the same safety measures:
 *
 * - `userData` is still a throwaway temp dir (`CINNA_USER_DATA`) and
 *   `--use-mock-keychain` stays, so the app's own safeStorage never touches the
 *   login keychain.
 * - **Nothing is written into the real `HOME`'s rc files.** The sandbox's
 *   `home` is a fresh `~/.cinna-e2e-<engine>-*` folder *under* the real `HOME`
 *   (the app refuses agent roots outside its `HOME`); `homeDir()` and
 *   `addAgentRoot()` put every folder a spec makes there, and the app's agents
 *   home (`localAgentsHome`) is pointed at `<that folder>/Documents/CinnaAgents`
 *   right after activation, before anything could create the real one.
 * - Afterwards, pass or fail, that folder is deleted, and so are only the
 *   engine's own records of sessions whose working folder was inside it: the
 *   `~/.claude/projects/<cwd>` folders, and the `~/.codex/sessions` rollouts
 *   (plus any new `~/.codex` file named after one of their thread ids, and the
 *   empty date folders they made). `~/Documents/CinnaAgents` (and its `Local/`,
 *   `Cloud/`) must have the same mtimes after as before, or the test fails.
 *
 * What is **not** restored: Claude's `~/.claude.json` bookkeeping for the temp
 * cwd, Codex's shared SQLite rows and caches (`models_cache.json` etc.).
 *
 * Antigravity (its login is the keychain item `gemini` / `antigravity-acp`
 * plus `~/.gemini/antigravity-acp/settings.json`) needs no record removed: a
 * kit folder runs isolated, so its server home is `<agent>/.cinna/antigravity`
 * and goes with the throwaway folder. Never log it out — `/logout` clears the
 * one token every Antigravity home shares.
 */
export interface RealLogin {
  engine: 'claude' | 'codex' | 'antigravity'
  /** The engine binary, set as {@link RealLogin.pathSetting} once the profile is active. */
  binary: string
  pathSetting: 'localAgentsClaudePath' | 'localAgentsCodexPath' | 'localAgentsAntigravityPath'
}

/** The real-login part of a sandbox: what to compare and clean after the test. */
export interface RealLoginRun {
  /** `~/Documents/CinnaAgents` before the launch. */
  before: Record<string, number | null>
  /** `~/.codex` files before the launch (Codex only). */
  codexBefore: Map<string, number>
  startedAt: number
}

/** `<root>`: a temp dir for userData; `home`: a fresh folder under the real `HOME`. */
export function makeRealLoginDirs(login: RealLogin): { root: string; home: string; userData: string; appHome: string } {
  const root = mkdtempSync(join(tmpdir(), `cinna-e2e-${login.engine}-`))
  const userData = join(root, 'userData')
  mkdirSync(userData, { recursive: true })
  const appHome = homedir()
  const home = mkdtempSync(join(appHome, `.cinna-e2e-${login.engine}-`))
  return { root, home, userData, appHome }
}

export function beginRealLogin(): RealLoginRun {
  return { before: realAgentsHomeFingerprint(), codexBefore: filesUnder(codexHome()), startedAt: Date.now() }
}

/**
 * After activation: the default engine, the agents home inside the throwaway
 * folder (checked through `homeState` — it must be that path and not guarded),
 * and the engine's binary path. Idempotent; called by `skipOnboarding()` after
 * every launch.
 */
export async function pinRealLoginProfile(page: Page, home: string, login: RealLogin): Promise<void> {
  const agentsHome = join(home, 'Documents', 'CinnaAgents')
  await page.evaluate((engine) => window.api.settings.set('localAgentsDefaultEngine', engine), login.engine)
  const settings = await page.evaluate(() => window.api.settings.getAll())
  if (settings.localAgentsHome !== agentsHome) {
    await page.evaluate((path) => window.api.settings.set('localAgentsHome', path), agentsHome)
  }
  const state = await page.evaluate(() => window.api.localAgents.homeState())
  if (state.path !== agentsHome || state.guarded) {
    throw new Error(`the agents home is ${state.path}${state.guarded ? ' (guarded)' : ''}, not the throwaway ${agentsHome}; refusing to go on with the real HOME`)
  }
  if (settings[login.pathSetting] !== login.binary) {
    await page.evaluate((input) => window.api.settings.set(input.key, input.path), { key: login.pathSetting, path: login.binary })
  }
}

/**
 * Delete the throwaway folder and the engine's records of sessions inside it;
 * answers what was removed and whether `~/Documents/CinnaAgents` is untouched.
 */
export function endRealLogin(login: RealLogin, home: string, run: RealLoginRun): { removed: string[]; realAgentsHomeUnchanged: boolean } {
  const removed: string[] = []
  if (login.engine === 'claude') {
    // Claude Code names a cwd's folder by replacing every non-alphanumeric character with `-`.
    const prefix = home.replace(/[^a-zA-Z0-9]/g, '-')
    const projects = join(homedir(), '.claude', 'projects')
    for (const name of existsSync(projects) ? readdirSync(projects) : []) {
      if (name === prefix || name.startsWith(`${prefix}-`)) {
        rmSync(join(projects, name), { recursive: true, force: true })
        removed.push(join(projects, name))
      }
    }
  } else if (login.engine === 'codex') {
    const codex = codexHome()
    const ours = codexRollouts(codex, run.codexBefore, home)
    const ids = ours.map((rollout) => rollout.id).filter((id) => id.length >= 8)
    for (const path of filesUnder(codex).keys()) {
      if (run.codexBefore.has(path)) continue
      if (ours.some((rollout) => rollout.file === path) || ids.some((id) => path.includes(id))) {
        rmSync(path, { force: true })
        removed.push(path)
      }
    }
    for (const rollout of ours) {
      for (let dir = dirname(rollout.file); dir.startsWith(`${join(codex, 'sessions')}${sep}`); dir = dirname(dir)) {
        // Two rollouts can share a dated folder; the first one's walk may already have removed it.
        if (!existsSync(dir)) continue
        if (readdirSync(dir).length > 0 || statSync(dir).birthtimeMs < run.startedAt) break
        rmdirSync(dir)
      }
    }
  }
  try {
    execFileSync('chmod', ['-R', 'u+w', home], { stdio: 'ignore' })
  } catch {
    // already gone
  }
  rmSync(home, { recursive: true, force: true })
  removed.push(home)
  const after = realAgentsHomeFingerprint()
  return { removed, realAgentsHomeUnchanged: JSON.stringify(after) === JSON.stringify(run.before) }
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex')
}

/** Whether `~/Documents/CinnaAgents` exists, and the mtimes of it and its `Local/` and `Cloud/`. */
function realAgentsHomeFingerprint(): Record<string, number | null> {
  const base = join(homedir(), 'Documents', 'CinnaAgents')
  const mtime = (path: string): number | null => (existsSync(path) ? statSync(path).mtimeMs : null)
  return { home: mtime(base), local: mtime(join(base, 'Local')), cloud: mtime(join(base, 'Cloud')) }
}

/** Every regular file under `dir` (symlinks not followed), with its mtime. */
function filesUnder(dir: string): Map<string, number> {
  const out = new Map<string, number>()
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
      else if (entry.isFile()) {
        try {
          out.set(path, statSync(path).mtimeMs)
        } catch {
          // removed meanwhile
        }
      }
    }
  }
  walk(dir)
  return out
}

/** New rollouts under `<codexHome>/sessions` whose `session_meta.cwd` is inside `home`. */
function codexRollouts(codex: string, before: Map<string, number>, home: string): { file: string; id: string }[] {
  const out: { file: string; id: string }[] = []
  for (const file of filesUnder(join(codex, 'sessions')).keys()) {
    if (before.has(file) || !file.endsWith('.jsonl')) continue
    let id = ''
    let cwd = ''
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"session_meta"')) continue
      try {
        const record = JSON.parse(line)
        if (record?.type === 'session_meta') {
          id = String(record.payload?.id ?? '')
          cwd = String(record.payload?.cwd ?? '')
          break
        }
      } catch {
        // a partial line
      }
    }
    if (cwd === home || cwd.startsWith(`${home}/`)) out.push({ file, id })
  }
  return out
}
