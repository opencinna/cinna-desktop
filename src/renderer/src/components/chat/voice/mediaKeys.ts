import silenceUrl from './silence.wav?no-inline'

/**
 * The headphone button (EarPods/AirPods click, the play/pause media command)
 * as the voice-input toggle. Chromium routes hardware media keys to the page's
 * Media Session only while the page plays controllable media, so while a
 * composer offering voice input is mounted and the window is focused, a silent
 * file (7 s of zero samples; Chromium wants ≥5 s to treat it as media) loops
 * and the session's play/pause/stop handlers toggle recording; a double click
 * (next track) sends the composer. Blur, or the
 * last composer unmounting, pauses it and clears the handlers, which hands the
 * button back to whatever else plays.
 *
 * One toggle receives the click: the most recently mounted or focused one.
 * No globalShortcut: that would need the Accessibility permission.
 */

export interface MediaHandlers {
  /** Single click: start or stop recording. */
  toggle: () => void
  /** Double click: send what the composer holds. */
  send: () => void
}

interface Entry {
  handlers: MediaHandlers
}

const entries: Entry[] = []
let audio: HTMLAudioElement | null = null
let listening = false

const TOGGLE_ACTIONS: MediaSessionAction[] = ['play', 'pause', 'stop']

function top(): MediaHandlers | undefined {
  return entries[entries.length - 1]?.handlers
}

function setHandlers(on: boolean): void {
  if (!supported()) return
  const session = navigator.mediaSession
  const set = (action: MediaSessionAction, handler: (() => void) | null): void => {
    try {
      session.setActionHandler(action, handler)
    } catch {
      // An action this Chromium does not know.
    }
  }
  for (const action of TOGGLE_ACTIONS) set(action, on ? () => top()?.toggle() : null)
  set('nexttrack', on ? () => top()?.send() : null)
  try {
    session.playbackState = on ? 'playing' : 'none'
  } catch {
    // ignore
  }
}

/** No Media Session (jsdom, an old Chromium): no headphone button, nothing plays. */
function supported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaSession
}

function activate(): void {
  if (entries.length === 0 || !supported() || !document.hasFocus()) return
  if (!audio) {
    audio = new Audio(silenceUrl)
    audio.loop = true
  }
  setHandlers(true)
  try {
    void audio.play()?.catch(() => {})
  } catch {
    // ignore: no playback, no headphone button
  }
}

function deactivate(): void {
  audio?.pause()
  setHandlers(false)
}

function listen(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('focus', activate)
  window.addEventListener('blur', deactivate)
}

function unlisten(): void {
  if (!listening) return
  listening = false
  window.removeEventListener('focus', activate)
  window.removeEventListener('blur', deactivate)
}

/** Registers a composer's handlers on top; returns its unregister. */
export function registerMediaToggle(handlers: MediaHandlers): { promote(): void; unregister(): void } {
  const entry: Entry = { handlers }
  entries.push(entry)
  listen()
  activate()
  return {
    promote() {
      const at = entries.indexOf(entry)
      if (at === -1 || at === entries.length - 1) return
      entries.splice(at, 1)
      entries.push(entry)
    },
    unregister() {
      const at = entries.indexOf(entry)
      if (at !== -1) entries.splice(at, 1)
      if (entries.length === 0) {
        deactivate()
        unlisten()
      }
    }
  }
}
