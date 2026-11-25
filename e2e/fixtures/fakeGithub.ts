import { createServer, type IncomingMessage, type Server } from 'node:http'
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { repoRoot } from '../playwright.config'
import { answerAgentsFolder, test, expect, type CinnaApp } from './app'
import { installFakeAcpEngine, type FakeAcpEngine } from './fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from './seed'

/**
 * GitHub repos P1 on a fake GitHub: what `github-repos.spec.ts` and
 * `github-repos-flows.spec.ts` share.
 *
 * ## What is real and what is not
 *
 * Real: the agent's `/run:` commands (kit commands, so their children carry
 * the loopback endpoint and the git credential-helper wiring), Cinna's `gh`
 * wrapper at `<userData>/gh-shim/gh` first on that child's `PATH`, the
 * loopback `/github/token` and `/github/needed` routes, the auth service's
 * device flow, refresh, coverage, visibility and needs, the composer rows and
 * Settings → User Accounts → GitHub.
 *
 * Fake: GitHub itself (`CINNA_GITHUB_WEB_URL` / `CINNA_GITHUB_API_URL`, read
 * at call time, point at a server the spec owns), the browser
 * (`openExternalRecorder.cjs` records every `shell.openExternal` from process
 * start), and the "real" `gh` — a script in a directory the sandbox's login
 * shell puts first on `PATH`, which the wrapper execs as the first `gh` past
 * its own directories. It fails `gh auth token` (the user has no gh login of
 * their own) and otherwise prints whether `GH_TOKEN` is the OpenCinna token,
 * without printing the token. The answer to Continue comes from the scripted
 * ACP agent (`fakeAcpEngine.ts`) on a keyless fake Ollama credential.
 */

export const AGENT = 'Repo Agent'
const MODEL = 'qwen3:8b'
export const TOKEN = 'ghu_e2eFakeOpenCinnaToken0001'
const REFRESH_TOKEN = 'ghr_e2eFakeRefresh0001'
/** The device codes the fake hands out, one per `/login/device/code`, the last repeating. */
export const USER_CODES = ['WDJB-MJHT', 'QXRT-7KPM', 'HZNV-4CDF'] as const
export const USER_CODE = USER_CODES[0]
export const LOGIN = 'octo-e2e'
export const REPLY = 'Carrying on with acme/shop.'

/** The wrapper's sentences (`GITHUB_MESSAGES` in `githubLoopback.ts`): ASCII apostrophes. */
export const SIGN_IN_SENTENCE =
  "GitHub isn't connected. Ask the user to click Sign in to GitHub under the message box, then run this command again."
export const RECONNECT_SENTENCE =
  'The GitHub sign-in has expired. Ask the user to click Reconnect GitHub under the message box, then run this command again.'
export const installSentence = (repo: string): string =>
  `Cinna's GitHub app can't reach ${repo} yet. Ask the user to click Allow access under the message box, then run this command again.`
export const INSTALL_SENTENCE = installSentence('acme/shop')
/** What the fake gh prints when the wrapper served it. */
export const served = (args: string): string => `fake gh ran: ${args} with the OpenCinna token`
export const SERVED = served('repo view acme/shop')
export const codeSentence = (code: string): string => `Enter code ${code} on GitHub. Only enter a code Cinna shows you.`
export const CODE_SENTENCE = codeSentence(USER_CODE)
/** The composer's sign-in row (`composerGithubNotices.tsx`). */
export const SIGN_IN_ROW_TITLE = 'GitHub isn’t connected. This agent’s gh and git commands need a GitHub sign-in.'
export const RESOLVED_TITLE = 'GitHub is connected. Continue sends “GitHub is connected, go on” to this chat.'

/** One GitHub installation, as `/user/installations` lists it. */
export interface FakeInstall { id: number; owner: string; ownerId: number; type: 'User' | 'Organization'; repos: string[] | 'all' }

/** What the fake GitHub answers and what it was asked; reset before each test. */
export const github = {
  /** The device flow's token poll answers `authorization_pending` until this is set. */
  approve: false,
  /** When set, the device flow's token poll answers this error (`expired_token`, `access_denied`) instead. */
  deviceError: null as string | null,
  /** `expires_in` of the access token a device grant hands out. */
  deviceTtl: 28_800,
  /** `expires_in` of the access token a refresh grant hands out. */
  refreshTtl: 28_800,
  /** The refresh grant answers `bad_refresh_token`: the refresh token is dead. */
  refreshDead: false,
  /** `GET /repos/{owner}/{repo}` answers `{ private }` for a repo named here, 404 otherwise. */
  visibility: {} as Record<string, 'public' | 'private'>,
  installs: [] as FakeInstall[],
  requests: [] as { method: string; path: string; form: URLSearchParams | null; auth: string | null }[]
}

/** The device codes handed out so far, in order. */
export const deviceCodesRequested = (): number => github.requests.filter((r) => r.path === '/login/device/code').length

async function body(req: IncomingMessage): Promise<string> {
  let text = ''
  for await (const chunk of req) text += String(chunk)
  return text
}

function fakeGithub(): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const raw = await body(req)
      const form = req.method === 'POST' ? new URLSearchParams(raw) : null
      github.requests.push({ method: req.method ?? 'GET', path: url.pathname, form, auth: req.headers.authorization ?? null })
      const json = (status: number, value: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      const pair = (ttl: number) => ({ access_token: TOKEN, expires_in: ttl, refresh_token: REFRESH_TOKEN, refresh_token_expires_in: 15_811_200, token_type: 'bearer' })
      if (req.method === 'POST' && url.pathname === '/login/device/code') {
        const n = deviceCodesRequested() - 1
        const userCode = USER_CODES[Math.min(n, USER_CODES.length - 1)]
        json(200, { device_code: `e2e-device-code-${n}`, user_code: userCode, verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 })
        return
      }
      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        if (form?.get('grant_type') === 'refresh_token') {
          json(200, github.refreshDead ? { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' } : pair(github.refreshTtl))
        } else if (github.deviceError) {
          json(200, { error: github.deviceError })
        } else if (github.approve) {
          json(200, pair(github.deviceTtl))
        } else {
          json(200, { error: 'authorization_pending' })
        }
        return
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { json(401, { message: 'Bad credentials' }); return }
      if (url.pathname === '/api/user') { json(200, { login: LOGIN, id: 4242, name: 'Octo E2E', type: 'User' }); return }
      if (url.pathname === '/api/user/installations') {
        json(200, {
          total_count: github.installs.length,
          installations: github.installs.map((i) => ({
            id: i.id, account: { login: i.owner, id: i.ownerId, type: i.type }, repository_selection: i.repos === 'all' ? 'all' : 'selected'
          }))
        })
        return
      }
      const repos = /^\/api\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname)
      if (repos) {
        const install = github.installs.find((i) => i.id === Number(repos[1]))
        const names = install && install.repos !== 'all' ? install.repos : []
        json(200, { total_count: names.length, repositories: names.map((full_name) => ({ full_name })) })
        return
      }
      const repo = /^\/api\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname)
      if (repo) {
        const name = `${repo[1]}/${repo[2]}`
        const seen = github.visibility[name]
        if (seen) json(200, { full_name: name, private: seen === 'private' })
        else json(404, { message: 'Not Found' })
        return
      }
      json(404, { message: 'Not Found' })
    })()
  })
}

function fakeOllama(): Server {
  return createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' } }] }))
      return
    }
    if (req.url === '/api/version') { res.end(JSON.stringify({ version: '0.6.2' })); return }
    res.statusCode = 404
    res.end('{}')
  })
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

export const close = (server: Server): Promise<void> => new Promise<void>((resolve) => server.close(() => resolve()))

let ollamaHost = ''

/**
 * Registers, for the calling spec file, the fake GitHub and fake Ollama (started once), the env
 * that points the app at the fake GitHub, the openExternal recorder, and a reset of {@link github}
 * before each test. Call it once at the top level of the spec.
 */
export function useFakeGithub(): void {
  let githubServer: Server
  let ollamaServer: Server
  /** Filled in `beforeAll`; the fixture reads it at each launch. */
  const githubEnv: Record<string, string> = {}
  test.use({ env: githubEnv, mainRequire: [join(repoRoot, 'e2e', 'fixtures', 'openExternalRecorder.cjs')] })
  test.beforeAll(async () => {
    githubServer = fakeGithub()
    const origin = await listen(githubServer)
    githubEnv.CINNA_GITHUB_WEB_URL = origin
    githubEnv.CINNA_GITHUB_API_URL = `${origin}/api`
    ollamaServer = fakeOllama()
    ollamaHost = await listen(ollamaServer)
  })
  test.afterAll(async () => {
    await close(githubServer)
    await close(ollamaServer)
  })
  test.beforeEach(() => {
    github.approve = false
    github.deviceError = null
    github.deviceTtl = 28_800
    github.refreshTtl = 28_800
    github.refreshDead = false
    github.visibility = {}
    github.installs = []
    github.requests = []
  })
}

/**
 * The "real" gh, first on the login shell's `PATH` (the rc files the sandbox
 * wrote end with this directory prepended). The wrapper finds it past its own
 * directories; nothing else named `gh` on the developer's machine is reached.
 */
function installFakeGh(cinna: CinnaApp): void {
  const dir = join(cinna.sandbox.root, 'fake-gh')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'gh'), [
    '#!/bin/sh',
    'if [ "$1" = auth ] && [ "$2" = token ]; then echo "no oauth token found for github.com" >&2; exit 1; fi',
    `if [ "$GH_TOKEN" = '${TOKEN}' ]; then t='the OpenCinna token'; elif [ -n "$GH_TOKEN" ]; then t='another token'; else t='no token'; fi`,
    'echo "fake gh ran: $* with $t"',
    'exit 0',
    ''
  ].join('\n'))
  chmodSync(join(dir, 'gh'), 0o755)
  for (const rc of ['.zprofile', '.zshrc', '.bash_profile', '.profile']) {
    appendFileSync(join(cinna.sandbox.home, rc), `export PATH=${JSON.stringify(dir)}:"$PATH"\n`)
  }
}

/** The default command: `gh repo view acme/shop`, its exit code echoed so the command itself succeeds and shows both. */
export const GH_CHECK = { 'gh-check': 'gh repo view acme/shop 2>&1\necho "gh exit: $?"\n' }

export interface Arranged { acp: FakeAcpEngine; agentId: string; agentPath: string }

/**
 * A kit agent with one `/run:<name>` per entry of `commands` (a `/bin/sh` script body each), the
 * fake engine on a keyless credential, the fake gh on `PATH`, and a restart so the shell
 * environment is probed again and the composer sees the agent.
 */
export async function arrange(cinna: CinnaApp, commands: Record<string, string> = GH_CHECK): Promise<Arranged> {
  await cinna.skipOnboarding()
  const acp = await installFakeAcpEngine(cinna, {
    prompt: { emit: [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } } }] }
  })
  await cinna.page.evaluate(async ({ host, model }) => {
    const { id } = await window.api.providers.upsert({ type: 'ollama', name: 'Ollama', baseUrl: host, enabled: true })
    await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId: model, isDefault: true })
  }, { host: ollamaHost, model: MODEL })
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, AGENT)
  let yaml = ''
  for (const [name, script] of Object.entries(commands)) {
    writeFileSync(join(agent.path, 'scripts', `${name}.sh`), `#!/bin/sh\n${script}`)
    yaml += `\n  - name: ${name}\n    description: ${name} for the GitHub E2E\n    command: /bin/sh scripts/${name}.sh\n`
  }
  // Beside the scaffold's own `status` entry, which its manifest's status_refresh_command names.
  appendFileSync(join(agent.path, 'docs', 'CLI_COMMANDS.yaml'), yaml)
  installFakeGh(cinna)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return { acp, agentId: agent.id, agentPath: agent.path }
}

/** Agents → the agent's page → Settings → Commands → Run on `/run:<command>`: a new chat runs it. */
export async function runFromCommands(cinna: CinnaApp, command = 'gh-check'): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Commands/ }).click()
  await page.getByRole('listitem').filter({ hasText: `/run:${command}` }).getByRole('button', { name: 'Run', exact: true }).click()
}

/** The output of the chat's `n`-th `/run:` (0-based), as its code block shows it. */
export const commandOutput = (cinna: CinnaApp, n: number) => cinna.page.locator('pre code').nth(n)

/**
 * `/run:<command>` typed into this chat's composer and sent with Send: Enter
 * would pick the open command suggestion instead of sending.
 */
export async function rerunInChat(cinna: CinnaApp, command = 'gh-check'): Promise<void> {
  const input = cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(`/run:${command}`)
  await cinna.page.getByRole('button', { name: 'Send', exact: true }).click()
}

/** The composer notice panel while it holds a warning row (a GitHub need). */
export const panel = (cinna: CinnaApp) => cinna.page.getByRole('status', { name: 'Agent status' })
/** The same panel when its only row is the resolved offer: an accent row names the panel `GitHub`. */
export const resolvedPanel = (cinna: CinnaApp) => cinna.page.getByRole('status', { name: 'GitHub' })

/** Every URL main handed to `shell.openExternal` since launch. */
export async function openedUrls(cinna: CinnaApp): Promise<string[]> {
  return cinna.electronApp.evaluate(() => {
    const seen = (globalThis as { __cinnaOpenedUrls?: string[] }).__cinnaOpenedUrls
    if (!seen) throw new Error('openExternalRecorder.cjs is not loaded in main: a sign-in would open a real browser')
    return [...seen]
  })
}

/** The active profile's GitHub account state over IPC (`connected`, `expired`, null signed out, or main's error). */
export async function accountState(cinna: CinnaApp): Promise<string | null> {
  const status = await cinna.page.evaluate(() => window.api.github.status())
  return status.ok ? status.value.account?.state ?? null : status.error
}

/** Sign in over IPC with the fake approving at once; resolves when main reports it connected. */
export async function signInOverIpc(cinna: CinnaApp): Promise<void> {
  github.approve = true
  const started = await cinna.page.evaluate(() => window.api.github.signIn())
  expect(started.ok).toBe(true)
  await expect.poll(() => accountState(cinna), { message: 'the device flow completes against the fake GitHub' }).toBe('connected')
}
