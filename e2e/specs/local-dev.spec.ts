import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * Local development (`src/main/localdev/localDevService.ts`), as far as a
 * suite with no Cinna server can honestly go.
 *
 * The reconciler only leaves `idle` for a profile that is a `cinna_user` with a
 * server URL: it then fetches `/.well-known/cinna-desktop`, mints a cinna-cli
 * setup token with that profile's OAuth bearer, and installs a toolchain. None
 * of that can be arranged here — a Cinna profile is created by a browser OAuth
 * round trip against a real instance, and the suite has neither. So what is
 * tested is the half that is reachable: the state a profile without a Cinna
 * account is in, the fact that the UI says nothing about it, and the one piece
 * of local-dev state that *is* written on this machine — the per-host consent
 * answer, which is an app setting and must survive a restart.
 */

const HOST = 'cinna.example.com'

const IDLE_LINE =
  'Nothing has been checked yet. Local development applies to Cinna accounts — sign in to one and Cinna checks what that server offers.'

/** Open Settings → Local Development through the UI. */
async function openLocalDevSettings(cinna: CinnaApp): Promise<void> {
  // The default profile's display name is generated per install, so the user
  // menu's trigger (a `title`-named avatar button) has to be looked up rather
  // than hardcoded.
  const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
  const name = user?.displayName ?? 'User'
  await cinna.page.getByRole('button', { name, exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Local Development', exact: true }).click()
}

test('a profile with no Cinna account is idle, and nothing in the UI mentions local dev', async ({
  cinna
}) => {
  await cinna.skipOnboarding()
  const { page } = cinna

  // `idle` is "we have not looked", which is what a local profile is: the
  // reconciler returns before touching the network for anything that is not a
  // Cinna account.
  expect(await page.evaluate(() => window.api.localDev.getState())).toEqual({ phase: 'idle' })

  // The footer indicator has exactly two visible states — working, and needs
  // attention. Neither is this one.
  await expect(page.getByLabel('Setting up local development')).toHaveCount(0)
  await expect(page.getByLabel('Local development needs attention')).toHaveCount(0)

  // Settings is the one screen that renders every phase, so `idle` has to say
  // why there is nothing to do rather than showing an empty card.
  await openLocalDevSettings(cinna)
  await expect(page.getByRole('heading', { name: 'Local Development', exact: true })).toBeVisible()
  await expect(page.getByText(IDLE_LINE, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Set up local development' })).toHaveCount(0)
})

test('a declined local-dev consent is remembered across a restart', async ({ cinna }) => {
  await cinna.skipOnboarding()

  // `false` is remembered on purpose: the prompt must not come back every
  // launch. The reconcile it triggers answers `idle` here — there is no Cinna
  // profile — but the answer is still written.
  const after = await cinna.page.evaluate(
    (host) => window.api.localDev.consent(host, false),
    HOST
  )
  expect(after).toEqual({ phase: 'idle' })
  expect(await cinna.page.evaluate(() => window.api.localDev.getConsent())).toEqual({
    [HOST]: false
  })

  await cinna.relaunch()
  await cinna.skipOnboarding()

  // It lives in the `localDevConsent` app setting, so a new process must read
  // the same answer back rather than asking again.
  expect(await cinna.page.evaluate(() => window.api.localDev.getConsent())).toEqual({
    [HOST]: false
  })

  // And forgetting it is a real undo, not a second `false`.
  await cinna.page.evaluate((host) => window.api.localDev.resetConsent(host), HOST)
  expect(await cinna.page.evaluate(() => window.api.localDev.getConsent())).toEqual({})
})

/*
 * "The reconciler brings a Cinna profile to ready" was a `test.fixme` here,
 * because it needs a real cinna-core and a profile holding live OAuth tokens
 * and this file must run on a machine with neither.
 *
 * It is now `cinna-integration.spec.ts`, run by `make e2e-integration` against
 * a server named in `.env` — it asserts exactly what the fixme described
 * (`consent` for the instance host, then `ready` at `<AgentsHome>/Cloud/<host>`
 * with a real account token on disk) and rather more besides. The note stays
 * here so the next person reading this file finds the coverage rather than
 * concluding there is none.
 */
