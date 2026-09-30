import { Info, Loader2, X } from 'lucide-react'
import {
  DESKTOP_APP_BUTTON_LABEL,
  DESKTOP_APP_PHASE_LABEL,
  desktopAppsBannerText,
  hasWorkingRuntime,
  visibleDesktopApps
} from '../../../../shared/desktopApps'
import { isCredentialActive } from '../../../../shared/credentials'
import { useDesktopAppConnect, useDesktopAppRunning, useDesktopApps } from '../../hooks/useDesktopApps'
import { useClaudeBinary, useCodexBinary, useDefaultRuntime } from '../../hooks/useEngine'
import { useClaudeAuth, useCodexAuth, useLocalTools } from '../../hooks/useLocalTools'
import { useProviders } from '../../hooks/useProviders'
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
 * dismissed, or something already works (`hasWorkingRuntime`). The offer is
 * for a Mac with no runtime yet, not a nudge to move a working one.
 */
export function DesktopAppsBanner(): React.JSX.Element | null {
  const { data: detected } = useDesktopApps()
  const { data: defaultRuntime } = useDefaultRuntime()
  const providers = useProviders()
  const dismissed = useDesktopAppsStore((state) => state.dismissed)
  const dismiss = useDesktopAppsStore((state) => state.dismiss)
  const connect = useDesktopAppConnect()
  const running = useDesktopAppRunning(connect.isPending)

  const apps = detected ? visibleDesktopApps(detected, dismissed) : []
  const hasActiveCredential = providers.data?.some(isCredentialActive) ?? false
  // OpenCode with a credential settles it without asking a CLI anything; only
  // otherwise are the logins probed — `claude auth status` is a process, and it
  // polls while signed out.
  const needsCli =
    apps.length > 0 && !!defaultRuntime && providers.isSuccess &&
    !(defaultRuntime.engine === 'opencode' && hasActiveCredential)
  const claudeAuth = useClaudeAuth({ enabled: needsCli })
  const codexAuth = useCodexAuth({ enabled: needsCli })
  const claudeBinary = useClaudeBinary({ enabled: needsCli })
  const codexBinary = useCodexBinary({ enabled: needsCli })
  // A user's own `claude`/`codex` on PATH at another version than the pin is
  // not the binary the probe asks (that stays `unresolved` until a turn fetches
  // the pin), yet its login is the one the pin would use — it follows HOME.
  const tools = useLocalTools()

  const activeAppId = running.data?.appId ?? (connect.isPending ? connect.variables.appId : null)
  const phase = running.data?.phase ?? (connect.isPending ? 'installing' : null)
  const busy = activeAppId !== null
  const failure = connect.isPending
    ? null
    : connect.error
      ? unwrapIpcError(connect.error, FAILED)
      : connect.data?.outcome === 'failed'
        ? (connect.data.reason ?? FAILED)
        : null

  // Held until every fact is known, so an offer never shows and is then
  // withdrawn. A connect in flight, or one that just failed, keeps the banner:
  // its login may already count as working before adopt has run.
  if (apps.length === 0 || !defaultRuntime || !providers.isSuccess) return null
  if (!busy && !failure) {
    if (needsCli && (!claudeAuth.data || !codexAuth.data || !claudeBinary.data || !codexBinary.data || !tools.data)) return null
    const onPath = (id: 'claude' | 'codex'): boolean => tools.data?.some((tool) => tool.id === id && tool.available) ?? false
    const working = hasWorkingRuntime({
      defaultEngine: defaultRuntime.engine,
      hasActiveCredential,
      cli: {
        claude: { auth: claudeAuth.data?.state ?? 'unknown', installed: claudeBinary.data?.state === 'ready' || onPath('claude') },
        codex: { auth: codexAuth.data?.state ?? 'unknown', installed: codexBinary.data?.state === 'ready' || onPath('codex') }
      }
    })
    if (working) return null
  }

  const activeApp = detected?.find((app) => app.id === activeAppId) ?? null
  const shownIds = apps.map((app) => app.id)

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
