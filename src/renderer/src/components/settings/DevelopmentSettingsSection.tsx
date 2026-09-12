import { useState } from 'react'
import { Github, Globe } from 'lucide-react'
import { isForceOnboardingArmed, setForceOnboarding } from '../../constants/onboarding'
import { SettingsCard, SettingsRows, SettingsSection, SettingsToggleRow } from './SettingsLayout'

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
      <SettingsSection title="About">
        <SettingsCard className="space-y-3">
          <p className="text-[14px] text-[var(--color-text-secondary)] leading-relaxed">
            Cinna is open source. Browse the code, file issues, or contribute on GitHub. Visit the
            website for documentation and project news.
          </p>
          <div className="flex flex-col gap-2">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-2 px-3 py-2 rounded-md text-[14px] text-[var(--color-text)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] border border-[var(--color-border)] transition-colors"
            >
              <Github size={14} className="text-[var(--color-text-muted)]" />
              <span className="font-mono">{REPO_URL}</span>
            </a>
            <a
              href={WEBSITE_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-2 px-3 py-2 rounded-md text-[14px] text-[var(--color-text)] bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-hover)] border border-[var(--color-border)] transition-colors"
            >
              <Globe size={14} className="text-[var(--color-text-muted)]" />
              <span className="font-mono">{WEBSITE_URL}</span>
            </a>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Testing">
        <SettingsRows>
          <SettingsToggleRow
            id="dev-force-onboarding"
            label="Enable onboarding on restart"
            description="One-time trigger: the welcome screen will appear the next time the app starts, even if providers already exist. The flag is consumed on launch — completing or skipping clears it."
            checked={forceOnboarding}
            onToggle={toggleForceOnboarding}
            title={
              forceOnboarding
                ? 'Onboarding will show on next restart'
                : 'Show onboarding on next restart'
            }
          />
        </SettingsRows>
      </SettingsSection>
    </div>
  )
}
