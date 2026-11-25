import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { repoRoot } from '../playwright.config'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

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
test.use({
  env: { GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '' },
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
    const status = await cinna.page.evaluate(() => window.api.github.status())
    if (!status.ok) throw new Error(status.error)
    const owner = REPO.split('/')[0].toLowerCase()
    const install = status.value.account?.coverage.find((i) => i.owner.toLowerCase() === owner)
    expect(install, `the OpenCinna app is not installed on ${owner}: install it there and run again`).toBeTruthy()
    if (install!.selection === 'selected') expect(install!.repos.map((r) => r.toLowerCase())).toContain(REPO.toLowerCase())
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
