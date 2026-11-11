import { useRef } from 'react'
import { DashboardDialog, DIALOG_BUTTON, DIALOG_PRIMARY } from '../../dashboards/DashboardDialog'

/** What Keep discards, as a sentence; nothing when nothing waits. */
function discardedSentence(seconds: number): string {
  if (seconds <= 0) return ''
  const rounded = Math.round(seconds)
  if (rounded <= 1) return ' If you keep the text, the last second not yet transcribed is discarded.'
  return ` If you keep the text, the ${rounded} seconds not yet transcribed are discarded.`
}

/** What Continue sends, as the start of a sentence. */
function sentClause(seconds: number, serverName: string): string {
  const rounded = Math.round(seconds)
  if (seconds <= 0) return `Your recording will be sent to ${serverName}`
  if (rounded <= 1) return `The last second that was not transcribed yet will be sent to ${serverName}`
  return `The last ${rounded} seconds that were not transcribed yet will be sent to ${serverName}`
}

/**
 * On-device dictation failed and the Cinna server's relay could continue it.
 * Asked, never assumed: audio leaves the computer only on Continue (Finish
 * when the user had already stopped). Keep the text, the default (focused, and
 * what Escape or a click outside does), leaves the confirmed text as it is,
 * sends nothing and discards the audio not yet transcribed.
 */
export function VoiceRelayOfferDialog({
  message,
  serverName,
  replaySeconds,
  stopped,
  onContinue,
  onKeep
}: {
  /** Why the on-device dictation ended. */
  message: string
  serverName: string
  replaySeconds: number
  /** The user had already stopped: Continue only finishes what was said. */
  stopped: boolean
  onContinue: () => void
  onKeep: () => void
}): React.JSX.Element {
  const keepRef = useRef<HTMLButtonElement>(null)
  const sent = sentClause(replaySeconds, serverName)
  const question = stopped
    ? `Finish with ${serverName}? ${sent}, and the text lands where the dictation was.`
    : `Continue with ${serverName}? ${sent}, and dictation continues there.`
  const discarded = discardedSentence(replaySeconds)
  return (
    <DashboardDialog label="Dictation stopped" onClose={onKeep} initialFocusRef={keepRef}>
      <h2 className="text-sm font-semibold text-[var(--color-text)]">Dictation stopped</h2>
      <p className="mt-2 text-xs text-[var(--color-text-secondary)]">{message}</p>
      <p className="mt-2 text-xs text-[var(--color-text-secondary)]">{question}{discarded}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button ref={keepRef} type="button" onClick={onKeep} className={DIALOG_BUTTON}>
          Keep the text
        </button>
        {/* The server is named in the sentence above; the button is the verb. */}
        <button type="button" onClick={onContinue} className={DIALOG_PRIMARY}>
          {stopped ? 'Finish' : 'Continue'}
        </button>
      </div>
    </DashboardDialog>
  )
}
