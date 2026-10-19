import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import type { AgentReadiness } from '../../../../shared/agentDrivers'
import type { AntigravityAuthStatus, ClaudeApproval } from '../../../../shared/engine'
import type { ReadinessOptions } from '../driver'
import type { AcpLauncher } from './acpLaunchers'
import { ACP_PROTOCOL_VERSION, type AcpRuntimeMode } from './types'
import type { CodexBinaryKnown } from './codexLauncher'
import { ANTIGRAVITY_NOT_INSTALLED, antigravityHome, antigravityServerArgs } from './antigravityEnv'
import { createLogger } from '../../../logger/logger'

const logger = createLogger('antigravity-launcher')

/**
 * The remedy is Cinna's own **Log in** (an ACP `authenticate` on the server, in
 * the user's Antigravity home), offered above the message box and on the
 * agent's Settings tab — the same two places Codex's is.
 */
export const ANTIGRAVITY_NOT_LOGGED_IN =
  "Antigravity is not signed in to Google. Choose Log in above the message box or on the agent's Settings tab."

/**
 * A turn's fresh login check gave no verdict (the keychain did not answer, the
 * home's settings would not parse). Refused like a missing login, because
 * `session/new` on a home with no token opens a browser sign-in by itself.
 */
export const ANTIGRAVITY_LOGIN_UNCHECKED =
  "Cinna could not check the Antigravity login, so the agent was not started. Choose Log in above the message box or on the agent's Settings tab, then try again."

/**
 * Said instead of sending `/logout`: the server clears the one Google token
 * every Antigravity home on this computer shares (the macOS keychain item), so
 * the command would sign the user out of every agent and of Antigravity itself.
 */
export const ANTIGRAVITY_LOGOUT_REFUSED =
  'Cinna does not send /logout to Antigravity: it would sign you out of Antigravity everywhere on this computer, not only for this agent. Sign out in Antigravity itself if that is what you want.'

/**
 * Every built-in function the 1.3.0 server declares to a model, by the name
 * the model sees. **Not** what `_meta.agy.enabledTools` / `disabledTools` take
 * (see {@link ANTIGRAVITY_FILTER_TOOLS}); kept so the contract notices a
 * built-in a later server adds.
 */
export const ANTIGRAVITY_BUILTIN_TOOLS: readonly string[] = [
  'ask_question', 'define_subagent', 'generate_image', 'invoke_subagent', 'manage_subagents', 'manage_task',
  'read_url_content', 'replace_file_content', 'run_command', 'schedule', 'search_web', 'send_message',
  'write_to_file', 'view_file'
]

/**
 * The names the server's tool filter (`_meta.agy.enabledTools` /
 * `disabledTools`) accepts: the values of its internal `BuiltinTools` enum in
 * 1.3.0, matched exactly. A declared function name such as `send_message` is
 * rejected ("Unknown tool name in disabledTools", logged) and removes nothing.
 * One filter name can stand for several declared functions: `start_subagent`
 * removes `define_subagent`, `invoke_subagent`, `manage_subagents` and
 * `send_message`; `create_file` and `edit_file` remove `write_to_file` and
 * `replace_file_content`. `list_directory`, `search_directory` and `find_file`
 * are off unless enabled, and `finish` is never declared to an interactive
 * session; they are named so a filter covers the whole enum.
 */
export const ANTIGRAVITY_FILTER_TOOLS: readonly string[] = [
  'ask_question', 'create_file', 'edit_file', 'find_file', 'finish', 'generate_image', 'list_directory',
  'read_url_content', 'run_command', 'schedule', 'search_directory', 'search_web', 'start_subagent', 'view_file'
]

/**
 * The built-ins a sealed (kit) folder runs without, by filter name: Cinna owns
 * scheduling, messaging and agents there, and a second scheduler or subagent
 * system inside the engine would run work nobody can see from the desktop.
 * `start_subagent` is the one name for subagents and `send_message`.
 */
export const ANTIGRAVITY_ISOLATED_DISABLED_TOOLS: readonly string[] = ['schedule', 'start_subagent']

/**
 * The built-ins a native folder runs without: the subagent family alone
 * (`start_subagent`, which also takes `send_message`, the subagents' message
 * channel and nothing else). Not for ownership, as in a sealed folder, but
 * because Cinna cannot show that work: over ACP 1.3.0 a child's calls arrive
 * flat on the root session with nothing but an id prefix, its text and its
 * report are never sent, a resume fails, and a `session/load` on the next
 * turn kills the children. `schedule` stays: in a native folder it is the
 * user's own Antigravity scheduler, its runs happen outside this session and
 * are no transcript Cinna owes anyone, and the sealed-folder reason for
 * removing it (Cinna owns scheduling there) does not apply.
 */
export const ANTIGRAVITY_NATIVE_DISABLED_TOOLS: readonly string[] = ['start_subagent']

/** The auth method an isolated home is told to use: the user's personal Google login. */
const ISOLATED_SETTINGS = `${JSON.stringify({ auth: { type: 'oauth-personal' } })}\n`

/**
 * An isolated folder's own Antigravity home: inside the folder, under the
 * desktop-owned `.cinna/`. Inside the session's cwd on purpose — the server
 * sorts its workspace list and names the first entry the command working
 * directory, and the cwd is a prefix of everything under it, so it sorts
 * first and `pwd` is the folder. It also keeps the user's `~/.gemini` skills
 * and MCP servers out of a sealed session. Conversations live here, so a
 * session loads only under the same home, which is stable per folder.
 */
export function antigravityIsolatedHome(folderPath: string): string {
  return join(folderPath, '.cinna', 'antigravity')
}

export interface PrepareAntigravityHomeInput {
  /** The isolated home to prepare. */
  home: string
  /** The user's own Antigravity home (`~/.gemini` or their `GEMINI_HOME`). */
  userHome: string
  platform?: NodeJS.Platform
}

/**
 * Make an isolated home usable with no login of its own.
 *
 * - `antigravity-acp/settings.json` names the personal Google login. Written
 *   only when it differs, so a warm process's config is not touched per turn.
 * - A `.gitignore` of `*`, so the home never lands in the folder's repository.
 * - On Linux the token is a file per home (macOS keeps one keychain item every
 *   home shares), so the user's `acp_token.json` is copied in, mode 0600, when
 *   this home has none or the user's is newer.
 *
 * Throws on a filesystem failure; the launcher turns that into a sentence.
 */
export function prepareAntigravityHome(input: PrepareAntigravityHomeInput): void {
  const dir = join(input.home, 'antigravity-acp')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeIfDifferent(join(input.home, '.gitignore'), '*\n')
  writeIfDifferent(join(dir, 'settings.json'), ISOLATED_SETTINGS)
  if ((input.platform ?? process.platform) !== 'linux') return
  const source = join(input.userHome, 'antigravity-acp', 'acp_token.json')
  const target = join(dir, 'acp_token.json')
  const sourceTime = mtimeOf(source)
  if (sourceTime === null) return
  const targetTime = mtimeOf(target)
  if (targetTime !== null && targetTime >= sourceTime) return
  // Copied beside it and renamed over it, so a server starting in this home
  // never reads half a token, nor one readable by others for a moment.
  const staging = `${target}.tmp-${process.pid}`
  try {
    copyFileSync(source, staging)
    chmodSync(staging, 0o600)
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { force: true })
    throw error
  }
}

/** Where an isolated home's skills live: Antigravity loads `<home>/config/skills/<name>/SKILL.md`. */
export function antigravitySkillsDir(home: string): string {
  return join(home, 'config', 'skills')
}

/** The stamp beside an installed skill: a digest of the source it was copied from. */
const SKILL_STAMP = '.cinna-source'

/**
 * Install one skill natively in an isolated home — a copy of its directory
 * under `config/skills/<name>/`, which Antigravity discovers and which is in
 * the session's workspace list, so the model can read it. Copied again only
 * when the source's contents changed (the stamp is a digest of every file);
 * swapped in by rename, so a session never reads half a skill.
 */
export function installAntigravitySkill(home: string, skill: { name: string; dir: string }): void {
  const digest = directoryDigest(skill.dir)
  const target = join(antigravitySkillsDir(home), skill.name)
  let stamp: string | null = null
  try { stamp = readFileSync(join(target, SKILL_STAMP), 'utf8') } catch { /* not installed */ }
  if (stamp === digest) return
  const staging = `${target}.tmp-${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(antigravitySkillsDir(home), { recursive: true, mode: 0o700 })
  cpSync(skill.dir, staging, { recursive: true })
  writeFileSync(join(staging, SKILL_STAMP), digest)
  rmSync(target, { recursive: true, force: true })
  renameSync(staging, target)
}

/** Take a skill an earlier launch installed out of an isolated home. */
export function removeAntigravitySkill(home: string, name: string): void {
  rmSync(join(antigravitySkillsDir(home), name), { recursive: true, force: true })
}

function directoryDigest(dir: string): string {
  const hash = createHash('sha256')
  const walk = (path: string, rel: string): void => {
    const entries: Dirent[] = readdirSync(path, { withFileTypes: true })
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name)
      const name = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, name)
      else if (entry.isFile()) {
        hash.update(name); hash.update('\0'); hash.update(readFileSync(full)); hash.update('\0')
      }
    }
  }
  walk(dir, '')
  return hash.digest('hex')
}

function writeIfDifferent(path: string, content: string): void {
  let current: string | null = null
  try { current = readFileSync(path, 'utf8') } catch { /* absent */ }
  if (current !== content) writeFileSync(path, content, { mode: 0o600 })
}

function mtimeOf(path: string): number | null {
  try {
    const info = statSync(path)
    return info.isFile() ? info.mtimeMs : null
  } catch {
    return null
  }
}

/**
 * Whether an ACP error says the Google login is gone: `-32000` with
 * `Authentication required` (no `auth.type`), or `data.reason` `logged_out`
 * (signed out, "Logged out. Sign in again…") or `onboarding_failed` (the
 * server signed the user out after an identity failure).
 */
export function isAntigravityAuthError(error: unknown): boolean {
  // Structural: the SDK's `RequestError`, or anything shaped like a JSON-RPC error.
  if (!error || typeof error !== 'object') return false
  const { code, message, data } = error as { code?: unknown; message?: unknown; data?: unknown }
  if (code !== -32000) return false
  if (typeof message === 'string' && /authentication required/i.test(message)) return true
  const reason = data && typeof data === 'object' ? (data as { reason?: unknown }).reason : undefined
  return reason === 'logged_out' || reason === 'onboarding_failed'
}

/**
 * The instructions as the first prompt carries them. Antigravity has no
 * system-prompt channel over ACP (no `_meta` key, and `GEMINI.md` / `AGENTS.md`
 * / rules are not read in ACP mode), so a new session's first message opens
 * with them, and the server keeps them in the session's history from there.
 */
export function antigravityPreamble(instructions: string): string {
  return [
    'Standing instructions for this whole session, from Cinna Desktop. Follow them in every reply; the user\'s message follows them.',
    '',
    '<instructions>',
    instructions.trim(),
    '</instructions>'
  ].join('\n')
}

export interface AntigravityLauncherDeps {
  /**
   * The server this session runs on: the explicit path from Settings, else the
   * managed pinned copy, downloading and verifying it if this machine has none.
   * A failure is returned as its user-facing sentence.
   */
  binary(): Promise<{ path: string } | { error: string }>
  /** Free, and never starts a download. `fresh` retries a failed install. */
  binaryKnown(options?: ReadinessOptions): Promise<CodexBinaryKnown>
  /** The user home's login, read where the server keeps it (never by starting it). */
  auth(options?: ReadinessOptions): Promise<AntigravityAuthStatus>
  /** A turn was refused for a login that is gone: re-read the login now. */
  authLost?(): void
  /** The user-home child environment (`buildAntigravityEnv`, with shims). */
  env(): Promise<Record<string, string>>
  /**
   * The instructions for this session, chosen by the folder's runtime mode:
   * an **isolated** folder's whole assembled document, or a **native**
   * folder's desktop context (which names the absolute folder as the working
   * directory, because the server's own command directory can be elsewhere).
   */
  systemPrompt(userId: string, agentId: string, mode: AcpRuntimeMode): string
  /**
   * `autoApprove` is set only for a folder agent (kit or bare) on `ask`: the
   * folders of its pinned catalog and marketplace skills, whose scripts run
   * without asking like its own (`antigravityAutoApproval.ts`). Every other
   * session — a chat runtime, an AI function, a conductor, a build session —
   * leaves it out and asks about everything.
   */
  settings(userId: string, agentId: string): {
    model: string | null
    /** `model` is the agent's own `runtime.model` (see `AcpSessionSetup.modelDeclared`). */
    modelDeclared?: boolean
    approval: ClaudeApproval
    autoApprove?: { scriptRoots: string[] }
  }
  /**
   * The isolated home for this session, when it is not the folder's own
   * (`<folder>/.cinna/antigravity`). A chat runtime or an AI function, which
   * has no shell, keeps its home **beside** its process folder. (The server
   * still lets `view_file` read the whole home, wherever it is.)
   */
  home?(userId: string, agentId: string, folderPath: string): string
  /**
   * The `cinna-tasks` skill to install natively in an isolated home, or null
   * when this build has none. A native folder is never written to: its
   * prompt points at the file instead.
   */
  tasksSkill?(): { name: string; dir: string } | null
  /**
   * `cinna-artifacts` for an isolated home while the active profile's
   * instance keeps artifacts: `{ name, dir }` installs it, `{ name, dir: null }`
   * removes an earlier copy, null leaves the home alone.
   */
  artifactsSkill?(): { name: string; dir: string | null } | null
  platform?: NodeJS.Platform
}

/** Google Antigravity's own ACP server (`agy_acp_server.par`), on the user's Google login. */
export function createAntigravityLauncher(deps: AntigravityLauncherDeps): AcpLauncher {
  const platform = deps.platform ?? process.platform
  const loggedOut = async (options?: ReadinessOptions): Promise<boolean> => {
    const auth = await deps.auth(options).catch(() => {
      logger.warn('Antigravity login readiness check failed')
      return null
    })
    return auth?.state === 'logged_out'
  }
  const readiness = async (options?: ReadinessOptions): Promise<AgentReadiness> => {
    const known = await deps.binaryKnown(options).catch((): CodexBinaryKnown => ({ state: 'pending' }))
    // Only a *failed* install refuses: a pending one is fetched by the turn.
    if (known.state === 'failed') {
      return { state: 'not_installed', reason: ANTIGRAVITY_NOT_INSTALLED, detail: known.error }
    }
    return (await loggedOut(options))
      ? { state: 'not_logged_in', reason: ANTIGRAVITY_NOT_LOGGED_IN, login: 'antigravity' }
      : { state: 'ok', reason: null }
  }
  return {
    id: 'antigravity',
    readiness,
    // The server reports no login over ACP; the home's own state says which.
    async telemetryAuth() {
      const auth = await deps.auth().catch(() => null)
      if (!auth) return null
      if (auth.state === 'logged_out') return { kind: 'none' }
      return auth.state === 'logged_in' ? { kind: 'subscription', label: 'Google account' } : { kind: 'unknown' }
    },
    authError(error) {
      if (!isAntigravityAuthError(error)) return null
      try { deps.authLost?.() } catch { /* the sentence still stands */ }
      return ANTIGRAVITY_NOT_LOGGED_IN
    },
    refusePrompt(text) {
      return text.trim() === '/logout' ? ANTIGRAVITY_LOGOUT_REFUSED : null
    },
    async plan(ctx) {
      if (!ctx.folder) return { error: 'This launcher requires a local agent folder.' }
      let phase = 'executable'
      try {
        const binary = await deps.binary()
        if ('error' in binary) return { error: binary.error }
        // **Before anything is spawned, and asked fresh.** `session/new` on a
        // home that names `oauth-personal` with no token opens the browser
        // sign-in by itself, so a sign-out in Antigravity itself a moment ago
        // must not pass on a cached answer, and no answer at all refuses too
        // where a store is known (readiness keeps the cached, lenient read).
        phase = 'readiness'
        const auth = await deps.auth({ fresh: true }).catch((): AntigravityAuthStatus => ({ state: 'unknown' }))
        if (auth.state === 'logged_out') return { error: ANTIGRAVITY_NOT_LOGGED_IN }
        if (auth.state === 'unknown' && (platform === 'darwin' || platform === 'linux')) return { error: ANTIGRAVITY_LOGIN_UNCHECKED }
        phase = 'settings'
        const settings = deps.settings(ctx.userId, ctx.agentId)
        const native = ctx.folder.runtimeMode === 'native'
        phase = 'environment'
        const userEnv = await deps.env()
        const env: Record<string, string> = { ...userEnv }
        if (!native) {
          phase = 'home'
          const home = deps.home?.(ctx.userId, ctx.agentId, ctx.folder.path) ?? antigravityIsolatedHome(ctx.folder.path)
          prepareAntigravityHome({ home, userHome: antigravityHome(userEnv), platform })
          phase = 'skills'
          const skill = deps.tasksSkill?.() ?? null
          if (skill) installAntigravitySkill(home, skill)
          const artifacts = deps.artifactsSkill?.() ?? null
          if (artifacts?.dir) installAntigravitySkill(home, { name: artifacts.name, dir: artifacts.dir })
          else if (artifacts) removeAntigravitySkill(home, artifacts.name)
          env.GEMINI_HOME = home
        }
        phase = 'instructions'
        const instructions = deps.systemPrompt(ctx.userId, ctx.agentId, ctx.folder.runtimeMode)
        const args = [...antigravityServerArgs(platform)]
        // The model, the mode and the instructions are per session, so they
        // stay out of the key: one warm server serves every chat of the agent.
        const key = createHash('sha256').update(JSON.stringify([
          binary.path, args, ctx.folder.path,
          Object.entries(env).sort(([a], [b]) => a.localeCompare(b))
        ])).digest('hex').slice(0, 32)
        return {
          spec: { command: binary.path, args, env, cwd: ctx.folder.path, key },
          // No elicitation: the server never sends `elicitation/create`; its
          // questions arrive as permission requests (`interaction_*`).
          init: { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'cinna-desktop', version: '1' } },
          session: {
            mcpServers: [],
            meta: { agy: { disabledTools: [...(native ? ANTIGRAVITY_NATIVE_DISABLED_TOOLS : ANTIGRAVITY_ISOLATED_DISABLED_TOOLS)] } }
          },
          ...(instructions.trim() ? { firstPromptPreamble: antigravityPreamble(instructions) } : {}),
          // After **new and load**: the mode persists across a load, the model
          // does not (it comes back as the server's default).
          setup: {
            modeId: settings.approval === 'auto' ? 'yolo' : 'default',
            ...(settings.model ? { configOptions: [{ configId: 'model', value: settings.model, optional: true }] } : {}),
            ...(settings.model && settings.modelDeclared ? { modelDeclared: true } : {})
          },
          // Read per ask by the driver's permission gate; under `yolo` nothing asks.
          ...(settings.approval === 'ask' && settings.autoApprove
            ? { autoApprove: { folder: ctx.folder.path, scriptRoots: [...settings.autoApprove.scriptRoots] } }
            : {})
        }
      } catch {
        // Errors from readers can carry instructions or paths; the phase is enough.
        logger.warn('Antigravity could not be prepared', { agentId: ctx.agentId, phase })
        return { error: 'Antigravity could not be prepared. Check the agent folder and the Antigravity installation.' }
      }
    }
  }
}
