import { createServer, type IncomingMessage, type Server } from 'node:http'
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { repoRoot } from '../playwright.config'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine, type FakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * GitHub repos P1: a kit agent's `gh` against the OpenCinna sign-in, with
 * every GitHub endpoint faked on loopback.
 *
 * ## What is real and what is not
 *
 * Real: the agent's `/run:` command (a kit command, so its child carries the
 * loopback endpoint), Cinna's `gh` wrapper at `<userData>/gh-shim/gh` first on
 * that child's `PATH`, the loopback `/github/token` and `/github/needed`
 * routes, the auth service's device flow, coverage and needs, the composer
 * rows and Settings → User Accounts → GitHub.
 *
 * Fake: GitHub itself (`CINNA_GITHUB_WEB_URL` / `CINNA_GITHUB_API_URL`, read
 * at call time, point at a server this spec owns), the browser
 * (`openExternalRecorder.cjs` records every `shell.openExternal` from process
 * start), and the "real" `gh` — a script in a directory the sandbox's login
 * shell puts first on `PATH`, which the wrapper execs as the first `gh` past
 * its own directories. It fails `gh auth token` (the user has no gh login of
 * their own) and otherwise prints whether `GH_TOKEN` is the OpenCinna token,
 * without printing the token. The answer to Continue comes from the scripted
 * ACP agent (`fakeAcpEngine.ts`) on a keyless fake Ollama credential.
 */

const AGENT = 'Repo Agent'
const MODEL = 'qwen3:8b'
const TOKEN = 'ghu_e2eFakeOpenCinnaToken0001'
const USER_CODE = 'WDJB-MJHT'
const LOGIN = 'octo-e2e'
const REPLY = 'Carrying on with acme/shop.'

const SIGN_IN_SENTENCE =
  "GitHub isn't connected. Ask the user to click Sign in to GitHub under the message box, then run this command again."
const INSTALL_SENTENCE =
  "Cinna's GitHub app can't reach acme/shop yet. Ask the user to click Allow access under the message box, then run this command again."
const SERVED = 'fake gh ran: repo view acme/shop with the OpenCinna token'
const CODE_SENTENCE = `Enter code ${USER_CODE} on GitHub. Only enter a code Cinna shows you.`

/** One GitHub installation, as `/user/installations` lists it. */
interface FakeInstall { id: number; owner: string; ownerId: number; type: 'User' | 'Organization'; repos: string[] | 'all' }

/** What the fake GitHub answers and what it was asked; reset before each test. */
const github = {
  /** The device flow's token poll answers `authorization_pending` until this is set. */
  approve: false,
  installs: [] as FakeInstall[],
  requests: [] as { method: string; path: string; form: URLSearchParams | null; auth: string | null }[]
}

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
      if (req.method === 'POST' && url.pathname === '/login/device/code') {
        json(200, { device_code: 'e2e-device-code', user_code: USER_CODE, verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 })
        return
      }
      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        const grant = form?.get('grant_type')
        if (grant === 'refresh_token' || github.approve) {
          json(200, { access_token: TOKEN, expires_in: 28_800, refresh_token: 'ghr_e2eFakeRefresh0001', refresh_token_expires_in: 15_811_200, token_type: 'bearer' })
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

/** The Repo Agent's id, set by {@link arrange}. */
let repoAgentId = ''
let githubServer: Server
let ollamaServer: Server
let ollamaHost = ''
/** Filled in `beforeAll`; the fixture reads it at each launch. */
const githubEnv: Record<string, string> = {}

test.use({ env: githubEnv, mainRequire: [join(repoRoot, 'e2e', 'fixtures', 'openExternalRecorder.cjs')] })

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

test.beforeAll(async () => {
  githubServer = fakeGithub()
  const origin = await listen(githubServer)
  githubEnv.CINNA_GITHUB_WEB_URL = origin
  githubEnv.CINNA_GITHUB_API_URL = `${origin}/api`
  ollamaServer = fakeOllama()
  ollamaHost = await listen(ollamaServer)
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => githubServer.close(() => resolve()))
  await new Promise<void>((resolve) => ollamaServer.close(() => resolve()))
})

test.beforeEach(() => {
  github.approve = false
  github.installs = []
  github.requests = []
})

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

/**
 * A kit agent with `/run:gh-check` (`gh repo view acme/shop`, its exit code
 * echoed so the command itself succeeds and shows both), the fake engine on a
 * keyless credential, the fake gh on `PATH`, and a restart so the shell
 * environment is probed again and the composer sees the agent.
 */
async function arrange(cinna: CinnaApp): Promise<FakeAcpEngine> {
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
  repoAgentId = agent.id
  writeFileSync(join(agent.path, 'scripts', 'gh-check.sh'), '#!/bin/sh\ngh repo view acme/shop 2>&1\necho "gh exit: $?"\n')
  // Beside the scaffold's own `status` entry, which its manifest's status_refresh_command names.
  appendFileSync(join(agent.path, 'docs', 'CLI_COMMANDS.yaml'),
    '\n  - name: gh-check\n    description: View acme/shop with gh\n    command: /bin/sh scripts/gh-check.sh\n')
  installFakeGh(cinna)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return acp
}

/** Agents → the agent's page → Settings → Commands → Run on `/run:gh-check`: a new chat runs it. */
async function runFromCommands(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Commands/ }).click()
  await page.getByRole('listitem').filter({ hasText: '/run:gh-check' }).getByRole('button', { name: 'Run', exact: true }).click()
}

/** The output of the chat's `n`-th `/run:gh-check` (0-based), as its code block shows it. */
const commandOutput = (cinna: CinnaApp, n: number) => cinna.page.locator('pre code').nth(n)

/**
 * `/run:gh-check` typed into this chat's composer and sent with Send: Enter
 * would pick the open command suggestion instead of sending.
 */
async function rerunInChat(cinna: CinnaApp): Promise<void> {
  const input = cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill('/run:gh-check')
  await cinna.page.getByRole('button', { name: 'Send', exact: true }).click()
}

/** The composer notice panel while it holds a warning row (a GitHub need). */
const panel = (cinna: CinnaApp) => cinna.page.getByRole('status', { name: 'Agent status' })
/** The same panel when its only row is the resolved offer: an accent row names the panel `GitHub`. */
const resolvedPanel = (cinna: CinnaApp) => cinna.page.getByRole('status', { name: 'GitHub' })
const RESOLVED_TITLE = 'GitHub is connected. Continue sends “GitHub is connected, go on” to this chat.'

/** Every URL main handed to `shell.openExternal` since launch. */
async function openedUrls(cinna: CinnaApp): Promise<string[]> {
  return cinna.electronApp.evaluate(() => {
    const seen = (globalThis as { __cinnaOpenedUrls?: string[] }).__cinnaOpenedUrls
    if (!seen) throw new Error('openExternalRecorder.cjs is not loaded in main: a sign-in would open a real browser')
    return [...seen]
  })
}

/** Sign in over IPC with the fake approving at once; resolves when main reports it connected. */
async function signInOverIpc(cinna: CinnaApp): Promise<void> {
  github.approve = true
  const started = await cinna.page.evaluate(() => window.api.github.signIn())
  expect(started.ok).toBe(true)
  await expect.poll(async () => {
    const status = await cinna.page.evaluate(() => window.api.github.status())
    return status.ok ? status.value.account?.state ?? null : status.error
  }, { message: 'the device flow completes against the fake GitHub' }).toBe('connected')
}

test('sign in from the composer: the refused gh shows the row, the device code, Continue, then gh runs on the OpenCinna token', async ({ cinna }) => {
  test.setTimeout(120_000)
  // The app is installed on acme with every repository: the sign-in is all that is missing.
  github.installs = [{ id: 77, owner: 'acme', ownerId: 9001, type: 'Organization', repos: 'all' }]
  const acp = await arrange(cinna)

  await test.step('gh is refused with exit 4 and the sign-in sentence; the composer offers Sign in to GitHub', async () => {
    await runFromCommands(cinna)
    await expect(commandOutput(cinna, 0)).toHaveText(`${SIGN_IN_SENTENCE}\ngh exit: 4`)
    await expect(panel(cinna).getByTitle('GitHub isn’t connected. This agent’s gh and git commands need a GitHub sign-in.')).toHaveText('GitHub isn’t connected.')
    await expect(panel(cinna).getByRole('button', { name: 'Sign in to GitHub' })).toBeVisible()
  })

  await test.step('Sign in to GitHub shows the fake device code and opens github.com/login/device, not a browser', async () => {
    await panel(cinna).getByRole('button', { name: 'Sign in to GitHub' }).click()
    await expect(panel(cinna).getByTitle(CODE_SENTENCE)).toHaveText(CODE_SENTENCE)
    await expect(panel(cinna).getByText('Waiting for you to approve in the browser…', { exact: true })).toBeVisible()
    expect(await openedUrls(cinna)).toEqual(['https://github.com/login/device'])
    expect(github.requests.filter((r) => r.path === '/login/device/code')).toHaveLength(1)
  })

  await test.step('the fake approves on the next poll: GitHub is connected, and Continue sends the line to the agent', async () => {
    github.approve = true
    const resolved = resolvedPanel(cinna).getByTitle(RESOLVED_TITLE)
    await expect(resolved).toHaveText('GitHub is connected.')
    await resolvedPanel(cinna).getByRole('button', { name: 'Continue' }).click()
    await expect(cinna.page.getByText('GitHub is connected, go on', { exact: true })).toBeVisible()
    await expect(cinna.page.getByText(REPLY, { exact: true })).toBeVisible()
    await expect(resolved).toHaveCount(0)
    const prompts = acp.received('session/prompt').map((entry) => JSON.stringify(entry))
    expect(prompts.some((p) => p.includes('GitHub is connected, go on'))).toBe(true)
  })

  await test.step('the same command now runs the real gh with the OpenCinna token', async () => {
    await rerunInChat(cinna)
    await expect(commandOutput(cinna, 1)).toHaveText(`${SERVED}\ngh exit: 0`)
    await expect(panel(cinna).getByRole('button', { name: 'Sign in to GitHub' })).toHaveCount(0)
  })
})

test('an installation without the repo: Allow access opens its configure page, and a recheck on focus resolves it', async ({ cinna }) => {
  test.setTimeout(120_000)
  github.installs = [{ id: 77, owner: 'acme', ownerId: 9001, type: 'Organization', repos: ['acme/site'] }]
  await arrange(cinna)
  await signInOverIpc(cinna)

  await test.step('gh is refused with exit 4 and the install sentence; the composer offers Allow access', async () => {
    await runFromCommands(cinna)
    await expect(commandOutput(cinna, 0)).toHaveText(`${INSTALL_SENTENCE}\ngh exit: 4`)
    await expect(panel(cinna).getByTitle(/^Cinna’s GitHub app can’t reach acme\/shop yet\./)).toHaveText('Cinna’s GitHub app can’t reach acme/shop yet.')
  })

  await test.step('Allow access opens the installation’s configure page', async () => {
    await panel(cinna).getByRole('button', { name: 'Allow access' }).click()
    await expect.poll(() => openedUrls(cinna)).toEqual([
      'https://github.com/login/device',
      'https://github.com/organizations/acme/settings/installations/77'
    ])
  })

  await test.step('back from GitHub with acme/shop selected: the window’s focus rechecks and the row resolves', async () => {
    github.installs = [{ id: 77, owner: 'acme', ownerId: 9001, type: 'Organization', repos: ['acme/site', 'acme/shop'] }]
    await cinna.page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(resolvedPanel(cinna).getByTitle(RESOLVED_TITLE)).toHaveText('GitHub is connected.')
    await expect(panel(cinna).getByRole('button', { name: 'Allow access' })).toHaveCount(0)
  })

  await test.step('the same command now runs the real gh with the OpenCinna token', async () => {
    await rerunInChat(cinna)
    await expect(commandOutput(cinna, 1)).toHaveText(`${SERVED}\ngh exit: 0`)
  })
})

test('Settings → User Accounts → GitHub shows the login and covered repos, and Sign out goes through the confirm', async ({ cinna }) => {
  github.installs = [
    { id: 55, owner: LOGIN, ownerId: 4242, type: 'User', repos: 'all' },
    { id: 77, owner: 'acme', ownerId: 9001, type: 'Organization', repos: ['acme/shop', 'acme/site'] }
  ]
  await cinna.skipOnboarding()
  await signInOverIpc(cinna)

  const page = cinna.page
  const me = await page.evaluate(() => window.api.auth.getCurrent())
  await page.getByTitle(me!.cinnaFullName ?? me!.displayName, { exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'User Accounts', exact: true }).click()

  await test.step('the login, and one line per installation', async () => {
    await expect(page.getByTitle(LOGIN, { exact: true })).toHaveText(LOGIN)
    await expect(page.getByRole('list', { name: 'Repositories Cinna can reach' }).getByRole('listitem'))
      .toHaveText([`${LOGIN}: all repositories`, 'acme: shop, site'])
  })

  await test.step('Manage repository access opens the app’s install page', async () => {
    await page.getByRole('button', { name: 'Manage repository access' }).click()
    await expect.poll(() => openedUrls(cinna)).toEqual([
      'https://github.com/login/device',
      'https://github.com/apps/opencinna/installations/new'
    ])
  })

  await test.step('Sign out → the confirm → Sign out: the section asks to sign in again', async () => {
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Sign out of GitHub' })
    await expect(dialog.getByText(LOGIN, { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText('Lets this profile’s agents work on your GitHub repos.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in to GitHub' })).toBeVisible()
    const status = await page.evaluate(() => window.api.github.status())
    expect(status.ok && status.value.account).toBeNull()
  })
})

/** Point the agent's `status_refresh_command` at `/run:gh-check`, through the manifest editor. */
async function statusRunsGhCheck(cinna: CinnaApp): Promise<void> {
  await cinna.page.evaluate(async (id) => {
    const current = await window.api.localAgents.get(id)
    if (!current.ok) throw new Error(current.message)
    const stamp = current.value.stamps['cinna-agent.json']
    if (!stamp) throw new Error('Fixture manifest has no stamp')
    const changed = await window.api.localAgents.updateField({ agentId: id, update: { field: 'status_refresh_command', value: '/run:gh-check' }, expectedStamp: stamp })
    if (!changed.ok) throw new Error(changed.message)
  }, repoAgentId)
}

async function openInbox(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
  await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
}

/** Agents → the agent's page, on its chat side (the new-chat composer with its notice panel). */
async function openAgentPage(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
}

test('a run with no chat (the status refresh) is refused: an Inbox card and the agent page row, both cleared by signing in', async ({ cinna }) => {
  test.setTimeout(120_000)
  github.installs = [{ id: 77, owner: 'acme', ownerId: 9001, type: 'Organization', repos: 'all' }]
  await arrange(cinna)
  await statusRunsGhCheck(cinna)
  const card = cinna.page.getByRole('article', { name: 'GitHub isn’t connected for Repo Agent' })

  await test.step('Refresh status runs /run:gh-check with no chat; its refused gh records a need a run with no chat hit', async () => {
    const refreshed = await cinna.page.evaluate((agentId) => window.api.agentStatus.get({ agentId, intent: 'manual' }), repoAgentId)
    expect(refreshed.success).toBe(true)
    await expect.poll(async () => {
      const status = await cinna.page.evaluate(() => window.api.github.status())
      return status.ok ? status.value.needs : status.error
    }).toEqual([{ key: 'account', kind: 'sign_in', agentIds: [repoAgentId], chatlessAgentIds: [repoAgentId] }])
  })

  await test.step('the Inbox has a card naming the agent, with Sign in to GitHub and Dismiss', async () => {
    await openInbox(cinna)
    await expect(card).toBeVisible()
    await expect(card.getByRole('button', { name: 'Sign in to GitHub' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Dismiss' })).toBeVisible()
  })

  await test.step('the agent’s page shows the composer’s own row', async () => {
    await openAgentPage(cinna)
    await expect(panel(cinna).getByTitle('GitHub isn’t connected. This agent’s gh and git commands need a GitHub sign-in.')).toHaveText('GitHub isn’t connected.')
  })

  await test.step('Sign in to GitHub from the row: the code, then approved; the row goes, with no Continue', async () => {
    await panel(cinna).getByRole('button', { name: 'Sign in to GitHub' }).click()
    await expect(panel(cinna).getByTitle(CODE_SENTENCE)).toHaveText(CODE_SENTENCE)
    github.approve = true
    await expect(cinna.page.getByRole('button', { name: 'Sign in to GitHub' })).toHaveCount(0)
    await expect(cinna.page.getByTitle(RESOLVED_TITLE)).toHaveCount(0)
    expect(await openedUrls(cinna)).toEqual(['https://github.com/login/device'])
  })

  await test.step('the Inbox card is gone too', async () => {
    await openInbox(cinna)
    await expect(cinna.page.getByText('Nothing is waiting on you.', { exact: true })).toBeVisible()
    await expect(card).toHaveCount(0)
  })
})
