import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Check, Loader2, Mic } from 'lucide-react'
import { CONTEXT_MENU_ITEM, CONTEXT_MENU_SURFACE, ContextMenu } from '../../ui/ContextMenu'
import { useUIStore } from '../../../stores/ui.store'
import { useToastStore } from '../../../stores/toast.store'
import { registerMediaToggle } from './mediaKeys'
import { SPEECH_BLOCKED_HINT, speechBlocked, useSpeechStatus } from './useSpeechStatus'
import { useVoiceRecorder } from './useVoiceRecorder'

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

const BUTTON = 'p-1.5 rounded-lg transition-colors'
const IDLE = `${BUTTON} text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]`
const BLOCKED = `${BUTTON} text-[var(--color-text-muted)] opacity-40`
// Recording: the same microphone, red and pulsing, so it never reads as the turn's Stop.
const RECORDING = `${BUTTON} text-[var(--color-danger)] hover:bg-[var(--color-bg-hover)]`
const TRANSCRIBING = `${BUTTON} text-[var(--color-text-muted)] cursor-wait`

/**
 * The composer's voice input: click to record, click again to transcribe, the
 * text lands in the composer. Right-click picks the microphone. Rendered only
 * where main reports a speech engine; the box is the same in every state, so
 * nothing beside it moves (ux_rules §1). The headphone button toggles it too
 * (see `mediaKeys.ts`); its double click sends the composer, and while
 * recording it stops, transcribes and sends. Errors go to the composer's
 * `onError` (a toast).
 */
export function VoiceInputButton({
  onText,
  onError,
  onSend,
  composerRef
}: {
  onText: (text: string) => void
  /** The headphone double click: send the composer as its Send button would. */
  onSend: () => void
  /** Shows an error; null means the previous one no longer applies. */
  onError: (message: string | null) => void
  /** The composer's textarea: focusing it makes this composer the headphone button's target. */
  composerRef?: RefObject<HTMLElement | null>
}): React.JSX.Element | null {
  const status = useSpeechStatus()
  const shown = useUIStore((s) => s.showVoiceInput)
  if (!status.supported || !shown) return null
  return <VoiceInputControl blocked={speechBlocked(status)} onText={onText} onError={onError} onSend={onSend} composerRef={composerRef} />
}

function VoiceInputControl({
  blocked,
  onText,
  onError,
  onSend,
  composerRef
}: {
  blocked: boolean
  onText: (text: string) => void
  onSend: () => void
  onError: (message: string | null) => void
  composerRef?: RefObject<HTMLElement | null>
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
  const { state, current, toggle } = useVoiceRecorder({ deviceId, onText: handleText, onError: handleError })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [microphones, setMicrophones] = useState<Microphone[]>([])

  // Blocked: a click explains instead of recording audio that cannot be transcribed.
  const activate = useCallback(() => {
    if (blocked && state === 'idle') onError(SPEECH_BLOCKED_HINT)
    else toggle()
  }, [blocked, state, onError, toggle])

  // Idle: send the draft. Recording: stop, and send once transcribed.
  // Transcribing: send once transcribed.
  // Reads the recorder's live state: the rendered one can lag a transition.
  const send = useCallback(() => {
    const now = current()
    if (now === 'idle') {
      onSend()
      return
    }
    sendAfterText.current = true
    if (now === 'recording') toggle()
  }, [current, onSend, toggle])
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
    useToastStore.getState().show(`${hidden} Turn it back on in Settings → Features → Interface → Show audio input.`, {
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
  const title = recording
    ? 'Stop recording'
    : transcribing
      ? 'Transcribing…'
      : blocked
        ? SPEECH_BLOCKED_HINT
        : 'Audio input · right-click to choose the microphone'

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={recording ? 'Stop recording' : 'Audio input'}
        aria-pressed={recording}
        title={title}
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
          <button type="button" role="menuitemcheckbox" aria-checked={true} className={CONTEXT_MENU_ITEM} onClick={hide}>
            <span className="min-w-0 flex-1 truncate">Show audio input</span>
            <MenuSwitch checked />
          </button>
        </ContextMenu>
      )}
    </>
  )
}

/** The settings switch, menu-sized; the row around it is the control. */
function MenuSwitch({ checked }: { checked: boolean }): React.JSX.Element {
  return (
    <span aria-hidden="true" className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'}`}>
      <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${checked ? 'left-[14px]' : 'left-0.5'}`} />
    </span>
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
