import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../playwright.config'
import type { CinnaApp } from './app'

/** Install the scripted conductor over real ACP/MCP; kit specialists keep their own fixture. */
export async function installConductorAcpEngine(cinna: CinnaApp, host: string, folderShim?: string): Promise<void> {
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
  const shim = join(cinna.sandbox.root, 'conductor-fake-opencode')
  writeFileSync(shim, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "1.18.27-e2e-fake"; exit 0; fi',
    // Synthetic conductors own bare instruction folders; a scaffolded kit's
    // manifest remains the product's distinguishing feature on disk.
    ...(folderShim ? [`if [ -f cinna-agent.json ]; then exec ${quote(folderShim)} "$@"; fi`] : []),
    `export CONDUCTOR_ACP_CONTROLLER=${quote(host)}`,
    `exec ${quote(process.execPath)} ${quote(join(repoRoot, 'e2e/fixtures/conductorAcpAgent.mjs'))} "$@"`, ''
  ].join('\n'))
  chmodSync(shim, 0o755)
  await cinna.page.evaluate((path) => window.api.settings.set('localAgentsEnginePath', path), shim)
}
