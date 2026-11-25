/**
 * The E2E harness's fast startup splash (`hooks/useStartupSplash.ts`).
 *
 * Main reads `CINNA_STARTUP_SPLASH=fast` from its environment and, only in an
 * unpackaged build, passes this switch to the main window's renderer through
 * `webPreferences.additionalArguments`; the sandboxed preload finds it in
 * `process.argv` and exposes `window.api.app.startupSplashFast`. With it the
 * splash ends as soon as the window is visible and painted: no hold, no reveal.
 */
export const STARTUP_SPLASH_FAST_ARG = '--cinna-startup-splash=fast'

/** The renderer arguments for the main window. Never anything in a packaged build. */
export function startupSplashArgs(
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean
): string[] {
  return !isPackaged && env['CINNA_STARTUP_SPLASH'] === 'fast' ? [STARTUP_SPLASH_FAST_ARG] : []
}
