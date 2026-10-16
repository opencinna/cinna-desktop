import { useState } from 'react'
import { useOpenExternal } from '../../hooks/useSystem'
import { SettingsInfoTip } from './SettingsLayout'

export const ANTIGRAVITY_TERMS_URL = 'https://antigravity.google/terms'

/**
 * The (?) beside Antigravity's **Log in**, on every surface that offers it
 * while Antigravity is logged out.
 *
 * Antigravity is a proprietary Google binary with its own telemetry, and the
 * login is the moment the user agrees to run it on their Google account, so the
 * terms are named there. Behind a tip rather than in a line: a line truncated
 * its own link away at 800px (ux_rules rule 7), and coming and going it moved
 * the rows below it (rules 1 and 12). The tip is one fixed-size icon in the row
 * that already holds Log in, so no state of it changes any height.
 *
 * A link the shell refused to open says so in place, with the address, rather
 * than doing nothing (rule 6).
 */
export function AntigravityTermsTip(): React.JSX.Element {
  return (
    <SettingsInfoTip label="About Antigravity’s terms">
      <AntigravityTermsContent />
    </SettingsInfoTip>
  )
}

function AntigravityTermsContent(): React.JSX.Element {
  const openExternal = useOpenExternal()
  const [failed, setFailed] = useState(false)
  return (
    <>
      <p>
        Antigravity is Google’s software, with its own terms and telemetry. Logging in runs it on
        your Google account.
      </p>
      <p>
        {failed ? (
          <span>Could not open {ANTIGRAVITY_TERMS_URL}</span>
        ) : (
          <button
            type="button"
            className="font-medium text-[var(--color-accent)] hover:underline"
            title={ANTIGRAVITY_TERMS_URL}
            onClick={() => {
              void openExternal(ANTIGRAVITY_TERMS_URL)
                .then((result) => { if (!result.success) setFailed(true) })
                .catch(() => setFailed(true))
            }}
          >
            Google Antigravity terms
          </button>
        )}
      </p>
    </>
  )
}

/**
 * Antigravity's terms, as the status line while it is selected and not yet
 * installed and logged in. The link never truncates: the lead does, with the
 * whole sentence in `title`, so the one thing the line exists for survives
 * the 800px minimum (ux_rules rule 7). A link the shell refused to open says
 * so in place.
 */
export function AntigravityTermsLine(): React.JSX.Element {
  const openExternal = useOpenExternal()
  const [failed, setFailed] = useState(false)
  const sentence = 'Installing and logging in accepts Google’s Antigravity terms.'
  return (
    <p className="flex min-w-0 flex-1 gap-1 text-[var(--color-text-muted)]" title={sentence}>
      <span className="min-w-0 truncate">Installing and logging in accepts</span>{' '}
      {failed ? (
        <span className="shrink-0">Could not open {ANTIGRAVITY_TERMS_URL}</span>
      ) : (
        <button
          type="button"
          className="shrink-0 font-medium text-[var(--color-accent)] hover:underline"
          title={ANTIGRAVITY_TERMS_URL}
          onClick={() => {
            void openExternal(ANTIGRAVITY_TERMS_URL)
              .then((result) => {
                if (!result.success) setFailed(true)
              })
              .catch(() => setFailed(true))
          }}
        >
          Google’s Antigravity terms
        </button>
      )}
    </p>
  )
}
