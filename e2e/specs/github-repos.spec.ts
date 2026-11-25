import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import {
  AGENT, CODE_SENTENCE, INSTALL_SENTENCE, LOGIN, REPLY, RESOLVED_TITLE, SERVED, SIGN_IN_ROW_TITLE, SIGN_IN_SENTENCE,
  arrange, commandOutput, github, openedUrls, panel, rerunInChat, resolvedPanel, runFromCommands, signInOverIpc, useFakeGithub
} from '../fixtures/fakeGithub'

/**
 * GitHub repos P1: a kit agent's `gh` against the OpenCinna sign-in, with
 * every GitHub endpoint faked on loopback. What is real and what is fake:
 * `e2e/fixtures/fakeGithub.ts`. More flows (git's credential path, Reconnect,
 * an expired or declined code, the public-repo rule):
 * `github-repos-flows.spec.ts`.
 */

useFakeGithub()

test('sign in from the composer: the refused gh shows the row, the device code, Continue, then gh runs on the OpenCinna token', async ({ cinna }) => {
  test.setTimeout(120_000)
  // The app is installed on acme with every repository: the sign-in is all that is missing.
  github.installs = [{ id: 77, owner: 'acme', ownerId: 9001, type: 'Organization', repos: 'all' }]
  const { acp, agentPath } = await arrange(cinna)

  await test.step('the scaffolded agent is sent to guide 15, and its relative path resolves to the workshop kit', async () => {
    // Kit agents live at <root>/Local/<slug>, the kit at <root>/.cinna-kit: AGENTS.md item 7 is relative to that.
    expect(basename(dirname(agentPath))).toBe('Local')
    const guide = '../../.cinna-kit/guides/15-github-repos.md'
    expect(readFileSync(join(agentPath, 'AGENTS.md'), 'utf8')).toContain(`read \`${guide}\` first`)
    await expect.poll(() => existsSync(join(agentPath, guide)), { timeout: 15_000 }).toBe(true)
  })

  await test.step('gh is refused with exit 4 and the sign-in sentence; the composer offers Sign in to GitHub', async () => {
    await runFromCommands(cinna)
    await expect(commandOutput(cinna, 0)).toHaveText(`${SIGN_IN_SENTENCE}\ngh exit: 4`)
    await expect(panel(cinna).getByTitle(SIGN_IN_ROW_TITLE)).toHaveText('GitHub isn’t connected.')
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
async function statusRunsGhCheck(cinna: CinnaApp, repoAgentId: string): Promise<void> {
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
  const { agentId: repoAgentId } = await arrange(cinna)
  await statusRunsGhCheck(cinna, repoAgentId)
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
    await expect(panel(cinna).getByTitle(SIGN_IN_ROW_TITLE)).toHaveText('GitHub isn’t connected.')
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
