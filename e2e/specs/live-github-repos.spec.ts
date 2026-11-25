import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { repoRoot } from '../playwright.config'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { ANTHROPIC_API_KEY, CLAUDE_API_AUTH, pinClaudeApiProfile } from '../fixtures/claudeApiAuth'
import { claudeBinary } from '../fixtures/liveEngine'
import { LIVE_REQUESTED } from '../fixtures/live'
import type { GithubCoverage, GithubStatusDto } from '../../src/shared/github'

/**
 * GitHub repos P1 against **real GitHub**: opt-in, never part of an ordinary run.
 *
 *     CINNA_E2E_GITHUB_REPO=<owner>/<repo> make e2e-one SPEC=e2e/specs/live-github-repos.spec.ts
 *
 * Skipped unless `CINNA_E2E_GITHUB_REPO` names a repository the OpenCinna
 * GitHub app is installed on (for the account you will approve with), and
 * unless a real `gh` is on this machine's `PATH` (the suite never downloads the
 * managed gh). No model runs: the agent's `gh` is called by a kit command.
 *
 * **A human approves the sign-in.** GitHub's device flow cannot be approved
 * from a test, so the run prints the code and `https://github.com/login/device`
 * and waits up to five minutes for you to enter it there. The app's own
 * `shell.openExternal` is recorded (`openExternalRecorder.cjs`), not followed:
 * no browser opens by itself. The sign-in lives only in the throwaway profile
 * and is gone with the sandbox; revoke it at github.com/settings/applications
 * if you want GitHub to forget it too.
 *
 * What it proves beyond `github-repos.spec.ts`: the real device-code and token
 * endpoints, the real `/user` and `/user/installations` answers parsed into
 * coverage, and the real `gh` accepting the OpenCinna user-to-server token for
 * `gh repo view` (no user gh login in the sandbox `HOME`, and `GH_TOKEN` /
 * `GITHUB_TOKEN` cleared for the app).
 *
 * ## The second test: the whole P1 flow on a real Claude (haiku) turn
 *
 * Billed (the subscription's usage, haiku, at most six turns) and also
 * human-approved. Run it alone with `GREP`:
 *
 *     CINNA_E2E_CLAUDE_OAUTH_TOKEN="$(sed -n 's/^ANTHROPIC_OAUTH_TOKEN=//p' ../cinna-orchestrator/.env)" \
 *     CINNA_E2E_GITHUB_REPO=<owner>/<repo> CINNA_E2E_GITHUB_OPEN_BROWSER=1 \
 *     make e2e-one SPEC=e2e/specs/live-github-repos.spec.ts GREP="real Claude"
 *
 * (`set -a; . ../cinna-orchestrator/.env; set +a` before the `make` works too:
 * the spec reads `CINNA_E2E_CLAUDE_OAUTH_TOKEN`, then `CLAUDE_CODE_OAUTH_TOKEN`,
 * then `ANTHROPIC_OAUTH_TOKEN` from the test process's environment. This
 * repo's `.env` is loaded too and never overrides the shell, so an
 * `ANTHROPIC_OAUTH_TOKEN` there is the fallback: with one, setting
 * `CINNA_E2E_GITHUB_REPO` alone already makes this test run, and bill.) The token is
 * what `claude setup-token` prints (`sk-ant-oat…`). It never reaches the
 * app's own environment: Cinna narrows a `claude` child's environment to an
 * allowlist, so an exported `CLAUDE_CODE_OAUTH_TOKEN` would never get there
 * anyway. Instead the spec saves a two-line wrapper as the Claude Path, in the
 * sandbox, that reads the token from a 0600 file beside it and execs the real
 * `claude` (`claudeBinary()`: `CINNA_E2E_CLAUDE_PATH`, else
 * `~/.local/bin/claude`) with `CLAUDE_CODE_OAUTH_TOKEN` and
 * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (so the agent's own Bash never
 * inherits it). The sandbox `HOME` stays: no `~/.claude/settings.json` model
 * override, nothing under the real `HOME`. The file is deleted at the end,
 * pass or fail. `CINNA_E2E_CLAUDE_AUTH=api_key` (with `ANTHROPIC_API_KEY`)
 * runs it in API Token mode instead (`claudeApiAuth.ts`). Without
 * either, or without `CINNA_E2E_LIVE=1` (which `make e2e-one` sets for a
 * `live` spec), it skips.
 *
 * Steps, each printed as `>>> step N: …`:
 * 1. A kit agent on Claude Agent, model `haiku`, approval Ask every time (the
 *    test answers every ask with Allow once; haiku has no auto reviewer).
 * 2. The user asks it to add `Hello from Cinna e2e <run id>` to the README of
 *    `https://github.com/<repo>` and propose a pull request on branch
 *    `cinna-e2e-<run id>`. Its `gh` is refused (no sign-in): the reply relays
 *    "Sign in to GitHub" and the composer shows the Sign in to GitHub row.
 * 3. Sign in from the row: `GITHUB DEVICE CODE: <code>` and the URL go to
 *    stdout and to `e2e/test-results/github-device-code.txt`; with
 *    `CINNA_E2E_GITHUB_OPEN_BROWSER=1` the test process opens the URL in the
 *    default browser (the app's own `openExternal` is only recorded). Waits
 *    up to ten minutes for a human to approve.
 * 4. Continue (then at most two "please continue" nudges if no pull request
 *    is open yet). Asserts: the clone is `<agent>/app-data/repos/<owner>__<repo>`
 *    with that origin (its local `user.email` is only printed: G7 sets it
 *    after a served `gh repo clone`, a plain `git clone` has none); and, read from real GitHub by
 *    a kit command through Cinna's `gh` wrapper on the OpenCinna token (the
 *    loopback only answers while something holds the agent, so the test
 *    process cannot ask it directly): an open pull request for the run, its
 *    head branch on the remote, the line in its diff, and the author and
 *    committer of every commit the one noreply `<id>+<login>@users.noreply.github.com`
 *    (the sandbox has no global git identity; offenders are printed).
 * 5. `finally`: a cleanup kit command closes the open pull requests whose
 *    head is exactly `cinna-e2e-<run id>` (`--delete-branch`) and deletes
 *    exactly `heads/cinna-e2e-<run id>` if it is still there; each tolerant of
 *    being absent, each gh exit status checked before its output is used. If
 *    the app cannot run it, the manual commands are printed.
 *
 * The repository needs a README on its default branch (an empty one cannot
 * take a pull request): the test skips otherwise. A public repository is
 * checked before any turn; a private one right after the sign-in, before
 * Continue (turn 1 has run by then).
 */

const REPO = (process.env.CINNA_E2E_GITHUB_REPO ?? '').trim()
const AGENT = 'GitHub Live Agent'
const APPROVE_TIMEOUT_MS = 5 * 60_000

function realGh(): string | null {
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v gh'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

// A user's own token in the developer's environment would count as their gh login.
const NO_GH_TOKENS = { GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '' }
test.use({
  env: NO_GH_TOKENS,
  mainRequire: [join(repoRoot, 'e2e', 'fixtures', 'openExternalRecorder.cjs')]
})

test.beforeEach(() => {
  test.skip(!REPO, 'Set CINNA_E2E_GITHUB_REPO=<owner>/<repo> (a repository the OpenCinna app is installed on) to run this live spec.')
  test.skip(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(REPO), `CINNA_E2E_GITHUB_REPO must be owner/repo, not ${JSON.stringify(REPO)}.`)
  test.skip(realGh() === null, 'No gh on PATH: install the GitHub CLI to run this live spec.')
})

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

/**
 * The status once the installations have been read: "GitHub is connected." shows as soon as the
 * sign-in is stored, and the first installations read runs after it. Fails after a minute, or when
 * the app is not installed on the repository's owner (naming the owners it found and the login).
 */
async function connectedCoverage(cinna: CinnaApp): Promise<{ login: string; install: GithubCoverage }> {
  const owner = REPO.split('/')[0].toLowerCase()
  let account: GithubStatusDto['account'] = null
  await expect.poll(async () => {
    const status = await cinna.page.evaluate(() => window.api.github.status())
    if (!status.ok) throw new Error(status.error)
    account = status.value.account
    return account?.coverageFetchedAt ?? null
  }, { message: 'the installations are read after the sign-in (main.log: "GitHub installations could not be read"?)', timeout: 60_000, intervals: [500, 1_000] }).not.toBeNull()
  const read = account as GithubStatusDto['account']
  const owners = read?.coverage.map((i) => `${i.owner} (${i.selection})`).join(', ') || 'none'
  const install = read?.coverage.find((i) => i.owner.toLowerCase() === owner)
  console.log(`    signed in as ${read?.login ?? '?'}; OpenCinna installed on: ${owners}`)
  expect(install, `the OpenCinna app is not installed on ${owner} (signed in as ${read?.login ?? '?'}; installed on: ${owners}): install it there and run again`).toBeTruthy()
  return { login: read!.login, install: install! }
}

test('real GitHub: sign in from the composer, then the agent’s gh views the repository on the OpenCinna token', async ({ cinna }) => {
  test.setTimeout(APPROVE_TIMEOUT_MS + 3 * 60_000)
  const gh = realGh()!

  await test.step('arrange: a kit agent whose /run:gh-check views the repository', async () => {
    await cinna.skipOnboarding()
    const root = await addAgentRoot(cinna)
    const agent = await createFolderAgent(cinna, root, AGENT, AGENT)
    writeFileSync(join(agent.path, 'scripts', 'gh-check.sh'),
      `#!/bin/sh\ngh repo view '${REPO}' --json nameWithOwner --jq .nameWithOwner 2>&1\necho "gh exit: $?"\n`)
    appendFileSync(join(agent.path, 'docs', 'CLI_COMMANDS.yaml'),
      `\n  - name: gh-check\n    description: View ${REPO} with gh\n    command: /bin/sh scripts/gh-check.sh\n`)
    // The real gh's directory first, so the run does not depend on how the developer's PATH orders it.
    for (const rc of ['.zprofile', '.zshrc', '.bash_profile', '.profile']) {
      appendFileSync(join(cinna.sandbox.home, rc), `export PATH=${JSON.stringify(dirname(gh))}:"$PATH"\n`)
    }
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
  })

  const panel = cinna.page.getByRole('status', { name: 'Agent status' })
  const output = (n: number) => cinna.page.locator('pre code').nth(n)

  await test.step('gh is refused with exit 4 until GitHub is connected', async () => {
    await runFromCommands(cinna)
    await expect(output(0)).toHaveText(
      "GitHub isn't connected. Ask the user to click Sign in to GitHub under the message box, then run this command again.\ngh exit: 4",
      { timeout: 60_000 }
    )
    await expect(panel.getByRole('button', { name: 'Sign in to GitHub' })).toBeVisible()
  })

  await test.step('Sign in to GitHub: a human enters the code at github.com/login/device', async () => {
    await panel.getByRole('button', { name: 'Sign in to GitHub' }).click()
    const code = panel.locator('strong')
    await expect(code).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/, { timeout: 30_000 })
    console.log(`\n>>> Enter ${await code.innerText()} at https://github.com/login/device within 5 minutes <<<\n`)
    const opened = await cinna.electronApp.evaluate(() => (globalThis as { __cinnaOpenedUrls?: string[] }).__cinnaOpenedUrls ?? null)
    expect(opened).toEqual(['https://github.com/login/device'])
    await expect(cinna.page.getByRole('status', { name: 'GitHub' }).getByText('GitHub is connected.', { exact: true }))
      .toBeVisible({ timeout: APPROVE_TIMEOUT_MS })
  })

  await test.step(`the coverage names ${REPO}`, async () => {
    const { install } = await connectedCoverage(cinna)
    if (install.selection === 'selected') expect(install.repos.map((r) => r.toLowerCase())).toContain(REPO.toLowerCase())
  })

  await test.step('the same command now prints the repository and exits 0', async () => {
    const input = cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
    await input.fill('/run:gh-check')
    await cinna.page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(output(1)).toHaveText(new RegExp(`^${REPO.replace(/[.]/g, '\\.')}\\ngh exit: 0$`, 'i'), { timeout: 60_000 })
  })

  await test.step('Settings → User Accounts → GitHub: Sign out forgets it on this computer', async () => {
    const me = await cinna.page.evaluate(() => window.api.auth.getCurrent())
    await cinna.page.getByTitle(me!.cinnaFullName ?? me!.displayName, { exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'User Accounts', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'Sign out', exact: true }).click()
    const dialog = cinna.page.getByRole('dialog', { name: 'Sign out of GitHub' })
    await dialog.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(cinna.page.getByRole('button', { name: 'Sign in to GitHub' })).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// The second test: the user's flow on a real Claude (haiku) turn.
// ---------------------------------------------------------------------------

/** `claude setup-token`'s token, from the first of these the test process has; never printed. */
const CLAUDE_OAUTH_TOKEN = [process.env.CINNA_E2E_CLAUDE_OAUTH_TOKEN, process.env.CLAUDE_CODE_OAUTH_TOKEN, process.env.ANTHROPIC_OAUTH_TOKEN]
  .map((value) => (value ?? '').trim().replace(/^(['"])(.*)\1$/, '$2'))
  .find((value) => value !== '') ?? ''
const PR_AGENT = 'GitHub PR Agent'
const APPROVE_HUMAN_MS = 10 * 60_000
const TURN_TIMEOUT_MS = 6 * 60_000
/** The initial message, Continue, and at most this many "please continue": never more than 6 turns. */
const MAX_NUDGES = 2
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
const BRANCH = `cinna-e2e-${RUN_ID}`
const README_LINE = `Hello from Cinna e2e ${RUN_ID}`
const ASK = `I want to work on https://github.com/${REPO}. Add a line '${README_LINE}' to the README and propose it as a pull request. Use the branch name ${BRANCH}.`
const DEVICE_CODE_FILE = join(repoRoot, 'e2e', 'test-results', 'github-device-code.txt')

/** How this run's Claude authenticates, or why it cannot. */
function claudeAuth(): { kind: 'oauth' | 'api_key'; binary: string } | { skip: string } {
  const binary = claudeBinary()
  if (binary === null) return { skip: 'No Claude Code binary: set CINNA_E2E_CLAUDE_PATH, or install ~/.local/bin/claude.' }
  if (CLAUDE_API_AUTH) {
    return ANTHROPIC_API_KEY === '' ? { skip: 'CINNA_E2E_CLAUDE_AUTH=api_key: ANTHROPIC_API_KEY is not set.' } : { kind: 'api_key', binary }
  }
  if (CLAUDE_OAUTH_TOKEN === '') {
    return { skip: 'No Claude login for the sandbox: set CINNA_E2E_CLAUDE_OAUTH_TOKEN (or ANTHROPIC_OAUTH_TOKEN, e.g. from ../cinna-orchestrator/.env) to a `claude setup-token` token, or CINNA_E2E_CLAUDE_AUTH=api_key with ANTHROPIC_API_KEY.' }
  }
  if (!CLAUDE_OAUTH_TOKEN.startsWith('sk-ant-oat')) {
    return { skip: 'The Claude OAuth token does not start with sk-ant-oat: it is not a `claude setup-token` token (an API key goes in with CINNA_E2E_CLAUDE_AUTH=api_key).' }
  }
  return { kind: 'oauth', binary }
}

/**
 * The Claude Path for the OAuth run: reads the token from a 0600 file at
 * exec time (never on a command line, never in Cinna's env) and execs the
 * real `claude`. Answers the wrapper and the token file to delete afterwards.
 */
function writeClaudeOauthWrapper(cinna: CinnaApp, binary: string): { wrapper: string; tokenFile: string } {
  const dir = join(cinna.sandbox.root, 'claude-oauth')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tokenFile = join(dir, 'token')
  writeFileSync(tokenFile, CLAUDE_OAUTH_TOKEN, { mode: 0o600 })
  const wrapper = join(dir, 'claude')
  writeFileSync(wrapper, [
    '#!/bin/sh',
    `[ -r ${JSON.stringify(tokenFile)} ] || { echo "the e2e Claude token file is gone" >&2; exit 1; }`,
    `CLAUDE_CODE_OAUTH_TOKEN=$(cat ${JSON.stringify(tokenFile)})`,
    'export CLAUDE_CODE_OAUTH_TOKEN',
    // The agent's own Bash and MCP servers never inherit the token.
    'export CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1',
    `exec ${JSON.stringify(binary)} "$@"`,
    ''
  ].join('\n'))
  chmodSync(wrapper, 0o755)
  return { wrapper, tokenFile }
}

/** The jq filter for this run's open pull requests: its id in the head branch, title or body. */
const RUN_PRS = `.[] | select((.headRefName + " " + .title + " " + .body) | contains("${RUN_ID}"))`

/** Reads real GitHub through Cinna's gh wrapper (a kit command carries the loopback endpoint). */
const VERIFY_SCRIPT = [
  '#!/bin/sh',
  `R='${REPO}'`,
  `echo "cinna-e2e verify ${RUN_ID}"`,
  `gh pr list --repo "$R" --state open --limit 100 --json number,headRefName,title,body --jq '${RUN_PRS} | "PR \\(.number) \\(.headRefName)"' 2>&1`,
  'echo "pr list exit: $?"',
  `for n in $(gh pr list --repo "$R" --state open --limit 100 --json number,headRefName,title,body --jq '${RUN_PRS} | .number' 2>/dev/null); do`,
  '  head=$(gh pr view "$n" --repo "$R" --json headRefName --jq .headRefName 2>/dev/null)',
  `  gh api "repos/$R/branches/$head" --jq '"BRANCH \\(.name)"' 2>&1`,
  `  gh api "repos/$R/pulls/$n/commits" --jq '.[] | "AUTHOR '"$n"' \\(.sha[0:7]) \\(.commit.author.email) \\(.commit.committer.email)"' 2>&1`,
  `  if gh pr diff "$n" --repo "$R" 2>/dev/null | grep -q '^+.*${README_LINE}'; then echo "LINE $n yes"; else echo "LINE $n no"; fi`,
  'done',
  `echo "cinna-e2e end ${RUN_ID}"`,
  ''
].join('\n')

/**
 * Closes the open pull requests whose head is exactly this run's branch (in this repository, not a
 * fork), then deletes exactly `heads/<branch>` if it is still there. Every gh call's exit status is
 * checked before its output is used, and nothing is named from an error's text: gh prints GitHub's
 * error body on stdout, which once turned a 409 "Git Repository is empty." into four DELETEs.
 * An absent pull request or branch is fine; what was done is printed.
 */
const CLEANUP_SCRIPT = [
  '#!/bin/sh',
  `R='${REPO}'`,
  `B='${BRANCH}'`,
  `echo "cinna-e2e cleanup ${RUN_ID}"`,
  'err=$(mktemp) || exit 1',
  `prs=$(gh pr list --repo "$R" --state open --head "$B" --limit 100 --json number,headRefName,isCrossRepository --jq '.[] | select(.headRefName == "${BRANCH}" and (.isCrossRepository | not)) | .number' 2>"$err")`,
  's=$?',
  'if [ "$s" -ne 0 ]; then echo "PR LIST failed (exit $s): $(head -c 300 "$err" | tr "\\n" " ")"; prs=""; fi',
  'closed=0',
  'for n in $prs; do',
  '  case "$n" in *[!0-9]*) echo "SKIPPED a pull request number that is not a number"; continue ;; esac',
  '  if gh pr close "$n" --repo "$R" --delete-branch >"$err" 2>&1; then echo "CLOSED PR $n"; closed=$((closed + 1))',
  '  else echo "CLOSE PR $n failed (exit $?): $(head -c 300 "$err" | tr "\\n" " ")"; fi',
  'done',
  '[ "$s" -ne 0 ] || [ "$closed" -gt 0 ] || [ -n "$prs" ] || echo "NO open pull request from $B"',
  'ref=$(gh api "repos/$R/git/ref/heads/$B" --jq .ref 2>"$err")',
  's=$?',
  'if [ "$s" -eq 0 ] && [ "$ref" = "refs/heads/$B" ]; then',
  '  if gh api -X DELETE "repos/$R/git/refs/heads/$B" >"$err" 2>&1; then echo "DELETED BRANCH $B"',
  '  else echo "DELETE BRANCH $B failed (exit $?): $(head -c 300 "$err" | tr "\\n" " ")"; fi',
  'elif [ "$s" -eq 0 ]; then echo "SKIPPED the branch: GitHub answered another ref"',
  'elif grep -q "HTTP 404" "$err"; then echo "NO branch $B"',
  'else echo "BRANCH READ failed (exit $s), nothing deleted: $(head -c 300 "$err" | tr "\\n" " ")"; fi',
  'rm -f "$err"',
  `echo "cinna-e2e end ${RUN_ID}"`,
  ''
].join('\n')

const EMPTY_REPO_SKIP = 'the test repo needs an initial commit with a README on its default branch'

/**
 * Whether the repository has a README on its default branch, read without a sign-in (a public
 * repository): `missing` on a 404 for the README of a repository that exists (an empty one, or no
 * README), `unknown` when the repository itself is not readable that way (private, or GitHub did
 * not answer).
 */
async function publicReadme(): Promise<'present' | 'missing' | 'unknown'> {
  const get = async (path: string): Promise<number> => {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'cinna-e2e' }, signal: AbortSignal.timeout(15_000) })
      return res.status
    } catch {
      return 0
    }
  }
  if (await get('') !== 200) return 'unknown'
  const readme = await get('/readme')
  return readme === 200 ? 'present' : readme === 404 || readme === 409 ? 'missing' : 'unknown'
}

/** The same check for a private repository, through Cinna's gh wrapper once signed in. */
const PRECHECK_SCRIPT = [
  '#!/bin/sh',
  `R='${REPO}'`,
  `echo "cinna-e2e precheck ${RUN_ID}"`,
  'err=$(mktemp) || exit 1',
  'path=$(gh api "repos/$R/readme" --jq .path 2>"$err")',
  's=$?',
  'if [ "$s" -eq 0 ]; then echo "README FOUND"',
  'elif grep -q "HTTP 40[49]" "$err"; then echo "README MISSING"',
  'else echo "README UNKNOWN (exit $s): $(head -c 300 "$err" | tr "\\n" " ")"; fi',
  'rm -f "$err"',
  `echo "cinna-e2e end ${RUN_ID}"`,
  ''
].join('\n')

/** Adds `/run:<name>` to the agent's catalog (read fresh on every run), once. */
function addKitCommand(agentPath: string, name: string, script: string, description: string): void {
  const file = join(agentPath, 'scripts', `${name}.sh`)
  if (existsSync(file)) return
  writeFileSync(file, script)
  appendFileSync(join(agentPath, 'docs', 'CLI_COMMANDS.yaml'),
    `\n  - name: ${name}\n    description: ${description}\n    command: /bin/sh scripts/${name}.sh\n`)
}

const prComposer = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })

async function assistantReplies(cinna: CinnaApp, chatId: string): Promise<{ running: boolean; replies: string[] }> {
  return cinna.page.evaluate(async (id) => {
    const chat = await window.api.chat.get(id)
    return {
      running: !!chat?.activeRunId,
      replies: (chat?.messages ?? []).filter((m) => m.role === 'assistant').map((m) => m.content)
    }
  }, chatId)
}

/**
 * Wait for the chat's turn to end, answering every permission ask with Allow
 * once on the way (haiku runs Ask every time). Answers the replies the turn
 * added.
 */
async function settleTurn(cinna: CinnaApp, chatId: string, before: number, label: string): Promise<string> {
  let asks = 0
  await expect.poll(async () => {
    const allow = cinna.page.getByRole('button', { name: 'Allow once', exact: true })
    if (await allow.count() > 0) {
      await allow.first().click({ timeout: 10_000 }).then(() => { asks++ }, () => undefined)
      return 'answering an ask'
    }
    if (await cinna.page.getByText(/^The agent is asking (a question|\d+ questions)$/).count() > 0) return 'stuck on a question nobody here answers'
    const state = await assistantReplies(cinna, chatId)
    return state.running || state.replies.length <= before ? 'running' : 'idle'
  }, { message: `${label}: the turn ends`, timeout: TURN_TIMEOUT_MS, intervals: [1_000] }).toBe('idle')
  const added = (await assistantReplies(cinna, chatId)).replies.slice(before).join('\n')
  console.log(`    ${label}: turn ended after ${asks} Allow once; reply: ${JSON.stringify(added.slice(-600))}`)
  return added
}

/** `/run:<name>` sent in the chat (Send, not Enter); answers its output once the end marker shows. */
async function runInChat(cinna: CinnaApp, name: string, marker: string): Promise<string> {
  const blocks = cinna.page.locator('pre code').filter({ hasText: `cinna-e2e ${marker} ${RUN_ID}` })
  const before = await blocks.count()
  await expect(prComposer(cinna)).toBeVisible()
  await prComposer(cinna).fill(`/run:${name}`)
  await cinna.page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(blocks).toHaveCount(before + 1, { timeout: 120_000 })
  await expect(blocks.last()).toContainText(`cinna-e2e end ${RUN_ID}`, { timeout: 120_000 })
  return blocks.last().innerText()
}

/** One commit of a pull request: its short sha, author email and committer email. */
interface PrCommit { sha: string; author: string; committer: string }
interface Verified { prs: { number: string; head: string }[]; branches: string[]; authors: Map<string, PrCommit[]>; withLine: string[]; text: string }

function parseVerify(text: string): Verified {
  const lines = text.split('\n').map((line) => line.trim())
  const authors = new Map<string, PrCommit[]>()
  for (const line of lines) {
    const m = /^AUTHOR (\d+) (\S+) (\S+) (\S+)$/.exec(line)
    if (m) authors.set(m[1], [...(authors.get(m[1]) ?? []), { sha: m[2], author: m[3], committer: m[4] }])
  }
  return {
    prs: lines.flatMap((line) => { const m = /^PR (\d+) (\S+)$/.exec(line); return m ? [{ number: m[1], head: m[2] }] : [] }),
    branches: lines.flatMap((line) => { const m = /^BRANCH (\S+)$/.exec(line); return m ? [m[1]] : [] }),
    authors,
    withLine: lines.flatMap((line) => { const m = /^LINE (\d+) yes$/.exec(line); return m ? [m[1]] : [] }),
    text
  }
}

function gitValue(args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

test.describe('real Claude (haiku) turn', () => {
  test.use({
    // The Claude token never reaches the app's own environment either (the wrapper reads it from its file).
    env: { ...NO_GH_TOKENS, CINNA_E2E_CLAUDE_OAUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_OAUTH_TOKEN: '' },
    // Proof from main's output that the turns ran on the Claude launcher (any binary: the OAuth run's is the wrapper).
    liveEngineCheck: { engine: 'claude', binary: null }
  })

  test.beforeEach(() => {
    test.skip(!LIVE_REQUESTED, 'Billed: runs only through make e2e-one SPEC=e2e/specs/live-github-repos.spec.ts (which sets CINNA_E2E_LIVE=1).')
    const auth = claudeAuth()
    test.skip('skip' in auth, 'skip' in auth ? auth.skip : '')
  })

  test('real Claude (haiku): the agent clones, is refused until sign-in, then pushes a branch and opens a pull request as the user', async ({ cinna }) => {
    test.setTimeout(APPROVE_HUMAN_MS + (2 + MAX_NUDGES) * TURN_TIMEOUT_MS + 10 * 60_000)
    const auth = claudeAuth()
    if ('skip' in auth) throw new Error(auth.skip)
    const gh = realGh()!
    const [owner, repo] = REPO.split('/')
    let agentPath = ''
    let agentId = ''
    let chatId = ''
    let tokenFile: string | null = null
    let turns = 0
    console.log(`\n>>> GitHub repos live flow: ${REPO}, run id ${RUN_ID}, branch ${BRANCH}, Claude ${auth.kind === 'oauth' ? 'subscription token' : 'API token'} on haiku\n`)
    // Before any billed turn: a public repository is read without a sign-in; a private one only
    // after it (step 3, once turn 1 has run), through the agent's gh wrapper.
    const readme = await publicReadme()
    console.log(`    README on the default branch, read without a sign-in: ${readme}`)
    test.skip(readme === 'missing', EMPTY_REPO_SKIP)

    try {
      await test.step('step 1: a kit agent on Claude Agent (haiku), approval Ask every time', async () => {
        console.log('>>> step 1: arranging the kit agent on Claude haiku…')
        await cinna.skipOnboarding()
        const root = await addAgentRoot(cinna)
        const agent = await createFolderAgent(cinna, root, PR_AGENT, 'Works on GitHub repositories for the user.')
        agentPath = agent.path
        agentId = agent.id
        const saved = await cinna.page.evaluate(async (id) => {
          const got = await window.api.localAgents.get(id)
          if (!got.ok) return got.message
          const stamp = got.value.stamps['cinna-agent.json']
          if (!stamp) return 'the kit agent has no manifest stamp'
          const runtime = { engine: 'claude' as const, credential: null, modelId: 'haiku', complexity: null }
          const updated = await window.api.localAgents.updateField({ agentId: id, update: { field: 'runtime', value: runtime }, expectedStamp: stamp })
          if (!updated.ok) return updated.message
          const approval = await window.api.localAgents.setClaudeApproval(id, 'ask')
          return approval.ok ? null : approval.message
        }, agentId)
        expect(saved, 'the haiku runtime and Ask every time are saved on the agent').toBeNull()
        if (auth.kind === 'oauth') {
          const written = writeClaudeOauthWrapper(cinna, auth.binary)
          tokenFile = written.tokenFile
          await cinna.page.evaluate((path) => window.api.settings.set('localAgentsClaudePath', path), written.wrapper)
        }
        // The real gh's directory first, so the run does not depend on how the developer's PATH orders it.
        for (const rc of ['.zprofile', '.zshrc', '.bash_profile', '.profile']) {
          appendFileSync(join(cinna.sandbox.home, rc), `export PATH=${JSON.stringify(dirname(gh))}:"$PATH"\n`)
        }
        await cinna.relaunch()
        await cinna.skipOnboarding()
        if (auth.kind === 'api_key') await pinClaudeApiProfile(cinna.page, { binary: auth.binary })
        await cinna.page.evaluate(() => window.api.localAgents.rescan())
        const globalEmail = gitValue(['config', '--global', '--get', 'user.email'],
          { ...process.env, HOME: cinna.sandbox.home, XDG_CONFIG_HOME: join(cinna.sandbox.home, '.config'), GIT_CONFIG_GLOBAL: '' })
        console.log(`    sandbox global git user.email: ${globalEmail === '' ? '(none)' : globalEmail}`)
        expect(globalEmail, 'the sandbox HOME has no global git identity, so the served clone gets the noreply one').toBe('')
      })

      await test.step('step 2: the user asks for the change; the agent’s gh is refused and it relays Sign in to GitHub', async () => {
        console.log('>>> step 2: asking the agent (haiku turn 1)…')
        const page = cinna.page
        await page.getByRole('button', { name: 'Agents', exact: true }).click()
        await answerAgentsFolder(cinna)
        await page.getByRole('button', { name: PR_AGENT, exact: true }).click()
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(PR_AGENT)
        await prComposer(cinna).fill(ASK)
        await prComposer(cinna).press('Enter')
        turns++
        await expect.poll(async () => {
          const list = await cinna.page.evaluate(() => window.api.chat.list())
          return list.find((chat) => chat.agentId === agentId)?.id ?? null
        }, { message: 'the message opens a chat with the agent' }).not.toBeNull()
        chatId = (await cinna.page.evaluate(() => window.api.chat.list())).find((chat) => chat.agentId === agentId)!.id
        const reply = await settleTurn(cinna, chatId, 0, 'turn 1')
        expect(reply, 'the agent relays the wrapper’s sentence').toMatch(/sign in to github/i)
        await expect(cinna.page.getByRole('status', { name: 'Agent status' }).getByRole('button', { name: 'Sign in to GitHub' })).toBeVisible()
        const status = await cinna.page.evaluate(() => window.api.github.status())
        expect(status.ok && status.value.needs.find((need) => need.kind === 'sign_in')?.agentIds).toContain(agentId)
      })

      await test.step('step 3: Sign in to GitHub from the row; a human enters the code', async () => {
        const panel = cinna.page.getByRole('status', { name: 'Agent status' })
        await panel.getByRole('button', { name: 'Sign in to GitHub' }).click()
        const code = panel.locator('strong')
        await expect(code).toHaveText(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/, { timeout: 30_000 })
        const userCode = await code.innerText()
        const status = await cinna.page.evaluate(() => window.api.github.status())
        const url = (status.ok ? status.value.device?.verificationUri : null) ?? 'https://github.com/login/device'
        mkdirSync(dirname(DEVICE_CODE_FILE), { recursive: true })
        writeFileSync(DEVICE_CODE_FILE, `GITHUB DEVICE CODE: ${userCode}\n${url}\n`)
        console.log(`\n>>> step 3: GITHUB DEVICE CODE: ${userCode}`)
        console.log(`>>> enter it at ${url} within 10 minutes (also in ${DEVICE_CODE_FILE})\n`)
        if (process.env.CINNA_E2E_GITHUB_OPEN_BROWSER === '1' && url.startsWith('https://github.com/')) {
          execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => undefined)
        }
        await expect(cinna.page.getByRole('status', { name: 'GitHub' }).getByText('GitHub is connected.', { exact: true }))
          .toBeVisible({ timeout: APPROVE_HUMAN_MS })
        await connectedCoverage(cinna)
      })

      if (readme === 'unknown') {
        await test.step('step 3: the repository has a README on its default branch (read through the wrapper, before any further turn)', async () => {
          addKitCommand(agentPath, 'cinna-e2e-precheck', PRECHECK_SCRIPT, 'E2E check that the repository has a README (test only)')
          const out = await runInChat(cinna, 'cinna-e2e-precheck', 'precheck')
          console.log(`    precheck: ${out.split('\n').filter((line) => line.startsWith('README')).join(' ') || out}`)
          test.skip(/^README MISSING$/m.test(out), EMPTY_REPO_SKIP)
        })
      }

      let verified: Verified | null = null
      await test.step('step 4: Continue; the agent clones, pushes the branch and opens the pull request', async () => {
        console.log('>>> step 4: Continue (haiku turn 2)…')
        const before = (await assistantReplies(cinna, chatId)).replies.length
        await cinna.page.getByRole('status', { name: 'GitHub' }).getByRole('button', { name: 'Continue' }).click()
        turns++
        await expect(cinna.page.getByText('GitHub is connected, go on', { exact: true })).toBeVisible()
        await settleTurn(cinna, chatId, before, 'turn 2 (Continue)')
        addKitCommand(agentPath, 'cinna-e2e-verify', VERIFY_SCRIPT, 'E2E check of a pull request (test only)')
        for (let nudge = 0; ; nudge++) {
          verified = parseVerify(await runInChat(cinna, 'cinna-e2e-verify', 'verify'))
          console.log(`    verify: ${verified.prs.length} pull request(s) for the run, line in ${verified.withLine.join(', ') || 'none'}`)
          if (verified.withLine.length > 0 || nudge >= MAX_NUDGES || turns >= 6) break
          const needs = await cinna.page.evaluate(() => window.api.github.status())
          if (needs.ok && needs.value.needs.some((need) => need.kind === 'install')) {
            throw new Error(`The OpenCinna app cannot reach ${REPO}: Allow access shows. Add the repository to the installation and run again.`)
          }
          console.log(`>>> step 4: no pull request with the line yet, nudging (haiku turn ${turns + 1})…`)
          const replies = (await assistantReplies(cinna, chatId)).replies.length
          await prComposer(cinna).fill('please continue')
          await prComposer(cinna).press('Enter')
          turns++
          await settleTurn(cinna, chatId, replies, `turn ${turns} (nudge)`)
        }
      })

      await test.step('step 4: the clone, its identity, the pushed branch and the pull request on GitHub', async () => {
        console.log('>>> step 4: checking the clone and GitHub…')
        const v = verified!
        const reposDir = join(agentPath, 'app-data', 'repos')
        const entries = existsSync(reposDir) ? readdirSync(reposDir) : []
        const folder = entries.find((name) => name.toLowerCase() === `${owner}__${repo}`.toLowerCase())
        expect(folder, `the clone is app-data/repos/${owner}__${repo} (found: ${entries.join(', ') || 'nothing'})`).toBeTruthy()
        const clone = join(reposDir, folder!)
        expect(gitValue(['-C', clone, 'remote', 'get-url', 'origin']).toLowerCase()).toContain(REPO.toLowerCase())
        const status = await cinna.page.evaluate(() => window.api.github.status())
        const login = status.ok ? status.value.account?.login ?? '' : ''
        // Informational: G7 keeps the noreply in the clone only after a served `gh repo clone`; a plain
        // `git clone` has no local identity and its commits get the noreply from Cinna's identity
        // config (GIT_CONFIG_GLOBAL). What counts is the commits on GitHub, below.
        const localEmail = gitValue(['-C', clone, 'config', '--local', '--get', 'user.email'])
        console.log(`    clone ${clone}: local user.email ${localEmail === '' ? '(none)' : localEmail}`)
        const escaped = login.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
        const noreply = new RegExp(`^\\d+\\+${escaped}@users\\.noreply\\.github\\.com$`, 'i')
        expect(login, 'signed in to GitHub').not.toBe('')

        expect(v.withLine, `an open pull request for run ${RUN_ID} adds the README line:\n${v.text}`).not.toHaveLength(0)
        const number = v.withLine[0]
        const pr = v.prs.find((p) => p.number === number)!
        console.log(`    pull request #${number} from ${pr.head}`)
        expect(v.branches, 'its head branch is on the remote').toContain(pr.head)
        const commits = v.authors.get(number) ?? []
        expect(commits.length, 'the pull request has commits').toBeGreaterThan(0)
        // Every commit, author and committer, is the user's noreply <id>+<login>: no stranger's
        // address (live run 4 committed as a made-up cinna@users.noreply.github.com).
        const offenders = commits.filter((c) => !noreply.test(c.author) || !noreply.test(c.committer))
        for (const c of offenders) console.log(`    OFFENDER ${c.sha}: author ${c.author}, committer ${c.committer}`)
        const emails = new Set(commits.flatMap((c) => [c.author.toLowerCase(), c.committer.toLowerCase()]))
        expect(offenders, `every commit's author and committer is the noreply <id>+${login}: ${commits.map((c) => `${c.sha} ${c.author}/${c.committer}`).join(', ')}`).toEqual([])
        expect(emails.size, `one noreply address on every commit: ${[...emails].join(', ')}`).toBe(1)
        console.log(`    ${turns} haiku turn(s) in all`)
      })
    } finally {
      await test.step('step 5: cleanup — close the pull request and delete the branch', async () => {
        console.log('>>> step 5: cleaning up on GitHub…')
        try {
          if (chatId !== '' && (await assistantReplies(cinna, chatId)).running) {
            await cinna.page.evaluate((id) => window.api.run.cancelChat(id), chatId)
            await expect.poll(async () => (await assistantReplies(cinna, chatId)).running, { timeout: 60_000 }).toBe(false)
          }
          const status = await cinna.page.evaluate(() => window.api.github.status())
          if (chatId === '' || !status.ok || status.value.account?.state !== 'connected') {
            console.log('    nothing to clean: no chat, or GitHub was never connected (nothing could have been pushed)')
          } else {
            addKitCommand(agentPath, 'cinna-e2e-cleanup', CLEANUP_SCRIPT, 'E2E cleanup of a pull request (test only)')
            const out = await runInChat(cinna, 'cinna-e2e-cleanup', 'cleanup')
            console.log(`    cleanup output:\n${out.split('\n').map((line) => `      ${line}`).join('\n')}`)
          }
        } catch (err) {
          console.log(`    !!! cleanup through the app failed (${err instanceof Error ? err.message.split('\n')[0] : String(err)}). Clean up by hand:`)
          console.log(`      gh pr list --repo ${REPO} --state open --head ${BRANCH}   # then gh pr close <n> --repo ${REPO} --delete-branch`)
          console.log(`      gh api -X DELETE repos/${REPO}/git/refs/heads/${BRANCH}`)
        } finally {
          if (tokenFile) rmSync(tokenFile, { force: true })
        }
      })
    }
  })
})
