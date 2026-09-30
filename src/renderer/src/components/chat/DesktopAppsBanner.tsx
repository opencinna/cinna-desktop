import { Info, Loader2, X } from 'lucide-react'
import {
  DESKTOP_APP_BUTTON_LABEL,
  DESKTOP_APP_PHASE_LABEL,
  desktopAppsBannerText,
  visibleDesktopApps
} from '../../../../shared/desktopApps'
import { useDesktopAppConnect, useDesktopAppRunning, useDesktopApps } from '../../hooks/useDesktopApps'
import { useDefaultRuntime } from '../../hooks/useEngine'
import { useDefaultChatMode } from '../../hooks/useChatModes'
import { useAppSettings } from '../../hooks/useAppSettings'
import { useDesktopAppsStore } from '../../stores/desktopApps.store'
import { unwrapIpcError } from '../../utils/ipcError'

const FAILED = "Couldn't set it up."

/**
 * **"Claude Desktop is installed — use your subscription here."** The offer at
 * the top of the new-chat screen, for a Mac that has Claude Desktop or the
 * ChatGPT app: one button per app installs the pinned CLI if needed, signs in
 * if needed and makes that engine the Default runtime (main does all of it —
 * see `desktopAppConnectService`).
 *
 * Absolutely positioned over the top of the screen, so appearing, changing
 * phase or going away never moves the composer below. Renders nothing — no
 * reserved space — when there is nothing to offer: every detected app
 * dismissed, or already the Default runtime.
 */
export function DesktopAppsBanner(): React.JSX.Element | null {
  const { data: detected } = useDesktopApps()
  const { data: defaultRuntime } = useDefaultRuntime()
  const defaultMode = useDefaultChatMode()
  const settings = useAppSettings()
  const dismissed = useDesktopAppsStore((state) => state.dismissed)
  const dismiss = useDesktopAppsStore((state) => state.dismiss)
  const connect = useDesktopAppConnect()
  const running = useDesktopAppRunning(connect.isPending)

  // Held until the Default runtime and the default chat mode are known (the
  // latter needs the settings for account-default precedence): offering an
  // app that turns out to be in use already would show a banner and then take
  // it away.
  if (!detected || !defaultRuntime || !defaultMode.isSuccess || !settings.isSuccess) return null
  const apps = visibleDesktopApps(detected, dismissed, defaultRuntime.engine, defaultMode.data?.engine ?? null)
  if (apps.length === 0) return null

  const activeAppId = running.data?.appId ?? (connect.isPending ? connect.variables.appId : null)
  const phase = running.data?.phase ?? (connect.isPending ? 'installing' : null)
  const busy = activeAppId !== null
  const activeApp = detected.find((app) => app.id === activeAppId) ?? null
  const shownIds = apps.map((app) => app.id)

  const failure = connect.isPending
    ? null
    : connect.error
      ? unwrapIpcError(connect.error, FAILED)
      : connect.data?.outcome === 'failed'
        ? (connect.data.reason ?? FAILED)
        : null

  return (
    <div className="pointer-events-none absolute inset-x-0 top-[calc(var(--topbar-h)+0.75rem)] z-10 flex justify-center px-4">
      <section
        role="region"
        aria-label="Detected apps"
        className="pointer-events-auto w-full max-w-2xl rounded-lg border border-[var(--color-severity-info)]/40 bg-[var(--color-bg-secondary)] px-3 py-2.5"
      >
        <div className="flex items-start gap-2">
          <Info size={14} className="mt-px shrink-0 text-[var(--color-severity-info-text)]" aria-hidden />
          <p className="flex-1 min-w-0 text-xs text-[var(--color-text)]">{desktopAppsBannerText(apps)}</p>
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            disabled={busy}
            onClick={() => dismiss(shownIds)}
            className="shrink-0 p-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <X size={14} />
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2 pl-[22px]">
          {apps.map((app) => {
            const pressed = app.id === activeAppId
            return (
              <button
                key={app.id}
                type="button"
                disabled={busy}
                onClick={() => connect.mutate({ appId: app.id, shownIds })}
                className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-white bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] transition-colors disabled:cursor-not-allowed ${
                  pressed ? '' : 'disabled:opacity-30'
                }`}
              >
                {pressed && phase ? (
                  <>
                    <Loader2 size={12} className="animate-spin" aria-hidden />
                    {DESKTOP_APP_PHASE_LABEL[phase]}
                  </>
                ) : (
                  DESKTOP_APP_BUTTON_LABEL[app.id]
                )}
              </button>
            )
          })}
          {phase === 'signing-in' && activeApp && (
            <button
              type="button"
              onClick={() => void window.api.localTools.engineLoginCancel(activeApp.engine).catch(() => false)}
              className="shrink-0 px-1.5 py-1 text-xs font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
            >
              Cancel
            </button>
          )}
          {/* On the button row, not under it: the banner overlays the logo on
              a short window, so a failure must not make it taller. */}
          {failure && (
            <p role="alert" title={failure} className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-danger)]">
              {failure}
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
