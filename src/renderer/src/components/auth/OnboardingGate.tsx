import { useEffect, useRef, useState } from 'react'
import { OnboardingScreen } from './OnboardingScreen'
import { useProviders } from '../../hooks/useProviders'
import { useConnectIntent } from '../../hooks/useConnectIntent'
import { useConnectIntentStore } from '../../stores/connectIntent.store'
import { createLogger } from '../../stores/logger.store'
import {
  consumeForceOnboarding,
  isOnboardingDismissed,
  markOnboardingDismissed
} from '../../constants/onboarding'

const log = createLogger('onboarding')

/**
 * How long first run waits for the clipboard check before painting welcome.
 * The check is a local IPC round trip that takes milliseconds; the cap only
 * bounds a main process that is busy with startup.
 */
export const CLIPBOARD_WAIT_MS = 300

/**
 * First run is a **session, not a derived boolean**.
 *
 * The decision is taken once — from the force flag, the dismissed flag and
 * whether any provider exists — and then it is held until the screen itself
 * says it is finished. It used to be re-derived on every render, which was
 * wrong in a way that only showed up on the path that matters most: signing in
 * calls `queryClient.resetQueries()`, so the providers query goes back to
 * loading, this gate renders its blank div, and the onboarding screen
 * *unmounts*. Moments later a Cinna account's managed providers have not
 * arrived yet, so it mounts again — freshly, with the deep link already
 * consumed, which lands it back on the welcome card. The user, who had just
 * finished authorizing in their browser, got half a second of "API key or Cinna
 * Server?" before the app appeared. The local-development step it should have
 * been showing was lost with the unmount.
 *
 * Holding the session also makes the screen's own step machine the only thing
 * that ends first run, which is what it was always written as: every terminal
 * path — Save & start, Skip for now, the local-dev step falling through — calls
 * `onComplete`.
 *
 * ## The install handoff
 *
 * On a genuine first run (not forced, nothing pending) the gate asks main once
 * whether the download page left a `cinna://connect` link on the clipboard, and
 * keeps its blank placeholder until the answer is in or
 * {@link CLIPBOARD_WAIT_MS} has passed. An answer in time opens the screen on
 * the confirm step; a later one is dropped, because the welcome step is already
 * on screen and nothing may move under the user (ux_rules.md rule 1). Main
 * buffers a clipboard intent without pushing it for the same reason, so a
 * dropped answer is also consumed there rather than left for nobody.
 */
export function OnboardingGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { data: providers, isLoading } = useProviders()
  // Consume the force-onboarding flag once per session (StrictMode-safe via
  // module-level memo in `constants/onboarding`).
  const [forced] = useState<boolean>(() => consumeForceOnboarding())
  const [dismissed] = useState<boolean>(() => !forced && isOnboardingDismissed())
  // The screen reporting that it is done. A state rather than the ref below,
  // because ending first run has to re-render; the ref only has to survive one.
  const [finished, setFinished] = useState(false)
  // Subscribed here rather than only in the modal so the gate can decide *which*
  // surface confirms a deep link. The store dedupes, so the modal reading the
  // same intent below costs nothing.
  const { intent, consume } = useConnectIntent()
  // `null` until the first answer is available. Assigned during render rather
  // than in an effect, because an effect runs a frame too late — and that frame
  // is a flash of the wrong screen.
  const session = useRef<boolean | null>(null)
  if (session.current === null && !isLoading) {
    const hasProviders = (providers?.length ?? 0) > 0
    // Forced mode bypasses the dismissed flag AND the providers-count gate so
    // we can re-trigger onboarding on a fully configured install for testing.
    session.current = forced || !(dismissed || hasProviders)
  }

  // Forced onboarding is a test path on a configured install, where a stray
  // link on the clipboard would only confuse whoever is testing.
  const checksClipboard = session.current === true && !forced
  const [clipboardSettled, setClipboardSettled] = useState(false)
  // A ref, not the effect's cleanup, guards the single call: StrictMode runs the
  // effect twice, and a cleanup that cancelled the timer would leave the second
  // run nothing to start and the gate blank for good.
  const clipboardAsked = useRef(false)
  useEffect(() => {
    if (!checksClipboard || clipboardAsked.current) return
    clipboardAsked.current = true
    if (useConnectIntentStore.getState().intent) {
      setClipboardSettled(true)
      return
    }
    let inTime = true
    const settle = (): void => {
      inTime = false
      clearTimeout(timer)
      setClipboardSettled(true)
    }
    const timer = setTimeout(settle, CLIPBOARD_WAIT_MS)
    window.api.connect.checkClipboard().then(
      (found) => {
        if (inTime) {
          if (found) useConnectIntentStore.getState().offer(found)
          settle()
          return
        }
        // Too late to show. Drop main's buffer too — unless a link has reached
        // the store meanwhile, which is the one now on its way to the screen —
        // and only this intent, so a link clicked since then survives in main.
        if (found && !useConnectIntentStore.getState().intent) {
          void window.api.connect.consume(found.receivedAt).catch(() => undefined)
        }
      },
      (err) => {
        if (inTime) settle()
        log.warn('the clipboard check failed', { message: (err as Error)?.message })
      }
    )
  }, [checksClipboard])

  if (finished) return <>{children}</>
  if (session.current === null) return <div className="h-full bg-[var(--color-bg)]" />

  // A deep link on an install that is past first run gets a modal over the app
  // (rendered by `App`), not a resurrected onboarding screen — the user has an
  // account and a workspace they are looking at, and replacing it with a
  // first-run screen to answer one yes/no question would be a bigger
  // interruption than the question.
  if (!session.current) return <>{children}</>

  if (checksClipboard && !clipboardSettled) return <div className="h-full bg-[var(--color-bg)]" />

  return (
    <OnboardingScreen
      connectIntent={intent}
      onConnectIntentDone={consume}
      onComplete={() => {
        markOnboardingDismissed()
        setFinished(true)
      }}
    />
  )
}
