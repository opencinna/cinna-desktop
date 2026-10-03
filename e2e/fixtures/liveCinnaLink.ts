import type { CinnaApp } from './app'
import { liveCinnaConfig, preflight, signIn, type LiveCinnaConfig } from './liveCinna'

/**
 * Linking a sandbox profile to a **real** cinna-core without the browser.
 *
 * `cinna-integration.spec.ts` signs in through the real OAuth flow, which
 * installs a toolchain on the way. A spec that only needs the profile to *be*
 * a Cinna account — so the cloud task adapter has a server and a bearer — takes
 * the owner JWT from `/api/v1/login/access-token` and writes it into the
 * sandbox's `users` row, encrypted with the app's own `safeStorage` (the mock
 * keychain the fixture launches with). The pattern of the handover-bus live
 * probe. `relaunch()` afterwards, so the renderer's auth store reads it.
 *
 * The token is never printed. The expiry is an hour out, so the app never
 * tries to refresh it with the (same) token in the refresh slot.
 */
export async function linkLiveCinnaProfile(cinna: CinnaApp, config: LiveCinnaConfig, token: string): Promise<void> {
  const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
  if (!user) throw new Error('no active profile to link')
  await cinna.electronApp.evaluate(({ app, safeStorage }, input) => {
    if (app.getPath('userData') !== input.userData) throw new Error('Not the isolated test profile')
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${input.userData}/cinna.db`, { fileMustExist: true })
    try {
      const sealed = safeStorage.encryptString(input.token)
      db.prepare(`UPDATE users SET type = 'cinna_user', cinna_server_url = ?,
        cinna_access_token_enc = ?, cinna_refresh_token_enc = ?, cinna_token_expires_at = ?
        WHERE id = ?`).run(input.host, sealed, sealed, Date.now() + 3_600_000, input.userId)
    } finally { db.close() }
  }, { host: config.serverUrl, token, userId: user.id, userData: cinna.sandbox.userData })
}

/** The configured core, a reachable discovery document and a signed-in owner token — or a reason to skip. */
export async function liveCoreSession(): Promise<
  { ok: true; config: LiveCinnaConfig; token: string } | { ok: false; reason: string }
> {
  const config = liveCinnaConfig()
  if (!config) return { ok: false, reason: 'no live cinna-core configured — set CINNA_E2E_SERVER_URL / _EMAIL / _PASSWORD in .env' }
  const checked = await preflight(config)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  try {
    return { ok: true, config, token: await signIn(config) }
  } catch (error) {
    return { ok: false, reason: String(error) }
  }
}

/** One authenticated JSON call to the core's API. */
export async function coreApi(
  config: LiveCinnaConfig,
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${config.serverUrl}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}
