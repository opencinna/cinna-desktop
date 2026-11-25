import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} })
}))

const {
  createGhShim, ghShimScript, withGithubCredentialHelper, withoutGithubCredentialHelper, githubCredentialHelperFor,
  GH_NETWORK_MESSAGE, GH_INSTALLING_MESSAGE, GH_SLOW_MESSAGE, GH_NOT_INSTALLED_MESSAGE, GITHUB_HELPER_KEY, GITHUB_USE_HTTP_PATH_KEY
} = await import('./ghShim')
const { GITHUB_MESSAGES } = await import('../services/github/githubLoopback')

type Env = Record<string, string | undefined>

const BEARER = 'bearer-Zx9_abcDEF123'
const TOKEN = 'ghu_token-Value-987'

/** An absolute path for each tool the wrapper and the fakes run; a test without one skips. */
function resolveTool(name: string): string | null {
  const run = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' })
  const found = run.stdout.trim()
  return run.status === 0 && found.startsWith('/') ? found : null
}
const TOOLS = ['sed', 'head', 'cat', 'env', 'mkdir', 'git', 'curl', 'basename']
const toolPaths = Object.fromEntries(TOOLS.map((name) => [name, resolveTool(name)]))
const hasCurl = toolPaths.curl !== null
const hasGit = toolPaths.git !== null

const roots: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** userData with a space in it, as on macOS ("Application Support"). */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'gh-shim-'))
  roots.push(root)
  const userData = join(root, 'Application Support', 'Cinna')
  mkdirSync(userData, { recursive: true })
  return { root, userData }
}

function shimFor(userData: string, platform: NodeJS.Platform = 'darwin') {
  return createGhShim({
    platform,
    shimDir: () => join(userData, 'gh-shim'),
    configDir: () => join(userData, 'gh-config'),
    managedGh: () => join(userData, 'runtimes', 'gh-2.105.0', 'bin', 'gh'),
    otherOwnDirs: () => [join(userData, 'tool-shims'), join(userData, 'git-shim')]
  })
}

/** A fake real `gh`: prints its argv and what it got in the env, never the token's value. */
const FAKE_GH = `#!/bin/sh
echo "argv:$*"
if [ "$GH_TOKEN" = "${TOKEN}" ]; then echo "GH_TOKEN=served"; elif [ -n "$GH_TOKEN" ]; then echo "GH_TOKEN=other"; else echo "GH_TOKEN=unset"; fi
echo "GH_CONFIG_DIR=\${GH_CONFIG_DIR:-unset}"
echo "GH_PROMPT_DISABLED=\${GH_PROMPT_DISABLED:-unset}"
echo "GITHUB_TOKEN=\${GITHUB_TOKEN:-unset}"
echo "GH_HOST=\${GH_HOST:-unset}"
env > "$FAKE_GH_ENV_DUMP"
if [ "$1 $2" = "auth token" ]; then [ "$FAKE_GH_LOGIN" = 1 ] && exit 0; exit 1; fi
if [ "$1 $2" = "auth git-credential" ]; then echo "fake-credential $3"; cat; exit 0; fi
if [ "$1 $2" = "repo clone" ]; then git init -q "\${4:-shop}" || exit 9; exit "\${FAKE_GH_CLONE_EXIT:-0}"; fi
exit 0
`

type Answer = { status: number; body: unknown }
type Recorded = { path: string; auth: string | undefined; body: unknown }

async function startLoopback(answer: (path: string, body: Record<string, unknown>) => Answer | null, neededBody: unknown = { ok: true }) {
  const requests: Recorded[] = []
  const server = createServer((req: IncomingMessage, res) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => {
      const body = data ? (JSON.parse(data) as Record<string, unknown>) : {}
      requests.push({ path: req.url ?? '', auth: req.headers.authorization, body })
      const out = req.url === '/github/needed' ? { status: 200, body: neededBody } : answer(req.url ?? '', body)
      // null: take the request and never answer (a hung GitHub refresh behind the endpoint).
      if (out === null) return
      res.writeHead(out.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out.body))
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}/github`, requests, server }
}

async function closedPort(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise((resolve) => server.close(resolve))
  return `http://127.0.0.1:${port}/github`
}

const tokenAnswer = (): Answer => ({ status: 200, body: { token: TOKEN, expires_at: 1, login: 'alice', name: 'Alice Doe', email: '1+alice@users.noreply.github.com' } })
const neededAnswer = (kind: 'sign_in' | 'install', repo?: string): Answer => ({
  status: 200,
  body: kind === 'install' ? { needed: 'install', message: GITHUB_MESSAGES.install(repo ?? ''), repo } : { needed: kind, message: GITHUB_MESSAGES.sign_in }
})

interface Fixture {
  root: string
  userData: string
  wrapper: string
  configDir: string
  home: string
  curlLog: string
  envDump: string
  fakeGhDir: string
  toolsDir: string
  curlDir: string
}

let fx: Fixture

beforeEach(async () => {
  const { root, userData } = makeRoot()
  await shimFor(userData).apply({ PATH: '/usr/bin' })
  const fakeGhDir = join(root, 'fake gh bin')
  mkdirSync(fakeGhDir)
  writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH, { mode: 0o755 })
  // Only the tools the wrapper needs: no gh of the machine's own can answer.
  const toolsDir = join(root, 'tools')
  mkdirSync(toolsDir)
  for (const [name, path] of Object.entries(toolPaths)) if (path && name !== 'curl') symlinkSync(path, join(toolsDir, name))
  // A curl that logs its argv, then runs the real one.
  const curlDir = join(root, 'curl bin')
  mkdirSync(curlDir)
  const curlLog = join(root, 'curl.log')
  if (toolPaths.curl) {
    // FAKE_CURL_MAX_TIME (the timeout test) caps the wait: curl takes the last --max-time.
    writeFileSync(
      join(curlDir, 'curl'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${curlLog}'\nexec '${toolPaths.curl}' "$@" \${FAKE_CURL_MAX_TIME:+--max-time "$FAKE_CURL_MAX_TIME"}\n`,
      { mode: 0o755 }
    )
  }
  const home = join(root, 'home')
  mkdirSync(home)
  writeFileSync(join(home, '.gitconfig'), '')
  fx = {
    root,
    userData,
    wrapper: join(userData, 'gh-shim', 'gh'),
    configDir: join(userData, 'gh-config'),
    home,
    curlLog,
    envDump: join(root, 'gh-env.txt'),
    fakeGhDir,
    toolsDir,
    curlDir
  }
})

interface RunOptions {
  endpoint?: string
  realGh?: boolean
  ownLogin?: boolean
  input?: string
  cwd?: string
  extraEnv?: Record<string, string>
}

function baseEnv(options: RunOptions): Record<string, string> {
  const path = [join(fx.userData, 'gh-shim'), fx.curlDir, ...(options.realGh === false ? [] : [fx.fakeGhDir]), fx.toolsDir].join(':')
  return {
    PATH: path,
    HOME: fx.home,
    GIT_CONFIG_GLOBAL: join(fx.home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    FAKE_GH_ENV_DUMP: fx.envDump,
    FAKE_GH_LOGIN: options.ownLogin ? '1' : '0',
    GITHUB_TOKEN: 'shell-token',
    GH_HOST: 'example.com',
    ...(options.endpoint ? { CINNA_GITHUB_URL: options.endpoint, CINNA_GITHUB_AUTH: BEARER } : {}),
    ...options.extraEnv
  }
}

function run(args: string[], options: RunOptions = {}, env = baseEnv(options)): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', [fx.wrapper, ...args], { env, cwd: options.cwd ?? fx.root })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (status) => resolve({ status, stdout, stderr }))
    child.stdin.end(options.input ?? '')
  })
}

const curlArgv = (): string => (existsSync(fx.curlLog) ? readFileSync(fx.curlLog, 'utf8') : '')

describe('the wrapper and git wiring in the env', () => {
  it('writes an executable wrapper and an empty gh-config, and puts the wrapper first on PATH', async () => {
    const shim = shimFor(fx.userData)
    const env = await shim.apply({ PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/x' })
    expect(env.PATH).toBe(`${join(fx.userData, 'gh-shim')}:/opt/homebrew/bin:/usr/bin`)
    expect(env.HOME).toBe('/Users/x')
    expect(statSync(fx.wrapper).mode & 0o777).toBe(0o755)
    expect(statSync(fx.configDir).isDirectory()).toBe(true)
  })

  it('is idempotent and adds no git entries: the directory is not added twice', async () => {
    const shim = shimFor(fx.userData)
    const once = await shim.apply<Env>({ PATH: '/usr/bin' })
    const twice = await shim.apply(once)
    expect(twice).toEqual(once)
    expect(Object.keys(twice).filter((key) => key.startsWith('GIT_CONFIG'))).toEqual([])
    // A PATH that has the directory further back gets it moved to the front, once.
    const moved = await shim.apply({ ...once, PATH: `/usr/bin:${join(fx.userData, 'gh-shim')}` })
    expect(moved.PATH).toBe(`${join(fx.userData, 'gh-shim')}:/usr/bin`)
  })

  it('removes our git entries an env already carries, keeping and renumbering the user ones', async () => {
    const wired = withGithubCredentialHelper<Env>({ PATH: '/usr/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat' }, fx.wrapper)
    const user = { GIT_CONFIG_KEY_4: 'user.name', GIT_CONFIG_VALUE_4: 'U', GIT_CONFIG_COUNT: '5' }
    const env = await shimFor(fx.userData).apply<Env>({ ...wired, ...user })
    expect(Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('GIT_CONFIG')))).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.pager',
      GIT_CONFIG_VALUE_0: 'cat',
      GIT_CONFIG_KEY_1: 'user.name',
      GIT_CONFIG_VALUE_1: 'U'
    })
  })

  it('also on Linux; never on Windows', async () => {
    expect((await shimFor(fx.userData, 'linux').apply<Env>({ PATH: '/usr/bin' })).PATH).toBe(`${join(fx.userData, 'gh-shim')}:/usr/bin`)
    const env = { PATH: 'C:\\bin' }
    expect(await shimFor(fx.userData, 'win32').apply(env)).toBe(env)
  })

  it('rewrites a wrapper whose content was changed', async () => {
    writeFileSync(fx.wrapper, '#!/bin/sh\nexit 0\n')
    await shimFor(fx.userData).apply({ PATH: '/usr/bin' })
    expect(readFileSync(fx.wrapper, 'utf8')).toBe(
      ghShimScript({
        configDir: fx.configDir,
        managedGh: join(fx.userData, 'runtimes', 'gh-2.105.0', 'bin', 'gh'),
        ownDirs: [join(fx.userData, 'gh-shim'), join(fx.userData, 'tool-shims'), join(fx.userData, 'git-shim')]
      })
    )
  })

  it('leaves the env alone when the wrapper cannot be written', async () => {
    const blocker = join(fx.root, 'file')
    writeFileSync(blocker, '')
    const env = { PATH: '/usr/bin' }
    expect(await shimFor(join(blocker, 'x')).apply(env)).toBe(env)
  })

  it('appends the three git entries after an existing count of 2, keeping the user entries', () => {
    const helperPath = '/Users/a/Library/Application Support/Cinna/gh-shim/gh'
    const env = withGithubCredentialHelper(
      { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'U', GIT_CONFIG_KEY_1: 'core.pager', GIT_CONFIG_VALUE_1: 'cat' },
      helperPath
    )
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'U',
      GIT_CONFIG_KEY_1: 'core.pager',
      GIT_CONFIG_VALUE_1: 'cat',
      GIT_CONFIG_KEY_2: GITHUB_HELPER_KEY,
      GIT_CONFIG_VALUE_2: '',
      GIT_CONFIG_KEY_3: GITHUB_HELPER_KEY,
      GIT_CONFIG_VALUE_3: "!'/Users/a/Library/Application Support/Cinna/gh-shim/gh' auth git-credential",
      GIT_CONFIG_KEY_4: GITHUB_USE_HTTP_PATH_KEY,
      GIT_CONFIG_VALUE_4: 'true'
    })
    expect(withGithubCredentialHelper(env, helperPath)).toBe(env)
  })

  it('withoutGithubCredentialHelper: only our three entries go, COUNT follows, the same object when none', () => {
    const helperPath = '/Users/a/Library/Application Support/Cinna/gh-shim/gh'
    const user = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'U', GIT_CONFIG_KEY_1: GITHUB_HELPER_KEY, GIT_CONFIG_VALUE_1: 'store' }
    expect(withoutGithubCredentialHelper(withGithubCredentialHelper<Env>(user, helperPath))).toEqual(user)
    expect(withoutGithubCredentialHelper(withGithubCredentialHelper<Env>({ HOME: '/h' }, helperPath))).toEqual({ HOME: '/h' })
    expect(withoutGithubCredentialHelper(user)).toBe(user)
    // A helper that is not ours (another wrapper) is the user's.
    const foreign = { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: GITHUB_HELPER_KEY, GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: GITHUB_HELPER_KEY, GIT_CONFIG_VALUE_1: "!'/x/gh' auth git-credential", GIT_CONFIG_KEY_2: GITHUB_USE_HTTP_PATH_KEY, GIT_CONFIG_VALUE_2: 'true' }
    expect(withoutGithubCredentialHelper<Env>(foreign)).toBe(foreign)
  })

  it('githubCredentialHelperFor: the entries only with the endpoint and a wrapper, stable when applied again', () => {
    const endpoint = { CINNA_GITHUB_URL: 'http://127.0.0.1:1/github', CINNA_GITHUB_AUTH: 'b' }
    const kit = githubCredentialHelperFor<Env>({ ...endpoint, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat' }, fx.wrapper)
    expect(kit.GIT_CONFIG_COUNT).toBe('4')
    expect(kit.GIT_CONFIG_VALUE_2).toContain('/gh-shim/gh')
    expect(githubCredentialHelperFor(kit, fx.wrapper)).toEqual(kit)
    // The endpoint gone (or no wrapper): ours are stripped, the user's stay.
    const { CINNA_GITHUB_URL: _u, CINNA_GITHUB_AUTH: _a, ...bare } = kit
    expect(githubCredentialHelperFor(bare, fx.wrapper)).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat' })
    expect(githubCredentialHelperFor(kit, null).GIT_CONFIG_COUNT).toBe('1')
  })

  it('starts at 0 over a missing or malformed count', () => {
    expect(withGithubCredentialHelper<Env>({ GIT_CONFIG_COUNT: 'x' }, '/w/gh').GIT_CONFIG_KEY_0).toBe(GITHUB_HELPER_KEY)
    expect(withGithubCredentialHelper<Env>({}, "/it's/gh").GIT_CONFIG_VALUE_1).toBe(`!'/it'\\''s/gh' auth git-credential`)
  })
})

describe.skipIf(!hasCurl)('the gh wrapper', () => {
  it('a token: the real gh with GH_TOKEN and the empty gh-config, the user GitHub vars gone', async () => {
    const loop = await startLoopback(tokenAnswer)
    const out = await run(['pr', 'list', '-R', 'o/r'], { endpoint: loop.url })
    expect(out.status).toBe(0)
    expect(out.stdout).toBe(
      `argv:pr list -R o/r\nGH_TOKEN=served\nGH_CONFIG_DIR=${fx.configDir}\nGH_PROMPT_DISABLED=1\nGITHUB_TOKEN=unset\nGH_HOST=unset\n`
    )
    expect(out.stderr).toBe('')
    expect(loop.requests).toEqual([{ path: '/github/token', auth: `Bearer ${BEARER}`, body: { repo: 'o/r' } }])
    // Neither the bearer nor the token is ever on a command line.
    const argv = curlArgv()
    expect(argv).toContain('--config -')
    expect(argv).not.toContain(BEARER)
    expect(argv).not.toContain(TOKEN)
    expect(out.stdout).not.toContain(TOKEN)
    const dump = readFileSync(fx.envDump, 'utf8').split('\n')
    expect(dump.filter((line) => line.includes(TOKEN))).toEqual([`GH_TOKEN=${TOKEN}`])
    expect(dump.filter((line) => line.includes(BEARER))).toEqual([`CINNA_GITHUB_AUTH=${BEARER}`])
  })

  it('needed, and the user own gh login answers: the real gh untouched', async () => {
    const loop = await startLoopback(() => neededAnswer('sign_in'))
    const out = await run(['pr', 'list', '--repo', 'o/r'], { endpoint: loop.url, ownLogin: true })
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('argv:pr list --repo o/r\nGH_TOKEN=unset\nGH_CONFIG_DIR=unset\nGH_PROMPT_DISABLED=unset\nGITHUB_TOKEN=shell-token\n')
    expect(loop.requests.map((r) => r.path)).toEqual(['/github/token'])
  })

  it('needed and no own login: the sentence, exit 4, and the need posted with its repo', async () => {
    const loop = await startLoopback((_path, body) => neededAnswer('install', body.repo as string))
    const out = await run(['pr', 'create', '-R', 'acme/shop'], { endpoint: loop.url })
    expect(out.status).toBe(4)
    expect(out.stdout).toBe('')
    expect(out.stderr).toBe(`${GITHUB_MESSAGES.install('acme/shop')}\n`)
    expect(loop.requests.map((r) => [r.path, r.body])).toEqual([
      ['/github/token', { repo: 'acme/shop' }],
      ['/github/needed', { kind: 'install', repo: 'acme/shop' }]
    ])
    expect(loop.requests.every((r) => r.auth === `Bearer ${BEARER}`)).toBe(true)
  })

  it('needed (sign in) with no repo and no gh at all: the sentence and exit 4, not a missing gh', async () => {
    const loop = await startLoopback(() => neededAnswer('sign_in'))
    const out = await run(['auth', 'status'], { endpoint: loop.url, realGh: false })
    expect([out.status, out.stderr]).toEqual([4, `${GITHUB_MESSAGES.sign_in}\n`])
    expect(loop.requests.map((r) => [r.path, r.body])).toEqual([
      ['/github/token', {}],
      ['/github/needed', { kind: 'sign_in' }]
    ])
  })

  it('an endpoint that cannot be reached: the sandbox sentence and exit 4', async () => {
    const out = await run(['repo', 'clone', 'o/r'], { endpoint: await closedPort() })
    expect(out.status).toBe(4)
    expect(out.stdout).toBe('')
    expect(out.stderr).toBe(`${GH_NETWORK_MESSAGE}\n`)
    expect(GH_NETWORK_MESSAGE).toBe(
      'This GitHub command needs network access, which this sandbox blocks. Run the same command again with escalated permissions. It is not an internet outage.'
    )
  })

  it('a 401 (nothing holds the agent): the real gh untouched', async () => {
    const loop = await startLoopback(() => ({ status: 401, body: { detail: 'no' } }))
    const out = await run(['pr', 'view'], { endpoint: loop.url })
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('argv:pr view\nGH_TOKEN=unset\nGH_CONFIG_DIR=unset\n')
  })

  it('a token but no gh yet, the managed install running: still installing, exit 1, gh_missing posted', async () => {
    const loop = await startLoopback(tokenAnswer, { ok: true, installing: true })
    const out = await run(['pr', 'list'], { endpoint: loop.url, realGh: false })
    expect([out.status, out.stdout, out.stderr]).toEqual([1, '', 'Cinna is still installing gh, try again in a moment.\n'])
    expect(GH_INSTALLING_MESSAGE).toBe('Cinna is still installing gh, try again in a moment.')
    expect(loop.requests.map((r) => [r.path, r.body])).toEqual([
      ['/github/token', {}],
      ['/github/needed', { kind: 'gh_missing' }]
    ])
  })

  it.each([[{ ok: true, installing: false }], [{ ok: true }]])('a token, no gh and no install running (%j): the install-it-yourself sentence, exit 1', async (needed) => {
    const loop = await startLoopback(tokenAnswer, needed)
    const out = await run(['pr', 'list'], { endpoint: loop.url, realGh: false })
    expect([out.status, out.stdout, out.stderr]).toEqual([1, '', `${GH_NOT_INSTALLED_MESSAGE}\n`])
    expect(GH_NOT_INSTALLED_MESSAGE).toBe(
      "gh isn't installed and Cinna couldn't install it. Ask the user to install the GitHub CLI from https://cli.github.com, then run this command again."
    )
    expect(loop.requests.map((r) => r.path)).toEqual(['/github/token', '/github/needed'])
  })

  it('an endpoint that took the connection but does not answer in time: try again, exit 1, not the sandbox sentence', async () => {
    const loop = await startLoopback(() => null)
    const out = await run(['pr', 'list', '-R', 'o/r'], { endpoint: loop.url, extraEnv: { FAKE_CURL_MAX_TIME: '1' } })
    expect([out.status, out.stdout, out.stderr]).toEqual([1, '', `${GH_SLOW_MESSAGE}\n`])
    expect(GH_SLOW_MESSAGE).toBe('Cinna is taking too long to answer for GitHub. Try again in a moment.')
    // The wrapper's own wait for /token is 40 s (the test's curl caps it at 1).
    expect(curlArgv()).toContain('--max-time 40 ')
    // git's side too.
    const git = await run(['auth', 'git-credential', 'get'], { endpoint: loop.url, input: 'protocol=https\nhost=github.com\n\n', extraEnv: { FAKE_CURL_MAX_TIME: '1' } })
    expect([git.status, git.stdout, git.stderr]).toEqual([1, '', `${GH_SLOW_MESSAGE}\n`])
  })

  it('a token and the managed gh landed: the managed gh runs', async () => {
    const managed = join(fx.userData, 'runtimes', 'gh-2.105.0', 'bin')
    mkdirSync(managed, { recursive: true })
    writeFileSync(join(managed, 'gh'), FAKE_GH.replace('echo "argv:$*"', 'echo "managed argv:$*"'), { mode: 0o755 })
    const loop = await startLoopback(tokenAnswer)
    const out = await run(['pr', 'list'], { endpoint: loop.url, realGh: false })
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('managed argv:pr list\nGH_TOKEN=served\n')
  })

  it('unavailable and no own login: its message, exit 1', async () => {
    const loop = await startLoopback(() => ({ status: 200, body: { unavailable: true, message: GITHUB_MESSAGES.unavailable } }))
    const out = await run(['pr', 'list'], { endpoint: loop.url })
    expect([out.status, out.stdout, out.stderr]).toEqual([1, '', `${GITHUB_MESSAGES.unavailable}\n`])
    expect(loop.requests).toHaveLength(1)
  })

  it('no endpoint: the real gh untouched, and curl is never run', async () => {
    const out = await run(['pr', 'list'], {})
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('argv:pr list\nGH_TOKEN=unset\n')
    expect(curlArgv()).toBe('')
  })

  it('no endpoint and no gh: command not found, 127', async () => {
    const out = await run(['pr', 'list'], { realGh: false })
    expect([out.status, out.stderr]).toEqual([127, 'gh: command not found\n'])
  })

  it('never runs a gh from Cinna own directories', async () => {
    const toolShims = join(fx.userData, 'tool-shims')
    mkdirSync(toolShims, { recursive: true })
    writeFileSync(join(toolShims, 'gh'), '#!/bin/sh\necho own\n', { mode: 0o755 })
    const env = baseEnv({ realGh: false })
    const out = await run(['x'], {}, { ...env, PATH: `${toolShims}:${env.PATH}` })
    expect(out.status).toBe(127)
  })
})

describe.skipIf(!hasCurl)('which repo the wrapper asks for', () => {
  const cases: Array<[string[], Record<string, string>]> = [
    [['pr', 'list', '-R', 'o/r'], { repo: 'o/r' }],
    [['pr', 'list', '-Ro/r'], { repo: 'o/r' }],
    [['pr', 'list', '--repo=o/r.git'], { repo: 'o/r' }],
    [['issue', 'view', '3', '--repo', 'https://github.com/o/r'], { repo: 'o/r' }],
    [['repo', 'view', 'https://github.com/acme/shop.git'], { repo: 'acme/shop' }],
    [['repo', 'fork', 'git@github.com:acme/shop.git'], { repo: 'acme/shop' }],
    [['repo', 'sync', 'acme/my.repo_1'], { repo: 'acme/my.repo_1' }],
    [['repo', 'view', '-b', 'main', 'acme/shop'], { repo: 'acme/shop' }],
    [['api', 'repos/acme/shop/pulls'], { repo: 'acme/shop' }],
    [['api', '-X', 'GET', '/repos/acme/shop?per_page=1'], { repo: 'acme/shop' }],
    [['api', 'user'], {}],
    [['repo', 'view', 'https://gitlab.com/acme/shop'], {}],
    [['repo', 'view', 'acme/shop/extra'], {}],
    [['pr', 'list', '-R', 'bad owner/x'], {}],
    [['pr', 'list', '--', '-R', 'o/r'], {}]
  ]
  it.each(cases)('%j → %j', async (args, body) => {
    const loop = await startLoopback(tokenAnswer)
    await run(args, { endpoint: loop.url })
    expect(loop.requests[0]?.body).toEqual(body)
  })

  it.skipIf(!hasGit)('falls back to the origin remote of the current folder, when it is on github.com', async () => {
    const repo = join(fx.root, 'work')
    spawnSync(toolPaths.git!, ['init', '-q', repo])
    spawnSync(toolPaths.git!, ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/shop.git'])
    const loop = await startLoopback(tokenAnswer)
    await run(['pr', 'list'], { endpoint: loop.url, cwd: repo })
    expect(loop.requests[0]?.body).toEqual({ repo: 'acme/shop' })
    spawnSync(toolPaths.git!, ['-C', repo, 'remote', 'set-url', 'origin', 'https://example.com/acme/shop.git'])
    await run(['pr', 'list'], { endpoint: loop.url, cwd: repo })
    expect(loop.requests[1]?.body).toEqual({})
  })
})

describe.skipIf(!hasCurl || !hasGit)('commit identity after a token-served clone (G7)', () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync(toolPaths.git!, ['-C', cwd, ...args], { encoding: 'utf8', env: { HOME: fx.home, GIT_CONFIG_GLOBAL: join(fx.home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } }).stdout.trim()

  it('sets the noreply identity in the new clone when git has none', async () => {
    const loop = await startLoopback(tokenAnswer)
    const out = await run(['repo', 'clone', 'acme/shop'], { endpoint: loop.url })
    expect(out.status).toBe(0)
    const clone = join(fx.root, 'shop')
    expect([git(clone, 'config', '--local', 'user.name'), git(clone, 'config', '--local', 'user.email')]).toEqual([
      'Alice Doe',
      '1+alice@users.noreply.github.com'
    ])
  })

  it('uses the explicit directory argument', async () => {
    const loop = await startLoopback(tokenAnswer)
    const out = await run(['repo', 'clone', 'https://github.com/acme/shop.git', 'app-data/repos/acme__shop'], { endpoint: loop.url })
    expect(out.status).toBe(0)
    expect(git(join(fx.root, 'app-data', 'repos', 'acme__shop'), 'config', '--local', 'user.email')).toBe('1+alice@users.noreply.github.com')
  })

  it('leaves a user global identity alone', async () => {
    writeFileSync(join(fx.home, '.gitconfig'), '[user]\n\tname = Real\n\temail = real@example.com\n')
    const loop = await startLoopback(tokenAnswer)
    await run(['repo', 'clone', 'acme/shop'], { endpoint: loop.url })
    expect(git(join(fx.root, 'shop'), 'config', '--local', 'user.email')).toBe('')
  })

  it('passes a failed clone exit status through, setting nothing', async () => {
    const loop = await startLoopback(tokenAnswer)
    const out = await run(['repo', 'clone', 'acme/shop'], { endpoint: loop.url, extraEnv: { FAKE_GH_CLONE_EXIT: '3' } })
    expect(out.status).toBe(3)
    expect(git(join(fx.root, 'shop'), 'config', '--local', 'user.email')).toBe('')
  })
})

describe.skipIf(!hasCurl)('gh auth git-credential (git, G4)', () => {
  const request = 'protocol=https\nhost=github.com\npath=acme/shop.git\n\n'

  it('get with a token: the four-line answer, for the repo in path', async () => {
    const loop = await startLoopback(tokenAnswer)
    const out = await run(['auth', 'git-credential', 'get'], { endpoint: loop.url, input: request })
    expect(out.status).toBe(0)
    expect(out.stdout).toBe(`protocol=https\nhost=github.com\nusername=x-access-token\npassword=${TOKEN}\n`)
    expect(loop.requests.map((r) => r.body)).toEqual([{ repo: 'acme/shop' }])
    expect(curlArgv()).not.toContain(BEARER)
  })

  it('another host: passed through to the real gh with the request replayed', async () => {
    const loop = await startLoopback(tokenAnswer)
    const out = await run(['auth', 'git-credential', 'get'], { endpoint: loop.url, input: 'protocol=https\nhost=gitlab.com\n\n' })
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('argv:auth git-credential get\n')
    expect(out.stdout).toContain('fake-credential get\nprotocol=https\nhost=gitlab.com\n\n')
    expect(loop.requests).toEqual([])
  })

  it('another host and no real gh: an empty answer', async () => {
    const out = await run(['auth', 'git-credential', 'get'], { realGh: false, input: 'protocol=http\nhost=github.com\n\n' })
    expect([out.status, out.stdout]).toEqual([0, ''])
  })

  it('store and erase with an endpoint: ignored', async () => {
    const loop = await startLoopback(tokenAnswer)
    for (const op of ['store', 'erase']) {
      const out = await run(['auth', 'git-credential', op], { endpoint: loop.url, input: `${request.trimEnd()}\nusername=x-access-token\npassword=p\n\n` })
      expect([out.status, out.stdout]).toEqual([0, ''])
    }
    expect(loop.requests).toEqual([])
    expect(existsSync(fx.envDump)).toBe(false)
  })

  it('no endpoint: the user own gh answers', async () => {
    const out = await run(['auth', 'git-credential', 'get'], { input: request })
    expect(out.stdout).toContain('fake-credential get\nprotocol=https\nhost=github.com\npath=acme/shop.git\n')
  })

  it('unreachable: the sandbox sentence, exit 4', async () => {
    const out = await run(['auth', 'git-credential', 'get'], { endpoint: await closedPort(), input: request })
    expect([out.status, out.stdout, out.stderr]).toEqual([4, '', `${GH_NETWORK_MESSAGE}\n`])
  })

  it('needed, own login: the user own gh answers', async () => {
    const loop = await startLoopback(() => neededAnswer('sign_in'))
    const out = await run(['auth', 'git-credential', 'get'], { endpoint: loop.url, input: request, ownLogin: true })
    expect(out.stdout).toContain('fake-credential get\n')
    expect(loop.requests.map((r) => r.path)).toEqual(['/github/token'])
  })

  it('needed, no own login: an empty answer, the message, the need posted', async () => {
    const loop = await startLoopback((_p, body) => neededAnswer('install', body.repo as string))
    const out = await run(['auth', 'git-credential', 'get'], { endpoint: loop.url, input: request })
    expect([out.status, out.stdout, out.stderr]).toEqual([0, '', `${GITHUB_MESSAGES.install('acme/shop')}\n`])
    expect(loop.requests.map((r) => [r.path, r.body])).toEqual([
      ['/github/token', { repo: 'acme/shop' }],
      ['/github/needed', { kind: 'install', repo: 'acme/shop' }]
    ])
  })
})

describe.skipIf(!hasCurl || !hasGit)('git credential fill through the envs Cinna builds', () => {
  /** The user's own login through git's `store` helper (a keychain / GCM login has the same shape). */
  async function fillStored(env: Env) {
    writeFileSync(join(fx.home, '.gitconfig'), '[credential]\n\thelper = store\n')
    writeFileSync(join(fx.home, '.git-credentials'), 'https://u:stored-pw@github.com\n', { mode: 0o600 })
    return new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn(toolPaths.git!, ['credential', 'fill'], { env: env as NodeJS.ProcessEnv, cwd: fx.root })
      let stdout = ''
      child.stdout.on('data', (chunk) => (stdout += chunk))
      child.on('close', (status) => resolve({ status, stdout }))
      child.stdin.end('protocol=https\nhost=github.com\npath=acme/shop.git\n\n')
    })
  }

  it('a child with no endpoint (bare agent, MCP server, Run Script, /run:): the user store login fills', async () => {
    const env = await shimFor(fx.userData).apply<Env>(baseEnv({}))
    expect(Object.keys(env).filter((key) => key.startsWith('GIT_CONFIG_') && key !== 'GIT_CONFIG_GLOBAL' && key !== 'GIT_CONFIG_NOSYSTEM')).toEqual([])
    const out = await fillStored(env)
    expect(out.status).toBe(0)
    expect(out.stdout).toContain('password=stored-pw\n')
  })

  it('an env that had our entries and lost its endpoint: they go, and the user store login fills', async () => {
    const loop = await startLoopback(tokenAnswer)
    const kit = githubCredentialHelperFor<Env>(await shimFor(fx.userData).apply<Env>(baseEnv({ endpoint: loop.url })), fx.wrapper)
    const { CINNA_GITHUB_URL: _u, CINNA_GITHUB_AUTH: _a, ...rest } = kit
    const out = await fillStored(githubCredentialHelperFor(rest, fx.wrapper))
    expect(out.stdout).toContain('password=stored-pw\n')
    expect(loop.requests).toEqual([])
  })

  async function fill(options: { wired: boolean }) {
    const userHelperLog = join(fx.root, 'user-helper.log')
    // The user's own helpers, generic and github.com-scoped (the `gh auth setup-git` shape).
    writeFileSync(
      join(fx.home, '.gitconfig'),
      `[credential]\n\thelper = "!f() { echo generic >> '${userHelperLog}'; echo username=u; echo password=user-pw; }; f"\n` +
        `[credential "https://github.com"]\n\thelper = "!f() { echo github >> '${userHelperLog}'; echo username=u; echo password=user-pw; }; f"\n`
    )
    const loop = await startLoopback(tokenAnswer)
    const base = baseEnv({ endpoint: loop.url })
    // A kit agent's child: the shims, then engineCredentialEnv's entries with the endpoint.
    const env = options.wired ? githubCredentialHelperFor(await shimFor(fx.userData).apply(base), fx.wrapper) : base
    // Not spawnSync: the fake loopback answers on this event loop.
    const out = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn(toolPaths.git!, ['credential', 'fill'], { env: env as NodeJS.ProcessEnv, cwd: fx.root })
      let stdout = ''
      child.stdout.on('data', (chunk) => (stdout += chunk))
      child.on('close', (status) => resolve({ status, stdout }))
      child.stdin.end('protocol=https\nhost=github.com\npath=acme/shop.git\n\n')
    })
    return { out, loop, userHelper: existsSync(userHelperLog) ? readFileSync(userHelperLog, 'utf8') : '' }
  }

  it('a kit agent child: our token comes back and the user helpers never run', async () => {
    const { out, loop, userHelper } = await fill({ wired: true })
    expect(out.status).toBe(0)
    expect(out.stdout).toContain(`password=${TOKEN}\n`)
    expect(out.stdout).toContain('username=x-access-token\n')
    expect(userHelper).toBe('')
    expect(loop.requests.map((r) => r.body)).toEqual([{ repo: 'acme/shop' }])
  })

  it('control: without the wiring the user helper answers', async () => {
    const { out, userHelper } = await fill({ wired: false })
    expect(out.stdout).toContain('password=user-pw\n')
    expect(userHelper).not.toBe('')
  })
})
