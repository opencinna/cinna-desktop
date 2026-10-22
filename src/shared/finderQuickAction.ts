/**
 * The "Mention in Cinna" Finder Quick Action, as Settings sees it. Failures
 * are data (`success: false`), never a throw: an error thrown across IPC loses
 * everything but its message prefix.
 */

/** The bundle id of the packaged app; must equal `appId` in electron-builder.yml (a unit test holds them together). */
export const APP_BUNDLE_ID = 'io.opencinna.desktop'

export interface FinderQuickActionStatus {
  /** macOS only. Elsewhere Settings shows nothing. */
  supported: boolean
  /** The workflow bundle is in `~/Library/Services`. */
  installed: boolean
  /** Installed, but from an older template or for a different app location. */
  outdated: boolean
}

export type FinderQuickActionResult =
  | { success: true; status: FinderQuickActionStatus }
  | { success: false; error: string; status: FinderQuickActionStatus }
