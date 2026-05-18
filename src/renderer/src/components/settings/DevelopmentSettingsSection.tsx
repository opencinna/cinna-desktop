import { useState } from 'react'
import { Github, Globe } from 'lucide-react'
import { isForceOnboardingArmed, setForceOnboarding } from '../../constants/onboarding'

const REPO_URL = 'https://github.com/opencinna/cinna-desktop'
const WEBSITE_URL = 'https://opencinna.io/'

export function DevelopmentSettingsSection(): React.JSX.Element {
  const [forceOnboarding, setForceOnboardingState] = useState<boolean>(() =>
    isForceOnboardingArmed()
  )

  const toggleForceOnboarding = (): void => {
    const next = !forceOnboarding
    setForceOnboarding(next)
    setForceOnboardingState(next)
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
          About
        </h2>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4 space-y-3">
          <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
            Cinna is open source. Browse the code, file issues, or contribute on GitHub. Visit the
            website for documentation and project news.
          </p>
          <div className="flex flex-col gap-2">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-2 px-3 py-2 rounded-md text-xs text-[var(--color-text)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] border border-[var(--color-border)] transition-colors"
            >
              <Github size={14} className="text-[var(--color-text-muted)]" />
              <span className="font-mono">{REPO_URL}</span>
            </a>
            <a
              href={WEBSITE_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-2 px-3 py-2 rounded-md text-xs text-[var(--color-text)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] border border-[var(--color-border)] transition-colors"
            >
              <Globe size={14} className="text-[var(--color-text-muted)]" />
              <span className="font-mono">{WEBSITE_URL}</span>
            </a>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
          Testing
        </h2>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className="text-xs font-medium text-[var(--color-text)]">
                Enable onboarding on restart
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5 leading-relaxed">
                One-time trigger: the welcome screen will appear the next time the app starts, even
                if providers already exist. The flag is consumed on launch — completing or skipping
                clears it.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={forceOnboarding}
              onClick={toggleForceOnboarding}
              title={
                forceOnboarding
                  ? 'Onboarding will show on next restart'
                  : 'Show onboarding on next restart'
              }
              className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 ${
                forceOnboarding ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
              }`}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  forceOnboarding ? 'left-[18px]' : 'left-0.5'
                }`}
              />
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
