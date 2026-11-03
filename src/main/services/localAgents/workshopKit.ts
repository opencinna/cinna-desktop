/**
 * The workshop kit an agent folder sits under: `../../.cinna-kit` from it — the
 * path a kit agent's `AGENTS.md` names — when a kit copy is really there
 * (`kit.json`). An external root has none. Read by the OpenCode permission
 * profile (`workshopKitPath`) and Antigravity's own-command rule
 * (`OwnCommandPolicy.workshopKit`), so a building agent reads the kit's guides
 * without a permission ask per file.
 *
 * Core: no Electron.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** As `agentsHomeService` installs it. */
export const WORKSHOP_KIT_DIR = '.cinna-kit'

export function workshopKitOf(agentPath: string): string | null {
  const kit = join(agentPath, '..', '..', WORKSHOP_KIT_DIR)
  try {
    return existsSync(join(kit, 'kit.json')) ? kit : null
  } catch {
    return null
  }
}
