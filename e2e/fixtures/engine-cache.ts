import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PINNED_ENGINE_VERSION } from '../../src/shared/engine'

/**
 * The engine binary (`opencode`) folder agents run on, at the version this
 * build pins, held once per machine outside any sandbox.
 *
 * The cache is filled by the app itself (see `global-setup.ts`): the app
 * downloads the pinned release into a throwaway profile, verifies the SHA-256
 * it records, unpacks it, and the resulting `opencode-<version>/` tree is
 * copied out. A test that opts in gets that tree copied into its sandbox's
 * `userData/engine/` before launch, which is exactly what a real install looks
 * like after its first download — the app then resolves it as `managed`.
 */
export const ENGINE_VERSION = PINNED_ENGINE_VERSION

export function engineCacheRoot(): string {
  return process.env.CINNA_E2E_ENGINE_CACHE ?? join(homedir(), '.cache', 'cinna-e2e', 'engine')
}

/** `<cache>/opencode-<version>` — the same folder name the app publishes. */
export function cachedEngineDir(): string {
  return join(engineCacheRoot(), `opencode-${ENGINE_VERSION}`)
}

export function cachedEngineBinary(): string {
  return join(cachedEngineDir(), process.platform === 'win32' ? 'opencode.exe' : 'opencode')
}

export function hasCachedEngine(): boolean {
  return existsSync(cachedEngineBinary())
}

/** Copy the cached tree into a sandbox's `userData/engine/`. */
export function installCachedEngine(userData: string): void {
  if (!hasCachedEngine()) {
    throw new Error(
      `No cached engine at ${cachedEngineBinary()}. The Playwright global setup fills it; ` +
        'run the suite once with network, or set CINNA_E2E_ENGINE_CACHE to a filled cache.'
    )
  }
  const root = join(userData, 'engine')
  mkdirSync(root, { recursive: true })
  cpSync(cachedEngineDir(), join(root, `opencode-${ENGINE_VERSION}`), { recursive: true })
}

/** Copy a freshly published tree out of a sandbox into the cache. */
export function cacheEngineFrom(userData: string): void {
  const published = join(userData, 'engine', `opencode-${ENGINE_VERSION}`)
  if (!existsSync(join(published, process.platform === 'win32' ? 'opencode.exe' : 'opencode'))) {
    throw new Error(`the app did not publish an engine at ${published}`)
  }
  mkdirSync(engineCacheRoot(), { recursive: true })
  cpSync(published, cachedEngineDir(), { recursive: true })
}
