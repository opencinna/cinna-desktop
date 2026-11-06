/**
 * The dashboard design pack: the desktop's own stylesheet, chart helper and
 * guide for an `html` dashboard component, so a page looks like the app in
 * both themes whichever engine built it. Desktop-owned (`resources/dashboard-design/`),
 * not part of the kit bundle, which only `make kit-sync` writes.
 *
 * Served to every dashboard frame at the reserved `…/<tile>/_cinna/<file>`
 * (`dashboardFrameServer`), named to kit agents by absolute path in the
 * dashboards prompt section (`dashboardsSkill.ts`).
 *
 * Packaged it ships through `extraResources` as `Resources/dashboard-design`, a
 * real directory kept out of the asar; in development it is read from the
 * repo — the same rule as the bundled kit (`kit/contractStore.ts`).
 *
 * Core module: no Electron.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { runtimeHost } from '../../host/runtimeHost'

const PACK_DIR = 'dashboard-design'

/** The reserved folder a frame's page links the pack from: `_cinna/ui.css`, `_cinna/charts.js`. */
export const DESIGN_PACK_SEGMENT = '_cinna'

/** The only files served under `_cinna/`; anything else there is a 404. */
export const DESIGN_PACK_FILES: ReadonlySet<string> = new Set(['ui.css', 'charts.js'])

const GUIDE_FILE = 'DESIGN.md'
const EXAMPLE_DIR = 'example'

/** Where the pack is in this build (it may be missing from a broken install). */
export function getDashboardDesignDir(): string {
  return runtimeHost.isPackaged
    ? join(runtimeHost.resourcesPath, PACK_DIR)
    : join(runtimeHost.getAppPath(), 'resources', PACK_DIR)
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export interface DashboardDesignGuide {
  /** `DESIGN.md`, absolute. */
  guide: string
  /** The example component folder an agent copies to start, absolute. */
  example: string
}

/** The guide and the example, when this build has both; null otherwise. Never throws. */
export function dashboardDesignGuide(dir: string = getDashboardDesignDir()): DashboardDesignGuide | null {
  try {
    const guide = join(dir, GUIDE_FILE)
    const example = join(dir, EXAMPLE_DIR)
    return isFile(guide) && isDir(example) ? { guide, example } : null
  } catch {
    return null
  }
}

/**
 * The pack's folder, for the engines' read allowances, exactly when the
 * prompt names its guide and example ({@link dashboardDesignGuide}); null
 * otherwise. Read and copied from, never written: Antigravity's own-command
 * rule (`OwnCommandPolicy.dashboardsDesign`), OpenCode's `external_directory`
 * allow (`EngineAgentInput.dashboardsDesignPath`) and Claude's scoped `Read`
 * rule (`claudeDesignPackReadRule`). Never throws.
 */
export function dashboardDesignReadDir(dir: string = getDashboardDesignDir()): string | null {
  try {
    return dashboardDesignGuide(dir) ? dir : null
  } catch {
    return null
  }
}
