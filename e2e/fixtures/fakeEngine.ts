import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../playwright.config'
import type { CinnaApp } from './app'

/**
 * Run folder agents on `fakeEngine.mjs` instead of the real `opencode`.
 *
 * Through the product's own seam, not around it: the engine path a user can set
 * in Settings → Local Agents. The path is kept in the profile database, so it
 * survives `relaunch()`, and the engine manager does everything else exactly as
 * it would for a real binary — `--version` probe, config generation, loopback
 * port, spawn, health check, SIGTERM on quit.
 *
 * The path is a `/bin/sh` shim rather than the `.mjs` itself for two reasons:
 * the manager spawns the path directly, so it must be executable, and the
 * engine gets a *narrowed* environment in which `node` need not resolve — so
 * the shim names the exact node running this suite.
 *
 * Needs a credential with a model to run on, or the config generator skips the
 * agent and the turn fails with "not available in the running engine" before
 * any fake is reached.
 */
const FAKE_ENGINE = join(repoRoot, 'e2e', 'fixtures', 'fakeEngine.mjs')

export async function installFakeEngine(cinna: CinnaApp): Promise<string> {
  const shim = join(cinna.sandbox.root, 'fake-opencode')
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "1.18.27-e2e-fake"; exit 0; fi',
      `exec '${process.execPath}' '${FAKE_ENGINE}' "$@"`,
      ''
    ].join('\n')
  )
  chmodSync(shim, 0o755)
  await cinna.page.evaluate((path) => window.api.settings.set('localAgentsEnginePath', path), shim)
  return shim
}

/** One request the fake engine received, in arrival order. Never its headers. */
export interface FakeEngineCall {
  method: string
  path: string
  body?: unknown
}

/** Everything the fake engine has been asked so far, across restarts. */
export function fakeEngineCalls(cinna: CinnaApp): FakeEngineCall[] {
  const file = join(cinna.sandbox.userData, 'engine', 'fake-engine-calls.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as FakeEngineCall)
}
