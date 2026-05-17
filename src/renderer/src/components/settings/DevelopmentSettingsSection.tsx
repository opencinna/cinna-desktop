import { Github, Globe } from 'lucide-react'

const REPO_URL = 'https://github.com/opencinna/cinna-desktop'
const WEBSITE_URL = 'https://opencinna.io/'

export function DevelopmentSettingsSection(): React.JSX.Element {
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
    </div>
  )
}
