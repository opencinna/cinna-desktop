import { rmSync } from 'node:fs'
import { launch, makeSandbox } from './fixtures/app'
import { cacheEngineFrom, cachedEngineBinary, hasCachedEngine } from './fixtures/engine-cache'

/**
 * Make sure the pinned engine binary is in the per-machine cache before any
 * spec runs. Done through the app, not a hand-rolled download: the app pins
 * the version, records the SHA-256, verifies and unpacks — the cache holds
 * what a real first run would have produced.
 *
 * `CINNA_E2E_SKIP_ENGINE=1` skips this (no network); specs that opt into the
 * engine then fail with a message naming the cache path.
 */
export default async function globalSetup(): Promise<void> {
  if (hasCachedEngine() || process.env.CINNA_E2E_SKIP_ENGINE === '1') return
  const started = Date.now()
  console.log(`[e2e] no cached engine at ${cachedEngineBinary()}; letting the app download it once`)
  const sandbox = makeSandbox()
  const { electronApp, page } = await launch(sandbox)
  try {
    const skip = page.getByRole('button', { name: 'Skip for now' })
    await skip.waitFor({ timeout: 60_000 })
    await skip.click()
    // Resolves the binary (download + verify + publish) before it touches
    // config; a failure after that point does not matter here.
    const state = await page.evaluate(() => window.api.engine.start().catch((err: Error) => ({ error: err.message })))
    console.log(`[e2e] engine start result: ${JSON.stringify(state)}`)
    cacheEngineFrom(sandbox.userData)
    console.log(`[e2e] engine cached in ${Math.round((Date.now() - started) / 1000)} s`)
  } finally {
    await electronApp.close()
    rmSync(sandbox.root, { recursive: true, force: true })
  }
}
