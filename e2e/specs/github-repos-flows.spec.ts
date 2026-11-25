import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type CinnaApp } from '../fixtures/app'
import {
  GH_CHECK, LOGIN, RECONNECT_SENTENCE, RESOLVED_TITLE, SERVED, SIGN_IN_ROW_TITLE, SIGN_IN_SENTENCE, TOKEN, USER_CODES,
  accountState, arrange, codeSentence, commandOutput, deviceCodesRequested, github, installSentence, openedUrls, panel,
  rerunInChat, resolvedPanel, runFromCommands, served, signInOverIpc, useFakeGithub
} from '../fixtures/fakeGithub'
import { startFakeGitRemote, type FakeGitRemote } from '../fixtures/fakeGitRemote'

/**
 * GitHub repos P1, the flows `github-repos.spec.ts` does not walk: git's own
 * credential path to an https remote, Reconnect after a dead refresh token,
 * a device code that expired or was declined, and the public-repo rule.
 * What is real and what is fake: `e2e/fixtures/fakeGithub.ts`, and for the
 * git remote `e2e/fixtures/fakeGitRemote.ts`.
 */

useFakeGithub()

let remote: FakeGitRemote
test.beforeAll(async () => { remote = await startFakeGitRemote(TOKEN) })
test.afterAll(async () => { await remote.close() })
test.beforeEach(() => { remote.reset() })

/**
 * A command that commits in a fresh repository and pushes it to
 * `https://github.com/<repo>.git`, then (on success) clones it back and
 * prints the commit it got. git reaches the fake remote through the proxy;
 * its credentials come only from the helper Cinna wires in the child's
 * `GIT_CONFIG_*`. `GIT_CONFIG_NOSYSTEM` keeps the machine's system helper
 * (osxkeychain) out: the user's own helper is the sandbox `~/.gitconfig`'s
 * recorder ({@link installUserHelper}).
 */
function gitPush(repo: string): string {
  const net = `-c http.proxy=${remote.proxy} -c http.sslVerify=false`
  return [
    'export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1',
    'unset GIT_ASKPASS SSH_ASKPASS',
    'work=$(mktemp -d)',
    'trap \'rm -rf "$work"\' EXIT',
    'cd "$work" || exit 1',
    'git init -q -b main src && git -C src -c user.name=E2E -c user.email=e2e@example.invalid commit -q --allow-empty -m "pushed by the agent"',
    `git -C src ${net} push https://github.com/${repo}.git main 2>&1`,
    'code=$?',
    'echo "git exit: $code"',
    '[ "$code" = 0 ] || exit 0',
    `git ${net} clone -q https://github.com/${repo}.git back 2>&1`,
    'echo "cloned: $(git -C back log -1 --format=%s 2>&1)"',
    // A commit with no identity of its own (none in the sandbox HOME): Cinna's identity config
    // (GIT_CONFIG_GLOBAL) gives the signed-in account's noreply, and it is pushed as that.
    `git -C back commit -q --allow-empty -m "committed by the agent" 2>&1 && git -C back ${net} push -q origin HEAD:main 2>&1`,
    'echo "pushed as: $(git -C back log -1 --format=\'%an <%ae> / <%ce>\' 2>&1)"',
    ''
  ].join('\n')
}

/** The user's own git credential helper, in the sandbox `~/.gitconfig`: records each call and answers a wrong password. */
function installUserHelper(cinna: CinnaApp): string {
  const log = join(cinna.sandbox.root, 'user-helper.log')
  const helper = join(cinna.sandbox.root, 'user-helper.sh')
  writeFileSync(helper, `#!/bin/sh\necho "$1" >> '${log}'\nprintf 'username=own-user\\npassword=own-password\\n'\n`, { mode: 0o755 })
  writeFileSync(join(cinna.sandbox.home, '.gitconfig'), `[credential]\n\thelper = ${helper}\n`)
  return log
}

/** git's own line once the helper answered nothing (`GIT_TERMINAL_PROMPT=0`). */
const noUsername = (repo: string): string => `fatal: could not read Username for 'https://github.com/${repo}.git': terminal prompts disabled`
/** The fake account's noreply commit identity (`/api/user`: id 4242, LOGIN, name Octo E2E). */
const NOREPLY = `4242+${LOGIN}@users.noreply.github.com`
const PUSHED = `To https://github.com/acme/shop.git\n * [new branch]      main -> main\ngit exit: 0\ncloned: pushed by the agent\npushed as: Octo E2E <${NOREPLY}> / <${NOREPLY}>`

test('git push and clone over https: refused with the sign-in sentence, then served by the OpenCinna token through the credential helper, committing as the noreply identity', async ({ cinna }) => {
  test.setTimeout(120_000)
  github.installs = [{ id: 77, owner: 'acme', ownerId: 9001, type: 'Organization', repos: 'all' }]
  remote.createBare('acme/shop')
  const userHelperLog = installUserHelper(cinna)
  await arrange(cinna, { 'git-push': gitPush('acme/shop') })

  await test.step('signed out: the helper prints the sign-in sentence, git fails, and the composer offers Sign in to GitHub', async () => {
    await runFromCommands(cinna, 'git-push')
    await expect(commandOutput(cinna, 0)).toHaveText(`${SIGN_IN_SENTENCE}\n${noUsername('acme/shop')}\ngit exit: 128`)
    await expect(panel(cinna).getByTitle(SIGN_IN_ROW_TITLE)).toHaveText('GitHub isn’t connected.')
    expect(remote.requests.every((r) => !r.authorized)).toBe(true)
  })

  await test.step('signed in: the push and the clone carry x-access-token and the OpenCinna token', async () => {
    await signInOverIpc(cinna)
    await expect(resolvedPanel(cinna).getByTitle(RESOLVED_TITLE)).toHaveText('GitHub is connected.')
    await rerunInChat(cinna, 'git-push')
    await expect(commandOutput(cinna, 1)).toHaveText(PUSHED)
    expect(remote.subjects('acme/shop', 'main')).toBe('committed by the agent\npushed by the agent')
    expect(remote.requests.filter((r) => r.authorized).map((r) => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining([
      'POST /acme/shop.git/git-receive-pack',
      'POST /acme/shop.git/git-upload-pack'
    ]))
    // Only github.com went through the proxy, and the user's own helper was never asked.
    expect([...new Set(remote.connects)]).toEqual(['github.com:443'])
    expect(existsSync(userHelperLog)).toBe(false)
  })
})

test('a dead refresh token: gh gets the Reconnect sentence and row, Reconnect GitHub signs in again, and gh runs', async ({ cinna }) => {
  test.setTimeout(120_000)
  github.installs = [{ id: 77, owner: 'acme', ownerId: 9001, type: 'Organization', repos: 'all' }]
  // Every access token lives a minute: each token request refreshes it first.
  github.deviceTtl = 60
  github.refreshTtl = 60
  await arrange(cinna, GH_CHECK)
  await signInOverIpc(cinna)

  await test.step('GitHub now answers bad_refresh_token: gh is refused with exit 4 and the Reconnect sentence', async () => {
    github.refreshDead = true
    await runFromCommands(cinna)
    await expect(commandOutput(cinna, 0)).toHaveText(`${RECONNECT_SENTENCE}\ngh exit: 4`)
    expect(github.requests.some((r) => r.form?.get('grant_type') === 'refresh_token')).toBe(true)
    expect(await accountState(cinna)).toBe('expired')
  })

  await test.step('the composer row says the sign-in expired and offers Reconnect GitHub', async () => {
    await expect(panel(cinna).getByTitle('The GitHub sign-in expired. Sign in again so this agent’s gh and git commands can reach GitHub.'))
      .toHaveText('The GitHub sign-in expired.')
    await expect(panel(cinna).getByRole('button', { name: 'Reconnect GitHub' })).toBeVisible()
  })

  await test.step('Reconnect GitHub runs a new device flow; approved, the row turns into GitHub is connected', async () => {
    github.deviceTtl = 28_800
    await panel(cinna).getByRole('button', { name: 'Reconnect GitHub' }).click()
    await expect(panel(cinna).getByTitle(codeSentence(USER_CODES[1]))).toHaveText(codeSentence(USER_CODES[1]))
    expect(deviceCodesRequested()).toBe(2)
    github.approve = true
    await expect(resolvedPanel(cinna).getByTitle(RESOLVED_TITLE)).toHaveText('GitHub is connected.')
    expect(await accountState(cinna)).toBe('connected')
  })

  await test.step('the same command now runs the real gh with the OpenCinna token', async () => {
    await rerunInChat(cinna)
    await expect(commandOutput(cinna, 1)).toHaveText(`${SERVED}\ngh exit: 0`)
    await expect(cinna.page.getByRole('button', { name: 'Reconnect GitHub' })).toHaveCount(0)
  })
})

test('a device code that expired, then one that was declined: the row says so, and each retry starts a fresh flow', async ({ cinna }) => {
  test.setTimeout(120_000)
  github.installs = [{ id: 77, owner: 'acme', ownerId: 9001, type: 'Organization', repos: 'all' }]
  await arrange(cinna, GH_CHECK)
  await runFromCommands(cinna)
  await expect(commandOutput(cinna, 0)).toHaveText(`${SIGN_IN_SENTENCE}\ngh exit: 4`)

  await test.step('Sign in to GitHub shows the first code; GitHub answers expired_token: Code expired, with Get a new code', async () => {
    await panel(cinna).getByRole('button', { name: 'Sign in to GitHub' }).click()
    await expect(panel(cinna).getByTitle(codeSentence(USER_CODES[0]))).toHaveText(codeSentence(USER_CODES[0]))
    github.deviceError = 'expired_token'
    await expect(panel(cinna).getByTitle('The GitHub sign-in code expired before it was approved.')).toHaveText('Code expired.')
    await expect(panel(cinna).getByRole('button', { name: 'Get a new code' })).toBeVisible()
    await expect(panel(cinna).getByText(codeSentence(USER_CODES[0]))).toHaveCount(0)
  })

  await test.step('Get a new code asks GitHub for a new code and shows it, waiting again', async () => {
    github.deviceError = null
    await panel(cinna).getByRole('button', { name: 'Get a new code' }).click()
    await expect(panel(cinna).getByTitle(codeSentence(USER_CODES[1]))).toHaveText(codeSentence(USER_CODES[1]))
    await expect(panel(cinna).getByText('Waiting for you to approve in the browser…', { exact: true })).toBeVisible()
    expect(deviceCodesRequested()).toBe(2)
  })

  await test.step('GitHub answers access_denied: the sign-in was declined, with Sign in to GitHub again', async () => {
    github.deviceError = 'access_denied'
    await expect(panel(cinna).getByTitle('The GitHub sign-in was declined in the browser.')).toHaveText('GitHub sign-in was declined.')
    await expect(panel(cinna).getByRole('button', { name: 'Sign in to GitHub' })).toBeVisible()
    expect(await accountState(cinna)).toBeNull()
  })

  await test.step('Sign in to GitHub starts a third flow; approved, gh runs on the OpenCinna token', async () => {
    github.deviceError = null
    await panel(cinna).getByRole('button', { name: 'Sign in to GitHub' }).click()
    await expect(panel(cinna).getByTitle(codeSentence(USER_CODES[2]))).toHaveText(codeSentence(USER_CODES[2]))
    expect(deviceCodesRequested()).toBe(3)
    github.approve = true
    await expect(resolvedPanel(cinna).getByTitle(RESOLVED_TITLE)).toHaveText('GitHub is connected.')
    expect(await openedUrls(cinna)).toEqual(['https://github.com/login/device', 'https://github.com/login/device', 'https://github.com/login/device'])
    await rerunInChat(cinna)
    await expect(commandOutput(cinna, 1)).toHaveText(`${SERVED}\ngh exit: 0`)
  })
})

test('an uncovered public repo: a gh read gets the token, a gh write and a git push get Allow access', async ({ cinna }) => {
  test.setTimeout(120_000)
  // The app is installed on acme only; octo/oss is public and no installation covers it.
  github.installs = [{ id: 77, owner: 'acme', ownerId: 9001, type: 'Organization', repos: 'all' }]
  github.visibility = { 'octo/oss': 'public' }
  remote.createBare('octo/oss')
  await arrange(cinna, {
    'gh-view-oss': 'gh repo view octo/oss 2>&1\necho "gh exit: $?"\n',
    'gh-write-oss': 'gh pr create -R octo/oss --title "Fix" --body "From the agent" 2>&1\necho "gh exit: $?"\n',
    'git-push-oss': gitPush('octo/oss')
  })
  await signInOverIpc(cinna)
  const row = (c: CinnaApp) => panel(c).getByTitle(/^Cinna’s GitHub app can’t reach octo\/oss yet\./)

  await test.step('gh repo view: GitHub says the repo is public, so the read gets the token and no row appears', async () => {
    await runFromCommands(cinna, 'gh-view-oss')
    await expect(commandOutput(cinna, 0)).toHaveText(`${served('repo view octo/oss')}\ngh exit: 0`)
    expect(github.requests.filter((r) => r.path === '/api/repos/octo/oss')).toHaveLength(1)
    await expect(row(cinna)).toHaveCount(0)
  })

  await test.step('gh pr create (a write): the install sentence, exit 4, and Allow access for octo/oss', async () => {
    await rerunInChat(cinna, 'gh-write-oss')
    await expect(commandOutput(cinna, 1)).toHaveText(`${installSentence('octo/oss')}\ngh exit: 4`)
    await expect(row(cinna)).toHaveText('Cinna’s GitHub app can’t reach octo/oss yet.')
    await expect(panel(cinna).getByRole('button', { name: 'Allow access' })).toBeVisible()
  })

  await test.step('git push: the helper prints the install sentence, git fails unauthenticated, still one row', async () => {
    await rerunInChat(cinna, 'git-push-oss')
    await expect(commandOutput(cinna, 2)).toHaveText(`${installSentence('octo/oss')}\n${noUsername('octo/oss')}\ngit exit: 128`)
    expect(remote.requests.every((r) => !r.authorized)).toBe(true)
    expect(remote.subjects('octo/oss', 'main')).toBe('')
    await expect(row(cinna)).toHaveCount(1)
  })

  await test.step('Allow access opens the app’s install page: nothing is installed on octo', async () => {
    await panel(cinna).getByRole('button', { name: 'Allow access' }).click()
    await expect.poll(() => openedUrls(cinna)).toEqual([
      'https://github.com/login/device',
      'https://github.com/apps/opencinna/installations/new'
    ])
  })
})
