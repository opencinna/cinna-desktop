import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { RUNTIME_PINS } from '../../../src/shared/runtimePins'
import { arrangeAgentsHome } from '../fixtures/agentSession'
import { expect, q, test } from '../fixtures/vm'

/**
 * GitHub repos P1, the managed gh on a Mac that has no gh: a kit agent's
 * `/run:` command calls `gh --version` through Cinna's wrapper
 * (`<userData>/gh-shim/gh`) while the profile is signed in to GitHub. The
 * wrapper gets a token, finds no gh, reports `gh_missing`, and says
 * "Cinna is still installing gh, try again in a moment." (exit 1); the app
 * downloads the pinned gh from GitHub's releases into
 * `<userData>/runtimes/gh-<pin>/bin/gh`; the same command run again prints the
 * pinned version (exit 0). No system dialog at any step (the fixture fails the
 * test on any).
 *
 * ## Arrangement
 *
 * GitHub's sign-in and API are a fake on the host (`CINNA_GITHUB_WEB_URL` /
 * `CINNA_GITHUB_API_URL` at launch, reverse-forwarded to the guest's
 * loopback): the device flow approves at once, `/user` names a login, no
 * installation is listed (a command naming no repo needs none). Its
 * `verification_uri` is not a github.com page, so the app refuses to open it
 * and no browser starts. The gh download itself is real.
 *
 * A completed sign-in also starts the install when the login shell's PATH has
 * no gh. To make the wrapper the trigger, a stand-in `gh` is on that PATH (via
 * `~/.zprofile`) while the sign-in completes and is deleted before the
 * command runs — as for a user who had gh then and removed it since.
 *
 * ## Not proven
 *
 * The sign-in trigger on its own (sign-in with no gh at all), a real GitHub
 * sign-in or API call through the managed gh (only `--version` runs), and an
 * engine's model turn calling gh — the command is a `/run:`, no engine runs.
 */

const AGENT = 'Repo Agent'
/** The guest end of the reverse forward; the guest is a fresh clone, nothing else listens there. */
const GUEST_PORT = 47614
const GITHUB_ORIGIN = `http://127.0.0.1:${GUEST_PORT}`
const TOKEN = 'ghu_bareMacFakeOpenCinnaToken0001'
const STAND_IN_DIR = '/Users/admin/stand-in-gh'
const INSTALLING = 'Cinna is still installing gh, try again in a moment.'
const GH_CHECK = 'gh --version 2>&1\necho "gh exit: $?"\n'

test.use({
  launchEnv: { CINNA_GITHUB_WEB_URL: GITHUB_ORIGIN, CINNA_GITHUB_API_URL: `${GITHUB_ORIGIN}/api` },
  beforeLaunch: [
    `mkdir -p ${q(STAND_IN_DIR)}`,
    `printf '#!/bin/sh\\necho "stand-in gh"\\n' > ${q(`${STAND_IN_DIR}/gh`)}`,
    `chmod 755 ${q(`${STAND_IN_DIR}/gh`)}`,
    `echo ${q(`export PATH=${STAND_IN_DIR}:"$PATH"`)} >> ~/.zprofile`
  ].join(' && ')
})

/** GitHub's device flow and the two API reads a completed sign-in makes, on the host's loopback. */
function fakeGithub(requests: string[]): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    requests.push(`${req.method} ${path}`)
    req.resume()
    req.on('end', () => {
      const json = (status: number, value: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (req.method === 'POST' && path === '/login/device/code') {
        // Not a github.com page: main refuses to open it, so no browser starts in the guest.
        json(200, { device_code: 'bare-mac-device-code', user_code: 'BARE-MAC1', verification_uri: `${GITHUB_ORIGIN}/login/device`, expires_in: 900, interval: 1 })
      } else if (req.method === 'POST' && path === '/login/oauth/access_token') {
        json(200, { access_token: TOKEN, expires_in: 28_800, refresh_token: 'ghr_bareMacFakeRefresh0001', refresh_token_expires_in: 15_811_200, token_type: 'bearer' })
      } else if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        json(401, { message: 'Bad credentials' })
      } else if (path === '/api/user') {
        json(200, { login: 'octo-bare', id: 4242, name: 'Octo Bare', type: 'User' })
      } else if (path === '/api/user/installations') {
        json(200, { total_count: 0, installations: [] })
      } else {
        json(404, { message: 'Not Found' })
      }
    })
  })
}

test('a kit agent’s first gh call installs the managed gh, and the next one runs it', async ({ vm }) => {
  const { page } = vm
  const requests: string[] = []
  const server = fakeGithub(requests)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const ghDir = `${vm.userData}/runtimes/gh-${RUNTIME_PINS.gh.cli}`
  const managed = `${ghDir}/bin/gh`
  const exists = async (path: string): Promise<boolean> => (await vm.sh(`test -e ${q(path)} && echo yes || echo no`)).trim() === 'yes'
  try {
    await vm.reverseForward((server.address() as AddressInfo).port, GUEST_PORT)

    await arrangeAgentsHome(vm, 'claude', async () => {
      vm.step('sign in to the fake GitHub')
      const started = await page.evaluate(() => window.api.github.signIn())
      // The flow starts and polls; only the browser open is refused.
      expect(started).toEqual({ ok: false, error: 'That link is not a GitHub page.' })
      await expect
        .poll(async () => {
          const status = await page.evaluate(() => window.api.github.status())
          return status.ok ? status.value.account?.state ?? null : status.error
        })
        .toBe('connected')
    })
    // The stand-in gh was on PATH at sign-in, so the sign-in started no install.
    expect(await exists(ghDir)).toBe(false)

    vm.step('create an agent with /run:gh-check')
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name: 'Add an agent' }).click()
    await page.getByRole('dialog', { name: 'Add an agent' }).getByRole('button', { name: /^New agent/ }).click()
    const form = page.getByRole('dialog', { name: 'New agent' })
    await form.getByLabel('Name').fill(AGENT)
    await form.getByLabel('Name').press('Enter')
    await expect(form).toBeHidden()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
    const agent = await page.evaluate(async (name) => {
      const { agents } = await window.api.localAgents.list()
      const found = agents.find((a) => a.name === name)
      if (!found) throw new Error(`no agent named ${name}`)
      const done = await window.api.localAgents.markGuidedBuildDone(found.id)
      if (!done.ok) throw new Error(done.message)
      return { id: found.id, path: found.path }
    }, AGENT)
    const yaml = '\n  - name: gh-check\n    description: gh --version through the wrapper\n    command: /bin/sh scripts/gh-check.sh\n'
    await vm.sh(
      `printf '%s' ${q(`#!/bin/sh\n${GH_CHECK}`)} > ${q(`${agent.path}/scripts/gh-check.sh`)} && ` +
        `printf '%s' ${q(yaml)} >> ${q(`${agent.path}/docs/CLI_COMMANDS.yaml`)}`
    )
    await page.evaluate(() => window.api.localAgents.rescan())
    await page.reload()
    await page.getByRole('button', { name: 'Agents', exact: true }).click()
    await page.getByRole('button', { name: AGENT, exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)

    vm.step('remove the stand-in gh')
    await vm.sh(`rm -f ${q(`${STAND_IN_DIR}/gh`)}`)

    vm.step('run /run:gh-check: no gh yet')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Commands/ }).click()
    await page.getByRole('listitem').filter({ hasText: '/run:gh-check' }).getByRole('button', { name: 'Run', exact: true }).click()
    await expect(page.locator('pre code').nth(0)).toHaveText(`${INSTALLING}\ngh exit: 1`)

    vm.step('wait for the managed gh')
    await expect
      .poll(() => exists(managed), { timeout: 5 * 60_000, intervals: [3_000] })
      .toBe(true)

    vm.step('run /run:gh-check again: the managed gh answers')
    const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
    await input.fill('/run:gh-check')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // `gh version <pin> (<build date>)`, the release page, then the script's exit line.
    const answer = `^${escape(RUNTIME_PINS.gh.versionOutput)} \\(\\d{4}-\\d{2}-\\d{2}\\)\\n` +
      `${escape(`https://github.com/cli/cli/releases/tag/v${RUNTIME_PINS.gh.cli}`)}\\ngh exit: 0\\n?$`
    await expect(page.locator('pre code').nth(1)).toHaveText(new RegExp(answer))
    expect(requests).toContain('POST /login/oauth/access_token')
  } finally {
    test.info().annotations.push({ type: 'github requests', description: [...new Set(requests)].join(' | ') })
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
