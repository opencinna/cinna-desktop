import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react'
import { Check, Cloud, Loader2, Mic } from 'lucide-react'
import { CONTEXT_MENU_ITEM, CONTEXT_MENU_SURFACE, ContextMenu } from '../../ui/ContextMenu'
import { MenuSwitchItem } from '../../ui/MenuSwitchItem'
import { useUIStore } from '../../../stores/ui.store'
import { useToastStore } from '../../../stores/toast.store'
import { registerMediaToggle } from './mediaKeys'
import { SPEECH_BLOCKED_HINT, speechBlocked, useSpeechStatus } from './useSpeechStatus'
import { useVoiceRecorder, type DictationCallbacks, type DictationOffer } from './useVoiceRecorder'
import { commitFinal, startSpan, type DictationSpan } from './dictationSpan'
import { useLiveDictationStore, type LiveDictationControls } from './liveDictation.store'
import { VoiceRelayOfferDialog } from './VoiceRelayOfferDialog'
import { isCloudBackend, type SpeechBackend } from '../../../../../shared/speech'

interface Microphone {
  deviceId: string
  label: string
}

/** Every audio input; labels are empty until mic permission is granted, so number those. */
async function listMicrophones(): Promise<Microphone[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((device) => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications')
    .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` }))
}

const BUTTON = 'relative p-1.5 rounded-lg transition-colors'
const IDLE = `${BUTTON} text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]`
const BLOCKED = `${BUTTON} text-[var(--color-text-muted)] opacity-40`
// Recording: the same microphone, red and pulsing, so it never reads as the turn's Stop.
const RECORDING = `${BUTTON} text-[var(--color-danger)] hover:bg-[var(--color-bg-hover)]`
const TRANSCRIBING = `${BUTTON} text-[var(--color-text-muted)] cursor-wait`

export const CLOUD_TRANSCRIPTION_NOTE = 'Transcribing with Gemini — audio is sent to Google'

/** The cloud mark's note for this session's backend: who receives the audio. */
export function cloudTranscriptionNote(backend: SpeechBackend, serverName: string | undefined): string {
  if (backend === 'core-relay') {
    const name = serverName || 'the Cinna server'
    return `Transcribing on ${name}: audio leaves this computer.`
  }
  return CLOUD_TRANSCRIPTION_NOTE
}

/** Where a live dictation writes: its composer's draft key and that draft's text setter. */
export interface DictationTarget {
  draftKey: string
  setDraft: (update: (draft: string) => string) => void
}

/**
 * Whether the composer shows the voice button: main reports voice input
 * available and the user has not hidden it. The composer reads it to drop an
 * empty draft's Send, leaving the mic as the row's one control.
 */
export function useVoiceInputShown(): boolean {
  const status = useSpeechStatus()
  const shown = useUIStore((s) => s.showVoiceInput)
  return status.available && shown
}

/**
 * The composer's voice input: click to record, click again to stop. Where main
 * streams, the words appear at the caret while the user speaks (see
 * `liveDictation.store.ts`); otherwise the text lands in the composer after stop. Right-click picks the microphone. Rendered only
 * where main reports voice input available (on-device, or Gemini by the
 * user's setting); while a session runs on Gemini a small cloud mark sits in
 * the button's corner; the box is the same in every state, so
 * nothing beside it moves (ux_rules §1). The headphone button toggles it too
 * (see `mediaKeys.ts`); its double click sends the composer, and while
 * recording it stops, transcribes and sends. Errors go to the composer's
 * `onError` (a toast).
 */
export function VoiceInputButton({
  onText,
  onError,
  onSend,
  composerRef,
  dictation
}: {
  onText: (text: string) => void
  /** Live dictation's target; without it, the text arrives whole after stop through `onText`. */
  dictation?: DictationTarget
  /** The headphone double click: send the composer as its Send button would. */
  onSend: () => void
  /** Shows an error; null means the previous one no longer applies. */
  onError: (message: string | null) => void
  /** The composer's textarea: focusing it makes this composer the headphone button's target. */
  composerRef?: RefObject<HTMLElement | null>
}): React.JSX.Element | null {
  const status = useSpeechStatus()
  const shown = useVoiceInputShown()
  if (!shown) return null
  return <VoiceInputControl blocked={speechBlocked(status)} relayServerName={status.cloud.relay.serverName} onText={onText} onError={onError} onSend={onSend} composerRef={composerRef} dictation={dictation} />
}

function VoiceInputControl({
  blocked,
  relayServerName,
  onText,
  onError,
  onSend,
  composerRef,
  dictation
}: {
  blocked: boolean
  /** The Cinna server's name, for the cloud mark's note while the relay transcribes. */
  relayServerName?: string
  onText: (text: string) => void
  onSend: () => void
  onError: (message: string | null) => void
  composerRef?: RefObject<HTMLElement | null>
  dictation?: DictationTarget
}): React.JSX.Element {
  const deviceId = useUIStore((s) => s.voiceInputDeviceId)
  const setDeviceId = useUIStore((s) => s.setVoiceInputDeviceId)
  // A double click while recording or transcribing: send once the text lands.
  // Any failure (nothing heard, denied, an error) drops the send, so a draft
  // without the dictation never goes out.
  const sendAfterText = useRef(false)
  const [landed, setLanded] = useState(0)
  const handleText = useCallback((text: string) => {
    onText(text)
    if (!sendAfterText.current) return
    sendAfterText.current = false
    setLanded((count) => count + 1)
  }, [onText])
  const handleError = useCallback((message: string | null) => {
    if (message !== null) sendAfterText.current = false
    onError(message)
  }, [onError])
  // Live dictation: where it sits in the draft and the partial on show. The
  // span and the partial live in refs (the recorder's callbacks are not
  // render-bound) and are published to the composer through the store.
  const target = useRef(dictation)
  target.current = dictation
  const span = useRef<DictationSpan | null>(null)
  const partial = useRef('')
  // The span a session ended with, for an offer to continue it.
  const endedSpan = useRef<DictationSpan | null>(null)
  // A continuation on the Cinna server writes on from here, not at the caret.
  const resumeSpan = useRef<DictationSpan | null>(null)
  // On-device dictation failed and the Cinna server could continue it: asked in a dialog.
  const [offer, setOffer] = useState<(DictationOffer & { span: DictationSpan | null }) | null>(null)
  // Read by the headphone button's handlers, which are not render-bound.
  const offerOpen = useRef(false)
  offerOpen.current = offer !== null
  // This session's audio leaves the computer (Gemini or the Cinna server): the cloud mark, until the session ends.
  const [cloud, setCloud] = useState<{ backend: SpeechBackend; serverName?: string } | null>(null)
  const finishing = useRef(false)
  const controls = useRef<LiveDictationControls>({ freeze: () => {}, cancel: () => {}, send: () => {} })
  const publish = useCallback(() => {
    const t = target.current
    if (!t || !span.current) return
    useLiveDictationStore.getState().set(t.draftKey, {
      span: span.current,
      partial: partial.current,
      finishing: finishing.current,
      controls: controls.current
    })
  }, [])
  const writeFinal = useCallback((text: string) => {
    const t = target.current
    if (!t || !span.current) return
    let next = span.current
    t.setDraft((draft) => {
      const committed = commitFinal(draft, next, text)
      next = committed.span
      return committed.draft
    })
    span.current = next
  }, [])
  const callbacks = useMemo<DictationCallbacks | undefined>(() => dictation ? {
    onSessionStart: () => {
      const textarea = composerRef?.current instanceof HTMLTextAreaElement ? composerRef.current : null
      const draft = textarea?.value ?? ''
      // A continuation picks up where the failed dictation's confirmed text ends.
      span.current = resumeSpan.current ?? startSpan(textarea?.selectionStart ?? draft.length, textarea?.selectionEnd ?? draft.length, draft.length)
      resumeSpan.current = null
      partial.current = ''
      finishing.current = false
      publish()
      // Typing ends the dictation, so the keys must reach the composer.
      textarea?.focus()
    },
    onPartial: (text) => {
      partial.current = text
      publish()
    },
    onFinal: (text) => {
      writeFinal(text)
      partial.current = ''
      publish()
    },
    onBackend: (backend) => setCloud(isCloudBackend(backend) ? { backend, serverName: relayName.current } : null),
    onSessionEnd: (completed) => {
      setCloud(null)
      const t = target.current
      endedSpan.current = span.current
      span.current = null
      partial.current = ''
      finishing.current = false
      if (t) useLiveDictationStore.getState().set(t.draftKey, null)
      if (!completed) {
        sendAfterText.current = false
        return
      }
      if (!sendAfterText.current) return
      sendAfterText.current = false
      setLanded((count) => count + 1)
    },
    // Instead of the error toast: the dialog asks before any audio leaves.
    // onSessionEnd ran first and dropped a pending send-after-text, on
    // purpose: the user is asked a question in between, so a send firing on
    // its own once the continued text lands would surprise them.
    onOffer: (next) => {
      const ended = endedSpan.current
      endedSpan.current = null
      setOffer({ ...next, span: ended })
    }
  } : undefined, [!!dictation, composerRef, publish, writeFinal]) // eslint-disable-line react-hooks/exhaustive-deps
  const relayName = useRef(relayServerName)
  relayName.current = relayServerName
  const { state, current, toggle, end, continueOnRelay } = useVoiceRecorder({ deviceId, onText: handleText, onError: handleError, dictation: callbacks })
  const keepAfterOffer = useCallback(() => {
    setOffer(null)
  }, [])
  const continueAfterOffer = useCallback(() => {
    if (!offer) return
    setOffer(null)
    resumeSpan.current = offer.span
    relayName.current = offer.serverName
    continueOnRelay({ replay: offer.replay, replaySeconds: offer.replaySeconds, stopped: offer.stopped })
  }, [offer, continueOnRelay])
  useEffect(() => {
    const now = state === 'transcribing'
    if (finishing.current === now || !span.current) return
    finishing.current = now
    publish()
  }, [state, publish])
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [microphones, setMicrophones] = useState<Microphone[]>([])

  // Blocked: a click explains instead of recording audio that cannot be transcribed.
  const activate = useCallback(() => {
    // The offer dialog is a question: no dictation starts under it (Continue
    // would have to drop its replay), so the headphone button waits for the answer.
    if (offerOpen.current) return
    if (blocked && state === 'idle') onError(SPEECH_BLOCKED_HINT)
    else toggle()
  }, [blocked, state, onError, toggle])

  // Idle: send the draft. Recording: stop, and send once transcribed.
  // Transcribing: send once transcribed.
  // Reads the recorder's live state: the rendered one can lag a transition.
  const send = useCallback(() => {
    // Nor does the headphone double click send the draft under the question.
    if (offerOpen.current) return
    const now = current()
    if (now === 'idle') {
      onSend()
      return
    }
    sendAfterText.current = true
    if (now === 'recording') toggle()
  }, [current, onSend, toggle])
  controls.current.freeze = () => {
    // What the composer shows becomes plain draft text before listening stops.
    if (partial.current.trim()) writeFinal(partial.current)
    partial.current = ''
    end()
  }
  controls.current.cancel = () => {
    partial.current = ''
    end()
  }
  controls.current.send = () => send()

  // Idle again with nothing to deliver: a double click that read a stale state
  // (after the recorder went idle, before this re-rendered) set the flag with
  // nothing running; left set, the next dictation would send itself. The
  // recorder hands over its text before it goes idle, so a pending send has
  // been consumed by then.
  useEffect(() => {
    if (state === 'idle') sendAfterText.current = false
  }, [state])

  // After the commit that put the dictation in the draft, so `onSend` is the
  // composer's handler for the draft that holds it.
  const onSendRef = useRef(onSend)
  onSendRef.current = onSend
  useEffect(() => {
    if (landed > 0) onSendRef.current()
  }, [landed])

  const activateRef = useRef(activate)
  activateRef.current = activate
  const sendRef = useRef(send)
  sendRef.current = send
  const mediaToggle = useRef<ReturnType<typeof registerMediaToggle> | null>(null)
  useEffect(() => {
    const registration = registerMediaToggle({ toggle: () => activateRef.current(), send: () => sendRef.current() })
    mediaToggle.current = registration
    const composer = composerRef?.current
    const promote = (): void => registration.promote()
    composer?.addEventListener('focus', promote)
    return () => {
      composer?.removeEventListener('focus', promote)
      registration.unregister()
      mediaToggle.current = null
    }
  }, [composerRef])

  // Listed while mounted, so the menu opens with the right row checked; a
  // menu open re-lists, since labels appear once mic permission is granted.
  const [listed, setListed] = useState(false)
  const refresh = useCallback(() => {
    void listMicrophones()
      .then(setMicrophones, () => setMicrophones([]))
      .finally(() => setListed(true))
  }, [])
  useEffect(() => {
    refresh()
    const devices = navigator.mediaDevices
    devices?.addEventListener?.('devicechange', refresh)
    return () => devices?.removeEventListener?.('devicechange', refresh)
  }, [refresh])
  useEffect(() => {
    if (menu) refresh()
  }, [menu, refresh])

  const closeMenu = useCallback(() => setMenu(null), [])
  // Turning it off here unmounts this button: a recording in progress is
  // discarded, and the toast says so (a transcription already in flight still
  // lands in the draft). The toast says where it comes back. Focus goes to the
  // composer, not to the body the button leaves behind.
  const hide = (): void => {
    const discarded = state === 'recording'
    setMenu(null)
    useUIStore.getState().setShowVoiceInput(false)
    composerRef?.current?.focus()
    const hidden = discarded ? 'Audio input is hidden, and the recording was discarded.' : 'Audio input is hidden.'
    useToastStore.getState().show(`${hidden} Turn it back on in Settings → Features → Interface → Audio input.`, {
      kind: 'info',
      link: { label: 'Open Settings → Features', settingsMenu: 'features' }
    })
  }
  const pick = (next: string | null): void => {
    setDeviceId(next)
    setMenu(null)
  }
  // A remembered mic that is not plugged in records from the default; show that.
  const selected = deviceId && (!listed || microphones.some((mic) => mic.deviceId === deviceId)) ? deviceId : null

  const recording = state === 'recording'
  const transcribing = state === 'transcribing'
  const cloudNoteId = useId()
  const stateTitle = recording
    ? 'Stop recording'
    : transcribing
      ? (dictation ? 'Finishing…' : 'Transcribing…')
      : blocked
        ? SPEECH_BLOCKED_HINT
        : 'Audio input · right-click to choose the microphone'
  const showCloud = cloud !== null && state !== 'idle'
  const cloudNote = cloud ? cloudTranscriptionNote(cloud.backend, cloud.serverName) : ''
  const title = showCloud ? `${stateTitle} · ${cloudNote}` : stateTitle

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={recording ? 'Stop recording' : 'Audio input'}
        aria-pressed={recording}
        // Read by minimal view's wipe gesture, which does not count while recording.
        data-voice-recording={recording || undefined}
        title={title}
        aria-describedby={showCloud ? cloudNoteId : undefined}
        disabled={transcribing}
        onClick={() => {
          mediaToggle.current?.promote()
          activate()
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
        className={recording ? RECORDING : transcribing ? TRANSCRIBING : blocked ? BLOCKED : IDLE}
      >
        {transcribing ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} className={recording ? 'motion-safe:animate-pulse' : undefined} />}
        {/* Inside the button's padding, in its very corner: the box keeps its size
            (ux_rules §1) and the mark clears the spinner's arc. The text colour,
            not the accent: it must read apart from the red recording mic. */}
        {showCloud && (
          <>
            <Cloud size={9} strokeWidth={2.5} aria-hidden="true" data-testid="voice-cloud-mark"
              className="pointer-events-none absolute right-0 bottom-0 text-[var(--color-text)]" />
            <span id={cloudNoteId} className="sr-only">{cloudNote}</span>
          </>
        )}
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          anchor={buttonRef.current}
          label="Audio input"
          className={CONTEXT_MENU_SURFACE.replace('w-44', 'w-60')}
          onClose={closeMenu}
        >
          {/* Sections, top to bottom: the microphone, then (later) voice
              options such as Auto-Send, each after a separator. */}
          <div className="px-2 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Microphone
          </div>
          <MicrophoneItem label="System default" checked={selected === null} onPick={() => pick(null)} />
          {microphones.map((mic) => (
            <MicrophoneItem key={mic.deviceId} label={mic.label} checked={selected === mic.deviceId} onPick={() => pick(mic.deviceId)} />
          ))}
          <div className="my-1 border-t border-[var(--color-border)]" />
          {/* Always on here: turning it off hides the button this menu belongs to. */}
          <MenuSwitchItem label="Audio input" checked onToggle={hide} />
        </ContextMenu>
      )}
      {offer && (
        <VoiceRelayOfferDialog
          message={offer.message}
          serverName={offer.serverName}
          replaySeconds={offer.replaySeconds}
          stopped={offer.stopped}
          onContinue={continueAfterOffer}
          onKeep={keepAfterOffer}
        />
      )}
    </>
  )
}

function MicrophoneItem({ label, checked, onPick }: { label: string; checked: boolean; onPick: () => void }): React.JSX.Element {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} className={CONTEXT_MENU_ITEM} onClick={onPick} title={label}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && <Check size={12} className="shrink-0 text-[var(--color-accent)]" aria-hidden="true" />}
    </button>
  )
}
