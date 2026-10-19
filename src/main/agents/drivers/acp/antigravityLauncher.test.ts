import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequestError } from '@agentclientprotocol/sdk'
import {
  ANTIGRAVITY_BUILTIN_TOOLS,
  ANTIGRAVITY_FILTER_TOOLS,
  ANTIGRAVITY_ISOLATED_DISABLED_TOOLS,
  ANTIGRAVITY_NATIVE_DISABLED_TOOLS,
  ANTIGRAVITY_LOGIN_UNCHECKED,
  ANTIGRAVITY_LOGOUT_REFUSED,
  ANTIGRAVITY_NOT_LOGGED_IN,
  antigravityIsolatedHome,
  antigravitySkillsDir,
  installAntigravitySkill,
  createAntigravityLauncher,
  isAntigravityAuthError,
  prepareAntigravityHome,
  type AntigravityLauncherDeps
} from './antigravityLauncher'
import { ANTIGRAVITY_NOT_INSTALLED } from './antigravityEnv'
import { isRefusal, type AcpLaunchContext } from './acpLaunchers'
import { applyConductorToolPolicy } from './conductorToolPolicy'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-launcher-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function contexts(path: string): { native: AcpLaunchContext; isolated: AcpLaunchContext } {
  const folder = { name: 'Agent', slug: 'agent', description: '', path, kind: 'bare' as const, runtimeMode: 'native' as const }
  return {
    native: { userId: 'u', agentId: 'folder:a', folder },
    isolated: { userId: 'u', agentId: 'folder:a', folder: { ...folder, kind: 'kit', runtimeMode: 'isolated' } }
  }
}

function deps(over: Partial<AntigravityLauncherDeps> = {}): AntigravityLauncherDeps {
  return {
    binary: async () => ({ path: '/runtimes/antigravity-1.3.0/agy_acp_server.par' }),
    binaryKnown: async () => ({ state: 'ready' }),
    auth: async () => ({ state: 'logged_in' }),
    env: async () => ({ HOME: '/home/test', PATH: '/usr/bin' }),
    systemPrompt: () => 'You are the folder agent.',
    settings: () => ({ model: null, approval: 'ask' }),
    platform: 'darwin',
    ...over
  }
}

describe('Antigravity launcher plan', () => {
  it('refuses a signed-out home before anything is spawned or written', async () => {
    // Mutation: drop the login check and `session/new` opens a browser sign-in
    // by itself on a home that names oauth-personal with no token.
    const folder = tempDir()
    const plan = await createAntigravityLauncher(deps({ auth: async () => ({ state: 'logged_out' }) })).plan(contexts(folder).isolated)
    expect(plan).toEqual({ error: ANTIGRAVITY_NOT_LOGGED_IN })
    expect(existsSync(join(folder, '.cinna'))).toBe(false)
  })

  it('asks the login fresh, so a sign-out a moment ago is not passed on a cached answer', async () => {
    // Mutation: ask without `fresh` and the 30 s cache lets a turn start
    // `session/new`, which opens a browser on a home with no token.
    const auth = vi.fn(async () => ({ state: 'logged_in' as const }))
    const plan = await createAntigravityLauncher(deps({ auth })).plan(contexts(tempDir()).native)
    expect(isRefusal(plan)).toBe(false)
    expect(auth).toHaveBeenCalledWith({ fresh: true })
  })

  it('refuses a login it could not check on macOS and Linux, before anything is written', async () => {
    // Mutation: let `unknown` through and a keychain that did not answer
    // starts a server that may open a browser sign-in.
    for (const platform of ['darwin', 'linux'] as const) {
      const folder = tempDir()
      const plan = await createAntigravityLauncher(deps({ platform, auth: async () => ({ state: 'unknown' }) })).plan(contexts(folder).isolated)
      expect(plan).toEqual({ error: ANTIGRAVITY_LOGIN_UNCHECKED })
      expect(existsSync(join(folder, '.cinna'))).toBe(false)
    }
    const thrown = await createAntigravityLauncher(deps({ auth: async () => { throw new Error('env') } })).plan(contexts(tempDir()).native)
    expect(thrown).toEqual({ error: ANTIGRAVITY_LOGIN_UNCHECKED })
    expect(ANTIGRAVITY_LOGIN_UNCHECKED).toMatch(/Log in/)
  })

  it('passes a failed install on as its own sentence', async () => {
    const plan = await createAntigravityLauncher(deps({ binary: async () => ({ error: ANTIGRAVITY_NOT_INSTALLED }) })).plan(contexts(tempDir()).native)
    expect(plan).toEqual({ error: ANTIGRAVITY_NOT_INSTALLED })
  })

  it('runs a native folder on the user home with the server, no args on macOS and --uid= on Linux', async () => {
    const folder = tempDir()
    const mac = await createAntigravityLauncher(deps()).plan(contexts(folder).native)
    if (isRefusal(mac)) throw new Error(mac.error)
    expect(mac.spec).toMatchObject({ command: '/runtimes/antigravity-1.3.0/agy_acp_server.par', args: [], cwd: folder })
    expect(mac.spec.env.GEMINI_HOME).toBeUndefined()
    // A native folder keeps every built-in its user has but the subagent
    // family, whose work Cinna cannot show. Mutation: drop the native filter
    // and the model is offered `invoke_subagent` again; name `schedule` too
    // and the user's own scheduler goes with it.
    expect(mac.session).toEqual({ mcpServers: [], meta: { agy: { disabledTools: ['start_subagent'] } } })
    expect(ANTIGRAVITY_NATIVE_DISABLED_TOOLS.every((name) => ANTIGRAVITY_FILTER_TOOLS.includes(name))).toBe(true)
    expect(mac.init.clientCapabilities).toEqual({})
    const linux = await createAntigravityLauncher(deps({ platform: 'linux' })).plan(contexts(folder).native)
    if (isRefusal(linux)) throw new Error(linux.error)
    expect(linux.spec.args).toEqual(['--uid='])
  })

  it('gives an isolated folder its own home inside the folder, and disables the built-ins Cinna owns', async () => {
    const folder = tempDir()
    const plan = await createAntigravityLauncher(deps()).plan(contexts(folder).isolated)
    if (isRefusal(plan)) throw new Error(plan.error)
    const home = join(folder, '.cinna', 'antigravity')
    expect(plan.spec.env.GEMINI_HOME).toBe(home)
    expect(antigravityIsolatedHome(folder)).toBe(home)
    expect(JSON.parse(readFileSync(join(home, 'antigravity-acp', 'settings.json'), 'utf8'))).toEqual({ auth: { type: 'oauth-personal' } })
    expect(readFileSync(join(home, '.gitignore'), 'utf8')).toBe('*\n')
    // Mutation: name the declared functions (`send_message`, `invoke_subagent`…)
    // and the server rejects them, so a sealed folder keeps its own subagents.
    expect(plan.session.meta).toEqual({ agy: { disabledTools: ['schedule', 'start_subagent'] } })
    expect(ANTIGRAVITY_ISOLATED_DISABLED_TOOLS.every((name) => ANTIGRAVITY_FILTER_TOOLS.includes(name))).toBe(true)
  })

  it('maps approval to the server’s modes and sets the model as an optional config option, after new and load alike', async () => {
    const ask = await createAntigravityLauncher(deps()).plan(contexts(tempDir()).native)
    if (isRefusal(ask)) throw new Error(ask.error)
    expect(ask.setup).toEqual({ modeId: 'default' })
    const auto = await createAntigravityLauncher(deps({ settings: () => ({ model: 'gemini-3.6-flash-low', approval: 'auto' }) })).plan(contexts(tempDir()).native)
    if (isRefusal(auto)) throw new Error(auto.error)
    expect(auto.setup).toEqual({ modeId: 'yolo', configOptions: [{ configId: 'model', value: 'gemini-3.6-flash-low', optional: true }] })
  })

  it('marks a model the agent declares, so a stale one is noted in the chat', async () => {
    const declared = await createAntigravityLauncher(deps({ settings: () => ({ model: 'gemini-3.6-flash-low', modelDeclared: true, approval: 'ask' }) })).plan(contexts(tempDir()).native)
    if (isRefusal(declared)) throw new Error(declared.error)
    expect(declared.setup.modelDeclared).toBe(true)
  })

  it('puts the folder policy on the plan, with the folder, only for a folder agent on Ask', async () => {
    // Mutation: drop the plan field and no ask is ever settled by the policy.
    const folder = tempDir()
    const roots = ['/cache/catalog/word-count']
    const ask = await createAntigravityLauncher(deps({ settings: () => ({ model: null, approval: 'ask', autoApprove: { scriptRoots: roots } }) })).plan(contexts(folder).isolated)
    if (isRefusal(ask)) throw new Error(ask.error)
    expect(ask.autoApprove).toEqual({ folder, scriptRoots: roots })
    const native = await createAntigravityLauncher(deps({ settings: () => ({ model: null, approval: 'ask', autoApprove: { scriptRoots: [] } }) })).plan(contexts(folder).native)
    if (isRefusal(native)) throw new Error(native.error)
    expect(native.autoApprove).toEqual({ folder, scriptRoots: [] })
    // Automatic (yolo) asks nothing; a branch that returns no policy keeps none.
    const auto = await createAntigravityLauncher(deps({ settings: () => ({ model: null, approval: 'auto', autoApprove: { scriptRoots: roots } }) })).plan(contexts(folder).isolated)
    if (isRefusal(auto)) throw new Error(auto.error)
    expect(auto).not.toHaveProperty('autoApprove')
    const none = await createAntigravityLauncher(deps()).plan(contexts(folder).isolated)
    if (isRefusal(none)) throw new Error(none.error)
    expect(none).not.toHaveProperty('autoApprove')
  })

  it('carries the instructions as the first prompt’s preamble, chosen by the folder’s mode', async () => {
    const systemPrompt = vi.fn((_u: string, _a: string, mode: string) => (mode === 'native' ? 'Desktop context.' : 'Whole document.'))
    const { native, isolated } = contexts(tempDir())
    const bare = await createAntigravityLauncher(deps({ systemPrompt })).plan(native)
    const kit = await createAntigravityLauncher(deps({ systemPrompt })).plan(isolated)
    if (isRefusal(bare) || isRefusal(kit)) throw new Error('refused')
    expect(bare.firstPromptPreamble).toContain('<instructions>\nDesktop context.\n</instructions>')
    expect(kit.firstPromptPreamble).toContain('<instructions>\nWhole document.\n</instructions>')
    const empty = await createAntigravityLauncher(deps({ systemPrompt: () => '  ' })).plan(native)
    if (isRefusal(empty)) throw new Error(empty.error)
    expect(empty.firstPromptPreamble).toBeUndefined()
  })

  it('keeps the model, the mode and the instructions out of the process key', async () => {
    const { native } = contexts(tempDir())
    const a = await createAntigravityLauncher(deps()).plan(native)
    const b = await createAntigravityLauncher(deps({ systemPrompt: () => 'Other.', settings: () => ({ model: 'gemini-3.6-flash-low', approval: 'auto' }) })).plan(native)
    if (isRefusal(a) || isRefusal(b)) throw new Error('refused')
    expect(a.spec.key).toBe(b.spec.key)
  })

  it('refuses in a sentence when the home cannot be prepared', async () => {
    const folder = tempDir()
    // `.cinna` as a file: the home under it cannot be created.
    writeFileSync(join(folder, '.cinna'), 'not a directory')
    const plan = await createAntigravityLauncher(deps()).plan(contexts(folder).isolated)
    expect(isRefusal(plan) && plan.error).toMatch(/^Antigravity could not be prepared/)
  })
})

describe('Antigravity readiness, auth and prompts', () => {
  it('is not_logged_in with its own Log in, not_installed on a failed install, ok otherwise', async () => {
    expect(await createAntigravityLauncher(deps({ auth: async () => ({ state: 'logged_out' }) })).readiness!())
      .toEqual({ state: 'not_logged_in', reason: ANTIGRAVITY_NOT_LOGGED_IN, login: 'antigravity' })
    expect(await createAntigravityLauncher(deps({ binaryKnown: async () => ({ state: 'failed', error: 'checksum' }) })).readiness!())
      .toEqual({ state: 'not_installed', reason: ANTIGRAVITY_NOT_INSTALLED, detail: 'checksum' })
    // An unanswered probe never blocks.
    expect(await createAntigravityLauncher(deps({ auth: async () => ({ state: 'unknown' }) })).readiness!()).toEqual({ state: 'ok', reason: null })
    expect(await createAntigravityLauncher(deps({ binaryKnown: async () => ({ state: 'pending' }) })).readiness!()).toEqual({ state: 'ok', reason: null })
  })

  it('reports a Google account login for telemetry, never an account', async () => {
    expect(await createAntigravityLauncher(deps()).telemetryAuth!()).toEqual({ kind: 'subscription', label: 'Google account' })
    expect(await createAntigravityLauncher(deps({ auth: async () => ({ state: 'logged_out' }) })).telemetryAuth!()).toEqual({ kind: 'none' })
  })

  it('reads the server’s authentication errors as a lost login and re-reads the login', () => {
    const authLost = vi.fn()
    const launcher = createAntigravityLauncher(deps({ authLost }))
    expect(launcher.authError!(new RequestError(-32000, 'Authentication required', { message: 'No authentication method selected.' }))).toBe(ANTIGRAVITY_NOT_LOGGED_IN)
    expect(launcher.authError!(new RequestError(-32000, 'Logged out. Sign in again.', { reason: 'logged_out' }))).toBe(ANTIGRAVITY_NOT_LOGGED_IN)
    expect(launcher.authError!(new RequestError(-32000, 'Sign-in failed', { reason: 'onboarding_failed' }))).toBe(ANTIGRAVITY_NOT_LOGGED_IN)
    expect(authLost).toHaveBeenCalledTimes(3)
    expect(launcher.authError!(new RequestError(-32000, 'Quota exceeded', { reason: 'quota' }))).toBeNull()
    expect(launcher.authError!(new RequestError(-32603, 'Authentication required'))).toBeNull()
    expect(launcher.authError!(new Error('Authentication required'))).toBeNull()
    expect(authLost).toHaveBeenCalledTimes(3)
    expect(isAntigravityAuthError(null)).toBe(false)
  })

  it('refuses a prompt that is exactly /logout, and nothing else', () => {
    const launcher = createAntigravityLauncher(deps())
    expect(launcher.refusePrompt!('  /logout \n')).toBe(ANTIGRAVITY_LOGOUT_REFUSED)
    expect(launcher.refusePrompt!('/logout please')).toBeNull()
    expect(launcher.refusePrompt!('how do I /logout?')).toBeNull()
  })
})

describe('an isolated Antigravity home', () => {
  it('rewrites nothing that is already right', () => {
    const home = join(tempDir(), 'home')
    prepareAntigravityHome({ home, userHome: tempDir(), platform: 'darwin' })
    const settings = join(home, 'antigravity-acp', 'settings.json')
    const past = new Date(Date.now() - 60_000)
    utimesSync(settings, past, past)
    prepareAntigravityHome({ home, userHome: tempDir(), platform: 'darwin' })
    expect(Math.abs(statSync(settings).mtimeMs - past.getTime())).toBeLessThan(5)
    writeFileSync(settings, '{"auth":{"type":"gateway"}}')
    prepareAntigravityHome({ home, userHome: tempDir(), platform: 'darwin' })
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ auth: { type: 'oauth-personal' } })
  })

  it('copies the user’s Linux token in, 0600, only when it is newer or absent; never on macOS', () => {
    const userHome = tempDir()
    mkdirSync(join(userHome, 'antigravity-acp'))
    const source = join(userHome, 'antigravity-acp', 'acp_token.json')
    writeFileSync(source, '{"token":"one"}')
    const mac = join(tempDir(), 'home')
    prepareAntigravityHome({ home: mac, userHome, platform: 'darwin' })
    expect(existsSync(join(mac, 'antigravity-acp', 'acp_token.json'))).toBe(false)

    const home = join(tempDir(), 'home')
    const target = join(home, 'antigravity-acp', 'acp_token.json')
    prepareAntigravityHome({ home, userHome, platform: 'linux' })
    expect(readFileSync(target, 'utf8')).toBe('{"token":"one"}')
    expect(statSync(target).mode & 0o777).toBe(0o600)
    // The home refreshed its own copy since: an older user token stays out.
    writeFileSync(target, '{"token":"refreshed"}')
    const old = new Date(Date.now() - 60_000)
    utimesSync(source, old, old)
    prepareAntigravityHome({ home, userHome, platform: 'linux' })
    expect(readFileSync(target, 'utf8')).toBe('{"token":"refreshed"}')
    // The user signed in again: theirs is newer and replaces it.
    writeFileSync(source, '{"token":"two"}')
    const future = new Date(Date.now() + 60_000)
    utimesSync(source, future, future)
    const before = statSync(target).ino
    prepareAntigravityHome({ home, userHome, platform: 'linux' })
    expect(readFileSync(target, 'utf8')).toBe('{"token":"two"}')
    // Mutation: copy over the target in place and a server starting in this
    // home can read half a token. Replaced by rename: a new file, 0600, no
    // staging copy left behind.
    expect(statSync(target).ino).not.toBe(before)
    expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(home, 'antigravity-acp')).sort()).toEqual(['acp_token.json', 'settings.json'])
  })
})

describe('the Antigravity chat policy', () => {
  it('keeps view_file alone, by allowlist and by name, keeping what the plan carried', async () => {
    // Mutation: send only the allowlist and the server appends `ask_question`
    // back; send only the denylist and a built-in a later server adds stays
    // on; drop `view_file` and the model calls Cinna's lazy tools blind.
    const plan = await createAntigravityLauncher(deps()).plan(contexts(tempDir()).isolated)
    if (isRefusal(plan)) throw new Error(plan.error)
    const restricted = applyConductorToolPolicy(plan, 'antigravity')
    expect(restricted.session.meta).toEqual({ agy: {
      enabledTools: ['view_file'],
      // The server's filter names, not the declared function names, which it
      // rejects: `start_subagent` (not `send_message`, `invoke_subagent`…),
      // `create_file` / `edit_file` (not `write_to_file`…).
      disabledTools: [
        'ask_question', 'create_file', 'edit_file', 'find_file', 'finish', 'generate_image', 'list_directory',
        'read_url_content', 'run_command', 'schedule', 'search_directory', 'search_web', 'start_subagent'
      ]
    } })
    expect(ANTIGRAVITY_BUILTIN_TOOLS).toHaveLength(14)
    expect(restricted.spec).toBe(plan.spec)
  })
})

describe('a chat runtime’s home and the cinna-tasks skill', () => {
  function skillSource(): string {
    const dir = join(tempDir(), 'cinna-tasks')
    mkdirSync(join(dir, 'reference'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: cinna-tasks\n---\nv1\n')
    writeFileSync(join(dir, 'reference', 'verbs.md'), 'verbs\n')
    return dir
  }

  it('puts the home where the home dep says, outside the folder', async () => {
    const folder = tempDir()
    const plan = await createAntigravityLauncher(deps({ home: (_u, _a, path) => `${path}.agyhome` })).plan(contexts(folder).isolated)
    if (isRefusal(plan)) throw new Error(plan.error)
    expect(plan.spec.env.GEMINI_HOME).toBe(`${folder}.agyhome`)
    expect(existsSync(join(`${folder}.agyhome`, 'antigravity-acp', 'settings.json'))).toBe(true)
    expect(existsSync(join(folder, '.cinna'))).toBe(false)
    rmSync(`${folder}.agyhome`, { recursive: true, force: true })
  })

  it('installs the skill natively in an isolated home, and never in a native folder', async () => {
    // Mutation: skip the install and the prompt names a skill the session
    // does not have.
    const source = skillSource()
    const tasksSkill = (): { name: string; dir: string } => ({ name: 'cinna-tasks', dir: source })
    const folder = tempDir()
    const kit = await createAntigravityLauncher(deps({ tasksSkill })).plan(contexts(folder).isolated)
    if (isRefusal(kit)) throw new Error(kit.error)
    const installed = join(antigravitySkillsDir(antigravityIsolatedHome(folder)), 'cinna-tasks')
    expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toContain('v1')
    expect(readFileSync(join(installed, 'reference', 'verbs.md'), 'utf8')).toBe('verbs\n')
    const native = tempDir()
    const bare = await createAntigravityLauncher(deps({ tasksSkill })).plan(contexts(native).native)
    if (isRefusal(bare)) throw new Error(bare.error)
    expect(existsSync(join(native, '.cinna'))).toBe(false)
  })

  it('installs cinna-artifacts in an isolated home while delivered, and takes it out once it is not', async () => {
    const source = skillSource()
    const folder = tempDir()
    const installed = join(antigravitySkillsDir(antigravityIsolatedHome(folder)), 'cinna-artifacts')
    const on = await createAntigravityLauncher(deps({ artifactsSkill: () => ({ name: 'cinna-artifacts', dir: source }) })).plan(contexts(folder).isolated)
    if (isRefusal(on)) throw new Error(on.error)
    expect(existsSync(join(installed, 'SKILL.md'))).toBe(true)
    const off = await createAntigravityLauncher(deps({ artifactsSkill: () => ({ name: 'cinna-artifacts', dir: null }) })).plan(contexts(folder).isolated)
    if (isRefusal(off)) throw new Error(off.error)
    expect(existsSync(installed)).toBe(false)
  })

  it('copies the skill again only when its source changed, dropping files the source no longer has', () => {
    const source = skillSource()
    const home = join(tempDir(), 'home')
    const target = join(antigravitySkillsDir(home), 'cinna-tasks')
    installAntigravitySkill(home, { name: 'cinna-tasks', dir: source })
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(target, 'SKILL.md'), past, past)
    installAntigravitySkill(home, { name: 'cinna-tasks', dir: source })
    expect(Math.abs(statSync(join(target, 'SKILL.md')).mtimeMs - past.getTime())).toBeLessThan(5)
    writeFileSync(join(source, 'SKILL.md'), '---\nname: cinna-tasks\n---\nv2\n')
    rmSync(join(source, 'reference'), { recursive: true })
    installAntigravitySkill(home, { name: 'cinna-tasks', dir: source })
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('v2')
    expect(existsSync(join(target, 'reference'))).toBe(false)
  })
})
