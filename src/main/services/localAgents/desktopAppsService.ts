/**
 * Which vendor **desktop apps** this Mac has — Claude Desktop, ChatGPT — so the
 * new-chat screen can offer to run chats and agents on the subscription the
 * user already pays for.
 *
 * ## Only the bundle is read
 *
 * A candidate is `<root>/<Name>.app`, and the one file opened is its own
 * `Contents/Info.plist`, checked for the vendor's bundle id. Nothing else:
 * never `~/Library/Containers`, another app's Application Support, or the
 * Keychain — any of those can raise a macOS privacy dialog, and a dialog on
 * launch is exactly what the bare-Mac check fails on. No `mdfind`, no
 * `plutil`, no shell: the id is looked for as bytes in the file, which holds
 * for an XML plist and for a binary one (whose strings are stored as ASCII).
 *
 * ## macOS only, memoized per launch
 *
 * Other platforms answer `[]`. The answer is kept for the process's life — an
 * app installed while Cinna runs shows up on the next launch.
 *
 * `CINNA_DESKTOP_APP_ROOTS` (a path-delimited list) replaces both the roots and
 * the platform check, so an E2E run can plant a fake bundle in its sandbox.
 */

import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createLogger } from '../../logger/logger'
import type { DesktopAppId, DetectedDesktopApp } from '../../../shared/desktopApps'
import type { EngineLoginId } from '../../../shared/engine'

const logger = createLogger('desktop-apps')

interface DesktopAppSpec {
  id: DesktopAppId
  label: string
  engine: EngineLoginId
  bundles: readonly string[]
  bundleIds: readonly string[]
}

/** Every desktop app the banner knows, in display order. */
export const DESKTOP_APP_SPECS: readonly DesktopAppSpec[] = [
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    engine: 'claude',
    bundles: ['Claude.app'],
    bundleIds: ['com.anthropic.claudefordesktop']
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    engine: 'codex',
    bundles: ['ChatGPT.app', 'Codex.app'],
    // The current ChatGPT.app ships as `com.openai.codex`.
    bundleIds: ['com.openai.chat', 'com.openai.codex']
  }
]

export interface DetectOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
}

/** The folders to look in, or null when this platform is not looked at. */
export function desktopAppRoots(options: DetectOptions = {}): string[] | null {
  const env = options.env ?? process.env
  const override = env['CINNA_DESKTOP_APP_ROOTS']
  if (override !== undefined && override.trim() !== '') {
    return override.split(delimiter).map((root) => root.trim()).filter(Boolean)
  }
  if ((options.platform ?? process.platform) !== 'darwin') return null
  return ['/Applications', join(options.home ?? homedir(), 'Applications')]
}

/** Whether `<bundle>/Contents/Info.plist` names one of the ids. Never throws. */
async function bundleMatches(bundle: string, bundleIds: readonly string[]): Promise<boolean> {
  try {
    const info = await stat(bundle)
    if (!info.isDirectory()) return false
    const plist = await readFile(join(bundle, 'Contents', 'Info.plist'))
    return bundleIds.some((id) => plist.includes(Buffer.from(id, 'utf8')))
  } catch {
    return false
  }
}

/** One pass over the roots. Not memoized — {@link desktopAppsService.list} is. */
export async function detectDesktopApps(options: DetectOptions = {}): Promise<DetectedDesktopApp[]> {
  const roots = desktopAppRoots(options)
  if (!roots) return []
  const found: DetectedDesktopApp[] = []
  for (const spec of DESKTOP_APP_SPECS) {
    const candidates = roots.flatMap((root) => spec.bundles.map((bundle) => join(root, bundle)))
    for (const candidate of candidates) {
      if (await bundleMatches(candidate, spec.bundleIds)) {
        found.push({ id: spec.id, label: spec.label, engine: spec.engine })
        break
      }
    }
  }
  return found
}

let memo: Promise<DetectedDesktopApp[]> | null = null

export const desktopAppsService = {
  /** The desktop apps on this machine, detected once per launch. Never rejects. */
  list(): Promise<DetectedDesktopApp[]> {
    return (memo ??= detectDesktopApps().then(
      (apps) => {
        logger.info('desktop apps detected', { apps: apps.map((app) => app.id) })
        return apps
      },
      (err: unknown) => {
        logger.warn('desktop app detection failed', {
          error: err instanceof Error ? err.message : String(err)
        })
        return []
      }
    ))
  },

  /** Tests only: forget the memoized answer. */
  resetForTests(): void {
    memo = null
  }
}
