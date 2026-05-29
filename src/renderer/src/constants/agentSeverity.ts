import type { AgentStatusSnapshot } from '../hooks/useAgentStatus'

export type Severity = NonNullable<AgentStatusSnapshot['severity']>

/** Higher rank = more urgent. `unknown` treated as no signal. */
export const SEVERITY_RANK: Record<Severity, number> = {
  error: 4,
  warning: 3,
  info: 2,
  ok: 1,
  unknown: 0
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
  ok: 'OK',
  unknown: 'Unknown'
}

/** Solid-fill classes for dots/pills. Tracks the CSS palette 1:1. */
export const SEVERITY_DOT: Record<Severity, string> = {
  error: 'bg-[var(--color-severity-error)]',
  warning: 'bg-[var(--color-severity-warning)]',
  info: 'bg-[var(--color-severity-info)]',
  ok: 'bg-[var(--color-severity-ok)]',
  unknown: 'bg-[var(--color-severity-unknown)]'
}

/**
 * Raw hex per severity for canvas painting (tray icon dot). Tailwind/CSS-var
 * classes can't be read from a `<canvas>` 2d context, so we keep vivid values
 * that read on both light and dark menu bars. Mirrors the dark-theme palette in
 * `main.css`.
 */
export const SEVERITY_HEX: Record<Severity, string> = {
  error: '#ef4444',
  warning: '#fbbf24',
  info: '#38bdf8',
  ok: '#10b981',
  unknown: '#9ca3af'
}

/** Foreground text uses the `-text` variant for contrast tuning. */
export const SEVERITY_TEXT: Record<Severity, string> = {
  error: 'text-[var(--color-severity-error-text)]',
  warning: 'text-[var(--color-severity-warning-text)]',
  info: 'text-[var(--color-severity-info-text)]',
  ok: 'text-[var(--color-severity-ok-text)]',
  unknown: 'text-[var(--color-severity-unknown-text)]'
}

/** Card border tint — base severity color at reduced alpha. */
export const SEVERITY_CARD_BORDER: Record<Severity, string> = {
  error: 'border-[color-mix(in_srgb,var(--color-severity-error)_40%,transparent)]',
  warning: 'border-[color-mix(in_srgb,var(--color-severity-warning)_40%,transparent)]',
  info: 'border-[color-mix(in_srgb,var(--color-severity-info)_30%,transparent)]',
  ok: 'border-[color-mix(in_srgb,var(--color-severity-ok)_25%,transparent)]',
  unknown: 'border-[var(--color-border)]'
}

export function worstSeverity(
  items: ReadonlyArray<{ severity: AgentStatusSnapshot['severity'] }>
): Severity | null {
  let worst: Severity | null = null
  for (const it of items) {
    if (!it.severity) continue
    if (!worst || SEVERITY_RANK[it.severity] > SEVERITY_RANK[worst]) {
      worst = it.severity
    }
  }
  return worst
}
