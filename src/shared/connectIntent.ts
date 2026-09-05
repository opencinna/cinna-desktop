/**
 * The `cinna://connect?server=<origin>` deep link, as it crosses into the
 * renderer.
 *
 * A landing page on a self-hosted cinna-core instance fires this so a freshly
 * installed app knows which server it was downloaded for — the DMG cannot know
 * that by itself. The payload is deliberately tiny: an **origin** and when it
 * arrived. No token, no path, no query; the authorization that follows is the
 * ordinary desktop OAuth flow, unchanged.
 *
 * Whatever reaches the renderer here is **untrusted**: any process on the
 * machine can ask the OS to open a `cinna://` URL, and on Linux a mis-registered
 * handler can be pointed at one by a web page. So the renderer never acts on an
 * intent without showing the origin and getting an explicit confirmation, and
 * main never opens a browser for one on its own.
 */

export interface ConnectIntent {
  /**
   * The instance's origin — scheme, host and (only when non-default) port.
   * Already validated and normalized by the main process: `https` (or `http`
   * for loopback), no credentials, no path, no query.
   */
  serverUrl: string
  /** `Date.now()` when the intent arrived, so the UI can age a stale one out. */
  receivedAt: number
}

/** Main → renderer push when an intent arrives while a window is open. */
export const CONNECT_INTENT_CHANNEL = 'connect:intent'

/** The URL scheme registered with the OS. */
export const CONNECT_SCHEME = 'cinna'

/**
 * Test-only argv form of the same intent, for the E2E suite.
 *
 * A real `open-url` event cannot be raised from Playwright — macOS delivers it
 * through Launch Services, and there is no supported way to fake that against a
 * running app. This flag enters the *same* funnel as `open-url` and the argv
 * scan, so a spec that uses it exercises every line below the OS hook: the
 * validation, the buffer, the push, and the whole confirm step.
 */
export const CONNECT_INTENT_ARGV_FLAG = '--cinna-connect-intent='
