/**
 * Loaded into the app's main process as `-r <this file>` (the fixture's
 * `mainRequire` option, `live-mcp-oauth.spec.ts`), so it is in place
 * **before** the app's own startup code runs.
 *
 * An `electronApp.evaluate` stub comes too late for anything main does at
 * startup: Playwright releases `ready` inside `electron.launch()`, and the
 * enabled MCP connectors connect right after it. A connector whose stored
 * sign-in failed would then open the developer's real browser. Here every
 * `shell.openExternal` of the process is recorded in
 * `globalThis.__cinnaOpenedUrls` instead, and no browser ever opens.
 *
 * `require('electron')` is not the Electron API yet while `-r` preloads run
 * (it resolves the npm package), so the patch waits one tick — still before
 * the app's main module and long before `ready`.
 */
if (process.versions.electron && process.type === 'browser') {
  globalThis.__cinnaOpenedUrls = []
  process.nextTick(() => {
    const { shell } = require('electron')
    shell.openExternal = async (url) => {
      globalThis.__cinnaOpenedUrls.push(String(url))
    }
    globalThis.__cinnaOpenExternalRecorded = true
  })
}
