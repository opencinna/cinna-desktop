import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/app'
import {
  approveDesktopAuth,
  liveCinnaConfig,
  preflight,
  requireLiveCinna,
  type Discovery
} from '../fixtures/liveCinna'

/**
 * One-click onboarding, against a **real** cinna-core and a **real** cinna-cli.
 *
 * This is the only spec in the suite that talks to a running server, and it is
 * the only one that can answer the question the feature actually raises: three
 * programs were changed in three repositories to agree on one contract — a
 * `local_dev` discovery block, a setup-token mint, a JSON line protocol, a set
 * of exit codes — and unit tests on either side of a contract prove nothing
 * about the contract itself.
 *
 * It skips unless `.env` names a live instance. See `../fixtures/liveCinna.ts`
 * for the three variables and `.env.example` for what each needs.
 *
 * ## What is real here
 *
 * Everything except one click. The deep link goes through the real main-process
 * funnel; the confirm step is the real component; the OAuth flow is the real
 * PKCE loopback flow, and cinna-core really mints the authorization code, the
 * tokens and the profile. The toolchain is really downloaded and verified
 * against the digest tables in `src/main/localdev/toolchain.ts`, cinna-cli is
 * really installed from PyPI at the version the *server* pinned, and
 * `cinna account setup` really creates the workspace from a really-minted,
 * single-use setup token.
 *
 * The substitution is the human pressing **Approve** in a browser: the suite
 * cannot drive a browser window, so `approveDesktopAuth` performs that one step
 * over the API. `shell.openExternal` is stubbed for the same reason — an
 * unstubbed run would open a browser on the machine running the tests.
 *
 * ## Why it is slow, and why that is fine
 *
 * A cold profile downloads uv, a CPython, Mutagen and the cinna-cli dependency
 * tree. That is minutes, which is why this is a separate `make e2e-integration`
 * target and not part of `make e2e`. It is the only place that proves a fresh
 * install of Cinna Desktop, pointed at a fresh server, gets a user all the way
 * to a working local development setup.
 */

const config = liveCinnaConfig()
const CONNECT_LINK = config
  ? [`--cinna-connect-intent=cinna://connect?server=${config.serverUrl}`]
  : []

/** Cold-profile installs dominate; the default 60s is nowhere near enough. */
const RUN_TIMEOUT_MS = 20 * 60_000

/** How long to wait for the local-dev reconciler to finish its whole job. */
const READY_TIMEOUT_MS = 15 * 60_000

test.describe('desktop + cinna-core + cinna-cli', () => {
  test.use({ launchArgs: CONNECT_LINK })

  test('a link, one authorization, and the machine is ready', async ({ cinna }) => {
    const live = requireLiveCinna()
    test.setTimeout(RUN_TIMEOUT_MS)

    // Preflight before touching the app, so a stack that cannot serve this run
    // is a skip naming the reason rather than a failure inside step four.
    const ready = await preflight(live)
    test.skip(!ready.ok, ready.ok ? '' : `live cinna-core not usable: ${ready.reason}`)
    const discovery = (ready as { ok: true; discovery: Discovery }).discovery
    const host = new URL(live.serverUrl).host

    await test.step('the link lands on the confirm step, naming the host', async () => {
      await expect(cinna.page.getByText(`Connect to ${host}?`, { exact: true })).toBeVisible()
      await expect(cinna.page.getByText(live.serverUrl, { exact: true })).toBeVisible()
    })

    await test.step('capture the authorization URL instead of opening a browser', async () => {
      // Patching the live `electron` module object is the same technique the
      // fixture uses for `dialog`: `cinna-oauth.ts` holds a reference to the
      // module, not to the function, so the call site sees the replacement.
      await cinna.electronApp.evaluate(({ shell }) => {
        const globals = globalThis as unknown as { __authorizeUrl?: string }
        globals.__authorizeUrl = undefined
        shell.openExternal = async (url: string): Promise<void> => {
          globals.__authorizeUrl = url
        }
      })
    })

    let authorizeUrl = ''
    await test.step('Connect starts the real OAuth flow', async () => {
      await cinna.page.getByRole('button', { name: 'Connect', exact: true }).click()

      // The app is now sitting on its loopback callback, which is exactly what
      // it does while a user reads a consent page.
      await expect(
        cinna.page.getByText('Waiting for browser authorization…', { exact: true })
      ).toBeVisible()

      await expect
        .poll(
          () =>
            cinna.electronApp.evaluate(
              () => (globalThis as unknown as { __authorizeUrl?: string }).__authorizeUrl ?? ''
            ),
          { timeout: 30_000, message: 'the app never asked to open an authorization URL' }
        )
        .not.toBe('')

      authorizeUrl = await cinna.electronApp.evaluate(
        () => (globalThis as unknown as { __authorizeUrl?: string }).__authorizeUrl as string
      )
      // The URL the app opens must be the one the *instance* advertised, not a
      // guess assembled from the origin the user was linked to.
      expect(authorizeUrl.startsWith(discovery.authorization_endpoint)).toBe(true)
    })

    await test.step('approve it the way the user’s browser would', async () => {
      await approveDesktopAuth(live, authorizeUrl)
    })

    await test.step('the account is connected', async () => {
      // The waiting panel goes away only when main has the tokens, the profile
      // row and the userinfo response.
      await expect(
        cinna.page.getByText('Waiting for browser authorization…', { exact: true })
      ).toHaveCount(0, { timeout: 120_000 })

      const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
      expect(user?.type).toBe('cinna_user')
      expect(user?.cinnaServerUrl?.replace(/\/$/, '')).toBe(live.serverUrl)
    })

    if (!discovery.local_dev) {
      // A supported outcome, not a failure: an instance that does not publish
      // the block is not offering local development to desktops.
      await test.step('an instance without a local_dev block says so', async () => {
        await expect
          .poll(() => cinna.page.evaluate(() => window.api.localDev.getState()), {
            timeout: 60_000
          })
          .toMatchObject({ phase: 'unsupported', reason: 'server' })
      })
      return
    }

    const state = await test.step('the reconciler asks before it installs anything', async () => {
      // `consent` is the only phase that may be reached without the user having
      // agreed to anything — that is the property being asserted, not the copy.
      const phase = await expect
        .poll(() => cinna.page.evaluate(() => window.api.localDev.getState()), {
          timeout: 120_000,
          message: 'the local-dev reconciler never answered'
        })
        .not.toMatchObject({ phase: 'idle' })
      void phase
      return cinna.page.evaluate(() => window.api.localDev.getState())
    })

    if (state.phase === 'unsupported' && state.reason === 'role') {
      // The account lacks `agent-developer` / `admin`. Real, supported, and
      // worth ending the run on rather than failing: the server is enforcing a
      // rule the desktop is correctly reporting.
      test.info().annotations.push({
        type: 'note',
        description: `${live.email} lacks the agent-developer/admin role, so the local-dev half was not exercised`
      })
      return
    }

    expect(state).toMatchObject({ phase: 'consent', host })

    await test.step('Set up installs the toolchain and creates the workspace', async () => {
      await expect(
        cinna.page.getByText('Set up local development?', { exact: true })
      ).toBeVisible()
      await cinna.page.getByRole('button', { name: 'Set up', exact: true }).click()

      await expect
        .poll(() => cinna.page.evaluate(() => window.api.localDev.getState()), {
          timeout: READY_TIMEOUT_MS,
          intervals: [2_000],
          message: 'local development never reached ready'
        })
        .toMatchObject({ phase: 'ready' })
    })

    await test.step('the workspace on disk is a real cinna-cli account workspace', async () => {
      const final = await cinna.page.evaluate(() => window.api.localDev.getState())
      expect(final.phase).toBe('ready')
      const workspacePath = (final as { workspacePath: string }).workspacePath

      // Inside the sandbox HOME, never the developer's own agents folder.
      expect(workspacePath.startsWith(cinna.sandbox.home)).toBe(true)
      expect(workspacePath.endsWith(join('Cloud', host.replace(/:/g, '_')))).toBe(true)

      // The file cinna-cli owns. The desktop only ever asks whether it exists;
      // reading it here is the test proving the setup token was really
      // exchanged, which is the whole point of removing the second login.
      const accountConfig = join(workspacePath, '.cinna', 'account.json')
      expect(existsSync(accountConfig)).toBe(true)
      const parsed = JSON.parse(readFileSync(accountConfig, 'utf8')) as {
        account_token?: string
        platform_url?: string
      }
      expect(parsed.account_token).toBeTruthy()
      expect(parsed.platform_url).toBeTruthy()

      // The toolchain is the app's, under userData, and nowhere else.
      const cinnaBin = (final as { cinnaBinPath: string }).cinnaBinPath
      expect(cinnaBin.startsWith(join(cinna.sandbox.userData, 'localdev'))).toBe(true)
      expect(existsSync(cinnaBin)).toBe(true)

      // And it is the version the *server* pinned, not one the desktop chose.
      const cliVersion = (final as { cliVersion: string }).cliVersion
      expect(cliVersion).toContain(discovery.local_dev!.cinna_cli_version)

      // Which protocol the run settled on is not asserted — the server picks
      // the cinna-cli version, so both `json` and `legacy` are correct answers
      // and pinning one here would make this spec fail on a change to a
      // different repository's configuration. It is recorded instead, because
      // "which surface did the pinned cinna-cli actually have" is the single
      // most useful line in the report when this run is investigated.
      const protocol = (final as { protocol: string }).protocol
      expect(['json', 'legacy']).toContain(protocol)
      test.info().annotations.push({
        type: 'protocol',
        description: `cinna-cli ${cliVersion} exposed the "${protocol}" surface`
      })
    })

    await test.step('a restart finds it ready without doing the work again', async () => {
      await cinna.relaunch()
      await expect
        .poll(() => cinna.page.evaluate(() => window.api.localDev.getState()), {
          timeout: 180_000,
          intervals: [2_000],
          message: 'a second launch did not settle on ready'
        })
        .toMatchObject({ phase: 'ready' })
    })
  })
})
