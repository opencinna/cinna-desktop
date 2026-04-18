import { useUIStore } from '../../stores/ui.store'

export function DevelopmentSettingsSection(): React.JSX.Element {
  const { loggerEnabled, setLoggerEnabled } = useUIStore()

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
          Debug
        </h2>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
          <div className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-[var(--color-text)]">Enable Logger</p>
              <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                Show a log viewer in the sidebar that streams app activity — useful for debugging
                communication with external services.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setLoggerEnabled(!loggerEnabled)}
              className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
                loggerEnabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
              }`}
              title={loggerEnabled ? 'Disable logger' : 'Enable logger'}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  loggerEnabled ? 'left-[18px]' : 'left-0.5'
                }`}
              />
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
