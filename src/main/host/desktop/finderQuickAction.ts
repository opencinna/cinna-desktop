/**
 * The "Mention in Cinna" Finder Quick Action: install, update and remove the
 * Automator workflow bundle in `~/Library/Services`.
 *
 * ## What is installed
 *
 * A copy of `resources/finder/Mention in Cinna.workflow` (shipped at
 * `Resources/finder/` in a packaged app, read from the repo in development)
 * with one token replaced: the Run Shell Script action's command. The command
 * hands the selected paths to Cinna with `open`, which delivers them through
 * Electron's `open-file` event — never through a `cinna://` URL, so a web page
 * has no way to reach the path funnel.
 *
 * - Packaged: `open -b <bundle id> "$@"`, so moving the app does not break it.
 * - `npm run dev`: `open -a '<the running Electron.app>' "$@"`.
 *
 * The bundle is ours by exact path only. Uninstall looks before it deletes and
 * removes that one directory, nothing around it.
 *
 * `os.homedir()` rather than Electron's `home` path so the E2E suite's
 * throwaway `HOME` is respected.
 */

import { execFile } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { createLogger } from '../../logger/logger'
import {
  APP_BUNDLE_ID,
  type FinderQuickActionResult,
  type FinderQuickActionStatus
} from '../../../shared/finderQuickAction'

const logger = createLogger('finder-quick-action')

export const QUICK_ACTION_BUNDLE_NAME = 'Mention in Cinna.workflow'
/** The placeholder in the template's `COMMAND_STRING`. */
export const COMMAND_TOKEN = '__CINNA_COMMAND__'
const PBS_PATH = '/System/Library/CoreServices/pbs'
const VERSION_KEY = /<key>CinnaQuickActionVersion<\/key>\s*<string>([^<]*)<\/string>/
const COMMAND_VALUE = /<key>COMMAND_STRING<\/key>\s*<string>([^<]*)<\/string>/

export interface FinderQuickActionDeps {
  platform: NodeJS.Platform
  home(): string
  /** The template bundle directory. */
  templateDir(): string
  /** The shell command the action runs, unescaped. */
  command(): string
  /** Ask macOS to re-read the Services menu. Best-effort. */
  refreshServices(): Promise<void>
}

/** Quote one shell word for zsh: single quotes, with `'` spelled `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Escape text for a plist `<string>`. */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * The `.app` bundle a binary lives in (`…/Electron.app/Contents/MacOS/Electron`
 * → `…/Electron.app`), or null when it is not inside one.
 */
export function appBundleOf(execPath: string): string | null {
  const at = execPath.lastIndexOf('.app/')
  return at === -1 ? null : execPath.slice(0, at + 4)
}

/** The command for this process: the bundle id when packaged, the running Electron.app under `npm run dev`. */
export function quickActionCommand(input: { defaultApp: boolean; execPath: string }): string {
  if (input.defaultApp) {
    const bundle = appBundleOf(input.execPath)
    if (bundle) return `open -a ${shellQuote(bundle)} "$@"`
  }
  return `open -b ${APP_BUNDLE_ID} "$@"`
}

/** The template's `document.wflow` with the command substituted, or null when the token is missing. */
export function substituteCommand(document: string, command: string): string | null {
  if (!document.includes(COMMAND_TOKEN)) return null
  return document.split(COMMAND_TOKEN).join(xmlEscape(command))
}

function readVersion(bundle: string): string | null {
  try {
    return VERSION_KEY.exec(readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8'))?.[1] ?? null
  } catch {
    return null
  }
}

function readCommand(bundle: string): string | null {
  try {
    return COMMAND_VALUE.exec(readFileSync(join(bundle, 'Contents', 'document.wflow'), 'utf8'))?.[1] ?? null
  } catch {
    return null
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The sentence Settings shows for a failed install or removal: what the user
 * can act on, never Node's message or an absolute path (the raw error is
 * logged instead).
 */
export function quickActionErrorMessage(err: unknown, action: 'install' | 'remove'): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST' || code === 'ENOTDIR') return '~/Library/Services isn’t a folder.'
  if (code === 'EACCES' || code === 'EPERM') return 'Cinna can’t write to ~/Library/Services.'
  return action === 'install' ? 'Could not install the Quick Action.' : 'Could not remove the Quick Action.'
}

export function createFinderQuickAction(deps: FinderQuickActionDeps) {
  const installedPath = (): string => join(deps.home(), 'Library', 'Services', QUICK_ACTION_BUNDLE_NAME)

  function status(): FinderQuickActionStatus {
    if (deps.platform !== 'darwin') return { supported: false, installed: false, outdated: false }
    const target = installedPath()
    if (!existsSync(target)) return { supported: true, installed: false, outdated: false }
    const outdated =
      readVersion(target) !== readVersion(deps.templateDir()) ||
      readCommand(target) !== xmlEscape(deps.command())
    return { supported: true, installed: true, outdated }
  }

  function unsupported(): FinderQuickActionResult {
    return { success: false, error: 'Finder Quick Actions are only available on macOS.', status: status() }
  }

  async function refresh(): Promise<void> {
    try {
      await deps.refreshServices()
    } catch (err) {
      logger.debug('refreshing the Services menu failed', { error: errorText(err) })
    }
  }

  return {
    installedPath,
    status,

    /** Copy the template over whatever is installed, then substitute the command. */
    async install(): Promise<FinderQuickActionResult> {
      if (deps.platform !== 'darwin') return unsupported()
      const target = installedPath()
      try {
        const document = readFileSync(join(deps.templateDir(), 'Contents', 'document.wflow'), 'utf8')
        const substituted = substituteCommand(document, deps.command())
        if (substituted === null) throw new Error('the Quick Action template has no command placeholder')
        mkdirSync(join(deps.home(), 'Library', 'Services'), { recursive: true })
        rmSync(target, { recursive: true, force: true })
        cpSync(deps.templateDir(), target, { recursive: true })
        writeFileSync(join(target, 'Contents', 'document.wflow'), substituted)
      } catch (err) {
        logger.warn('installing the Finder Quick Action failed', { error: errorText(err) })
        return { success: false, error: quickActionErrorMessage(err, 'install'), status: status() }
      }
      logger.info('Finder Quick Action installed', { path: target })
      await refresh()
      return { success: true, status: status() }
    },

    /** Remove the one bundle at the exact path, after checking it is a directory. */
    async uninstall(): Promise<FinderQuickActionResult> {
      if (deps.platform !== 'darwin') return unsupported()
      const target = installedPath()
      let entry: Stats
      try {
        entry = lstatSync(target)
      } catch {
        return { success: true, status: status() }
      }
      if (!entry.isDirectory()) {
        return {
          success: false,
          error: `~/Library/Services/${QUICK_ACTION_BUNDLE_NAME} isn’t a Quick Action; Cinna left it in place.`,
          status: status()
        }
      }
      try {
        rmSync(target, { recursive: true })
      } catch (err) {
        logger.warn('removing the Finder Quick Action failed', { error: errorText(err) })
        return { success: false, error: quickActionErrorMessage(err, 'remove'), status: status() }
      }
      logger.info('Finder Quick Action removed', { path: target })
      await refresh()
      return { success: true, status: status() }
    }
  }
}

function bundledTemplateDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'finder', QUICK_ACTION_BUNDLE_NAME)
    : join(app.getAppPath(), 'resources', 'finder', QUICK_ACTION_BUNDLE_NAME)
}

function runPbsUpdate(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(PBS_PATH, ['-update'], { timeout: 10_000, windowsHide: true }, (error) => (error ? reject(error) : resolve()))
  })
}

export const finderQuickAction = createFinderQuickAction({
  platform: process.platform,
  home: homedir,
  templateDir: bundledTemplateDir,
  command: () => quickActionCommand({ defaultApp: process.defaultApp === true, execPath: process.execPath }),
  refreshServices: runPbsUpdate
})
