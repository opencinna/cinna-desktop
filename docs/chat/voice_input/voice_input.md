# Voice Input

## Purpose

A microphone button in the chat composer, left of Send, turns what the user says into text in the draft, using macOS's own speech recognition on the Mac, or, when the user opts in, the cloud: the transcription relay of their Cinna server, or Google Gemini on their own API key. The words appear at the caret while the user is still speaking. The text is never sent by itself; the user reads it, edits it and sends it, or sends it from the headphone button.

## Core Concepts

- **Voice input button** — The microphone beside Send. It exists only where main reports voice input available (a working on-device engine, or cloud transcription on with a usable service: the Cinna server, or a Gemini key of the user's own) and the user has not hidden it.
- **Send beside the mic.** The composer's control row is never empty. With the mic shown, an idle empty draft has no Send, only the mic; Send appears to its right as soon as there is something to send: text, live dictated words, a path or paste chip, or files in an active chat. Content that readiness refuses keeps Send visible but disabled, its tooltip giving the reason. Send also stays, disabled, while a new chat's first send is in flight (it must not vanish under the click) and as Save while a queued message is edited. Without the mic, an empty draft shows a disabled Send. Stop still replaces Send while a turn runs on an empty draft, with the mic beside it. Send stays rightmost (the user's choice), so the mic shifts left when Send appears. When Send or Stop leaves the slot (a send cleared the draft before Stop arrived, a turn ended under a click on Stop, the draft was emptied), a disabled Send holds it for 0.8 s, so the mic never slides under a click meant for them and a double click on Send cannot start a recording; a chat switch does not hold it.
- **Speech engine** — One speech-to-text backend in main. Three exist: `macos` (on-device), `gemini` (cloud, Gemini Live on the user's key) and `core` (cloud, the voice transcription relay of the profile's Cinna server). Another provider would implement the same boundary.
- **Backend** — Which Apple recognizer the `macos` engine runs. **SpeechAnalyzer** (with SpeechTranscriber) on macOS 26 and later once that language's model is installed; **SFSpeechRecognizer** everywhere else. Reported in the speech status for diagnostics only; the user never sees it. The cloud engines' backends, `gemini-live` and `core-relay`, are the ones the user does see (the cloud mark).
- **Speech helper** — `cinna-speech`, a small native program shipped inside the app. Main runs it once per probe, transcription or live dictation. Both backends live in this one helper.
- **Speech status** — Main's answer to "does voice input work here": whether the on-device engine is supported, the engine, the backend, the Speech Recognition permission state, whether voice input is `available` at all, and the cloud half (mode, service, usable Gemini providers, and the Cinna server relay's last-known availability, which only the offer dialog and the cloud mark read).
- **Dictation** — One recording: started by a click, stopped by the next, its words written into the draft at the caret.
- **Live dictation** — A dictation whose audio streams to the helper while the user speaks. The engine answers with **partial** text (the current unconfirmed segment, revised as more is heard) and **final** text (confirmed, never revised). Confirmed text is written into the draft; the partial is only shown.
- **Batch dictation** — The older shape: record, stop, transcribe the whole WAV, append. Used only where the preload has no streaming (`speech.stream` missing).
- **Cloud transcription** — The setting (Off, As a fallback, Always) that lets dictation run in the cloud, on the **Service** the user picked (below). The audio leaves the computer.
- **Service** — Where cloud transcription goes: **Cinna server** (the relay of the profile's server, which pays for it; see [Cinna server relay](#cinna-server-relay)) or **My Gemini key** (Google Gemini Live with the user's own Gemini API key from AI Credentials; the audio goes to Google and is billed to that key, about $0.009 per minute for `gemini-3.5-transcribe-live`, per Google's pricing page on 2026-11-11).
- **Offer** — The dialog that follows an on-device failure while the Cinna server relay is available, asking whether to continue there. (Point-of-use behaviour: the one place the account's server is consulted, because the user is mid-dictation.)
- **Cloud mark** — A small cloud in the microphone's corner while a session runs on either cloud service.
- **Dictation mirror** — The layer that draws the composer's text during a live dictation, so the partial can be lighter than the rest.

## User Stories / Flows

### Dictating
1. The user clicks the microphone. It turns red and pulses while it records, and the composer takes focus.
2. Words appear at the caret as they are heard; with a selection, the first words replace it (until then it stays selected). The words still being worked out are drawn lighter than the confirmed text and may change; confirmed text settles in the draft. A space is added before the words when the text before them does not end in whitespace, and after them when the text after starts with a word.
3. The user clicks the microphone again. It becomes a spinner and is disabled ("Finishing…") while the engine confirms the last words, which then turn normal. Nothing is sent.
4. The first dictation on a Mac asks for the Speech Recognition permission; the first recording asks for the Microphone permission.

### While the words are appearing
1. **Typing.** The words are typed out like a quick typist's: about 45 characters a second, deleting about 90 a second. When the recognizer revises earlier words, they are backspaced to where old and new agree and retyped. A backlog is caught up in proportion, so the display trails the recognizer by well under a second. A revision that reaches back more than 24 characters (a confirmed segment re-punctuating itself) is swapped in place at once. With reduced motion, the text simply appears.
2. **A keystroke, a paste or a file drop** ends the dictation and keeps all its words, lighter ones included, as plain text, even words the display had not typed out yet; the keystroke then does its normal work, as if the words had already been typed out (a key at the end goes after them).
3. **Esc** stops listening and keeps only the confirmed text; the lighter words are dropped.
4. **Enter** (not Shift+Enter), the **Send button** or a **headphone double click** stops listening, waits for the last words to land in the draft, and sends once.
5. **The caret follows** the end of the dictated text. If the user clicks or arrows elsewhere, it stays where they put it (counted from the end when it sits after the dictation, since text grows only there) and a user selection is kept whole.
6. **Silence** ends in silence: a dictation in which nothing was heard stops without a toast. Only a recording under a quarter of a second gets "Nothing was recorded."

### From the headphones (EarPods, AirPods)
1. A single click on the headphone button does what a click on the microphone does.
2. A double click while idle sends the draft exactly as Send would, and does nothing where Send is disabled or where Stop stands in its place. A double click never stops a turn.
3. A double click while recording stops, waits for the last words and sends once they are in the draft. A double click while the last words are finishing sends once they land. Any failure (permission denied, an error, a cancel or a freeze) drops the send, so a draft without the dictation never goes out.

### Choosing the microphone
1. Right-click the microphone. A menu lists **System default** and every audio input, with a check on the one in use.
2. The choice is remembered on this machine. A remembered microphone that is unplugged records from the system default, and the menu shows System default checked.
3. Before the first recording the menu shows only System default, because the system hides microphone names until the Microphone permission is granted.

### Hiding and showing it
1. The same right-click menu ends with an **Audio input** switch. Turning it off hides the button and shows an info toast that says where to turn it back on, with a link to Settings → Features. A recording in progress is discarded, and the toast says so.
2. The button is hidden by default. **Settings → Features → Interface → Audio input** turns it on. The row is always rendered, above Cloud transcription, so choosing a mode never inserts a row above the control under the pointer; where voice input is unavailable it is disabled and unchecked, and its (?) says to turn on Cloud transcription below. Its (?) text says where the audio goes and follows the cloud mode: on this Mac only; on this Mac with Gemini as the fallback; or Gemini, billed to the user's key.

### Cloud transcription
1. **Settings → Features → Interface → Cloud transcription** is a three-button group, **Off** (default), **As a fallback** and **Always**, shaped like Theme's. Under it, a **Service** select (Cinna server / My Gemini key) shows whenever a mode is not Off, so choosing from it never makes it vanish under the pointer. With Service on My Gemini key and more than one usable Gemini provider, a **Gemini provider** picker appears; with one, it is used.
2. Settings never read the signed-in account ([ux_rules rule 21](../../development/ui_guidelines/ux_rules.md)): Features is app-wide, the app holds several profiles on different Cinna servers, and a row that said what this server offers, or how many minutes it has left, would change on a profile switch for a value that is the same on both. So the Cinna server is always selectable, the mode pills are never locked by what a server offers, and there is no availability row, no monthly-minutes row and no server name. Whether the current account's server offers transcription is found out when a dictation starts, and said there as an error toast. The Gemini key comes only from the user's own **AI Credentials** (Default scope); an account-provisioned Gemini row is never offered or billed, because it vanishes on a profile switch. A Service of My Gemini key with no such credential shows a status row that sends the user to AI Credentials.
3. Turning a mode on from Off with no service saved saves **Cinna server** in the same step (never the billed key), so every running mode has an explicit service. With a mode on and no service saved (never chosen), the select reads **Choose…** and nothing runs in the cloud until the user picks.
4. The Settings text names the Cinna server as "the server of the account you are signed in to when you dictate", never a server by name.
5. While a session runs in the cloud the microphone wears a cloud mark (tooltip names who gets the audio: Google, or the Cinna server).
6. On Linux and Windows there is no on-device engine; voice input exists there only through a cloud service (As a fallback or Always, on the Cinna server or with a Gemini key).

### Cinna server relay
1. If the profile is signed in to a Cinna server whose discovery document offers voice transcription, the relay is available. Main reads that in the background (cached per profile and server, re-read when stale and when the profile becomes ready); a status read never waits for the network, so the relay appears a moment after sign-in rather than delaying anything.
2. When an on-device session fails (`unavailable` or `failed`, not a permission refusal, not silence) and the relay is available, a modal **Dictation stopped** gives the reason and asks: **Continue** with the server (**Finish** if the user had already stopped), or **Keep the text** (the default; Esc or a click outside is the same). This happens in any cloud mode, including Off, because the user is asked every time.
3. Only on Continue or Finish does any audio leave the computer. The recorder replays the audio not yet confirmed by a final (at most 60 s, plus 1 s kept past each final because words spoken while a final was in flight are not in it), then goes live again, and the words continue at the end of the dictated text. The dialog says how many seconds will be sent. Keep the text discards that audio and sends nothing.
4. Gemini on the user's key is never offered this way, and a Gemini failure never offers anything.
5. While the dialog is open the headphone button neither starts a dictation nor sends the draft, and a send that was pending when the dictation failed is dropped.

### When it cannot work
1. Speech Recognition denied or restricted: the button is still shown, dimmed; a click explains where to allow it in System Settings instead of recording. Coming back from System Settings enables it without a restart.
2. Microphone denied, no microphone, microphone busy, nothing heard (batch only), a recording under a quarter of a second, a language with no on-device model, or a helper failure: an error toast with the reason. In live dictation a fatal failure ends the dictation at once: the confirmed text stays in the draft, the unconfirmed tail is lost, and there is no retry through the batch path.

## Business Rules

- **Recognition never leaves the Mac unless the user turned cloud transcription on.** SFSpeechRecognizer is always asked for on-device recognition; for a language with no on-device model it refuses with an error toast rather than send the audio to Apple's servers. This was the user's decision, so that the settings row can promise that Cinna sends the recording nowhere while cloud transcription is Off. SpeechAnalyzer is on-device by design. The on-device path never falls back to Gemini on its own account: only the setting sends audio there.
- **Backend choice, per transcription.** On macOS 26+, when SpeechTranscriber supports the language and its model is installed, SpeechAnalyzer runs. While the model is missing, the recording is transcribed by SFSpeechRecognizer and main starts one background model install; later transcriptions pick SpeechAnalyzer up by themselves. If SpeechAnalyzer fails, the same recording is retried on SFSpeechRecognizer, because a new API on a new OS should never cost the user a dictation.
- **The macOS 26 path has not been run on a real machine**, for batch transcription or for streaming. It builds against the macOS 26 SDK and is covered by unit tests of main's side, but every hands-on test so far was on macOS 15, i.e. the SFSpeechRecognizer path. Treat SpeechAnalyzer behaviour, including its live partial/final cadence, as unverified until someone dictates on macOS 26.
- **Cloud mode is decided once, when a session starts.** Off: on-device only. Always: Gemini. As a fallback: Gemini only when no on-device engine is supported (not macOS, no helper, a failed probe). A refused Speech Recognition permission is the user's answer, not an outage, and does not fall back. **A session never switches engine midway.** An on-device failure while recording is an error, never a silent move to a cloud service; the user consented to the cloud per dictation, not per failure. No cloud fallback is ever silent: audio leaves the device only with the user's consent. When the relay is available the error becomes the offer, and a new session on the relay starts only on the click.
- **No cloud service is chosen implicitly.** The session runs on the Service setting, never swapped for the other when it is unusable. The empty setting (never chosen) never runs, whatever the active account's server offers, and is never read as consent to either service. On upgrade, an install that already had a cloud mode on was pinned once to My Gemini key, because that was the only service it had consented to; otherwise an unset value would pick a service by what the signed-in server happens to offer.
- **Gemini runs on the user's own key and bills it.** The key is the chosen Gemini provider's (the picked one if usable, else the first usable: enabled, with a key, not marked unsupported). Without one the dictation fails with a toast pointing at AI Credentials. A rejected key and an exhausted quota are named with the provider's name.
- **The cloud services are live-only.** The batch path answers `unavailable` for Gemini and for the relay, because batch exists only for a preload without streaming.
- **The relay is paid for by the server.** The audio goes to the user's Cinna server, which bills nothing to the user's keys; the user's own limit is the server's monthly minutes. The Settings (?) text says so in place of "billed to your key" and never says "on this Mac" for a dictation that is not.
- **Language** is the Mac's own (the user's current locale); the composer does not choose one.
- **One recording at a time.** A live dictation and a batch transcription share one slot; a second request while one runs is answered busy, not queued. The slot is held until the session ends, including while the last words finalize.
- **Time limits.** Batch: one minute plus twice the recording's length, so a long dictation is not killed halfway and the first run has time for the system permission prompt. Live: 30 minutes of audio, after which the dictation stops itself as if the user had stopped it; after a stop the engine has 10 s in main (25 s in the renderer) to finish, and what was confirmed or pending by then is kept. On the relay the 10 s starts when the stop is actually sent to the server, not before: token refresh, connecting and the replay burst are not the server's delay, and the wait for an open socket has its own 10 s limit from the start; each replayed second adds 0.5 s to it, in main and in the renderer. A relay that answers nothing at all is a failure; one that answered with finals ends with them.
- **Confirmed text is the draft; the partial is not.** Only finals are written into the draft, so a crash, a cancel or an unmount can never leave half-guessed words in it. Everything that ends a dictation without finishing it either keeps the partial deliberately (a keystroke, paste or drop) or drops it (Esc).
- **Segments on the SFSpeechRecognizer path.** SFSpeechRecognizer starts a new running text after about 3 s of pause and about every 60 s. The result delivered just before each reset is taken as a confirmed segment, which is how a long dictation keeps its earlier words.
- **The button never moves its neighbours.** It keeps one box through idle, recording and transcribing, and the speech status is fetched when the app starts so the button and the settings row never appear a beat after their surface ([UX rules](../../development/ui_guidelines/ux_rules.md) §1).
- **Recording red is not Stop red.** Recording shows the same microphone, red and pulsing; an earlier red square was rejected because it read as the turn's Stop button.
- **Errors are toasts, not the composer's error line**, because voice input is often used from headphones, heard rather than watched. Starting the next recording takes down the error toast this composer showed, and never anyone else's toast.
- **A chat switch ends the dictation.** A recording in progress is cancelled (the confirmed words already in that chat's draft stay). A dictation that is only waiting for its last words, or a batch transcription in flight, still lands in the draft of the chat it was dictated in, and is never sent from the new chat.
- **The headphone button belongs to Cinna only while a composer with voice input is on screen and the window is focused.** On blur it is handed back to whatever else plays.

### Headphone button limits (platform, not fixable here)
- Works only in music mode. Opening an AirPods microphone switches them to the call profile, and the stem click may stop arriving; record with the Mac's microphone when using the headphone button.
- No press-and-hold: holding is reserved for Siri or noise control, and apps receive only finished commands.
- While Cinna is focused it owns Now Playing, so Music or Spotify do not get the headphone button.

### Known gaps
- SFSpeechRecognizer error 1110 during a long silence is treated as the end of the audio, so a session can end early in a long pause. Not yet observed to matter; not handled.
- Returning to a chat while its dictation is still finishing: the Enter that was to send is lost, and a new microphone click in that window is answered busy until the old session ends.
- The relay has not been run against a real Cinna server yet. It is covered by unit tests with a local WebSocket server and, for the dialog and Settings rows, by screenshots with a faked engine. Treat the live protocol behaviour (cadence of partials and finals, the stop and error frames, the refused upgrade) as unverified until a session runs against a real core.
- Gemini: a long dictation is carried over several connections (Google ends one at about 10 minutes); the audio is split at an arbitrary point, which can cut a word at the seam.
- Gemini: when the user stops before the connection has finished setting up, the queued audio goes out in one burst and Gemini may join two sentences without a space ("composer.This").
- There is no batch fallback in live mode: a fatal error loses the unconfirmed tail (the confirmed text is kept).

## Architecture Overview

```
Live: Mic button / headphone click -> recorder (16 kHz mono PCM, ~100 ms chunks)
  -> window.api.speech.stream (MessagePort) -> speech:stream -> speechService (engine chosen once per session)
  -> macos engine -> cinna-speech stream (PCM on stdin, NDJSON on stdout)
  -> or, per the cloud setting: gemini engine -> Gemini Live WebSocket (user's key, main only)
  -> or core engine -> WebSocket of the profile's Cinna server (Bearer token, main only)
  <- on-device fatal error + relay available: error carries an offer -> dialog -> (Continue) new session
     on the relay, unconfirmed PCM replayed first
  <- start | partial | final | engine-change | error | stop -> draft (finals) + mirror (partial)
Batch (no speech.stream): Mic button / headphone click -> recorder (16 kHz mono WAV) -> window.api.speech.transcribe
  -> speech:transcribe -> speechService -> macos engine -> cinna-speech transcribe
     -> SpeechAnalyzer (macOS 26+, model installed) | SFSpeechRecognizer (on-device only)
  <- text | failure code -> draft (append) | error toast
Startup: main -> speechService.startProbe() -> cinna-speech probe -> speech:status -> button + settings row
```

## Integration Points

- [Conversation UI](../conversation_ui/conversation_ui.md) — dictation is appended to the composer draft, which outlives the composer; that is why a late transcription still lands.
- [Pending Messages](../pending_messages/pending_messages.md) — the headphone double click uses the same Send rules, including Stop standing in for Send on an empty input during a turn.
- [Settings](../../ui/settings/settings.md) — the Features → Interface **Audio input** and **Cloud transcription** (Mode and Service) rows.
- Cinna server account — the relay uses the profile's server URL and access token, and its discovery document says whether the relay exists. The wire protocol (v1) is owned by cinna-core: its `docs/application/voice_transcription/voice_transcription.md`.
- [AI Credentials](../../llm/adapters/provider_integration.md) — the Gemini provider whose key cloud transcription uses and bills.
- [App Shell](../../ui/app_shell/app_shell.md) — the app-wide toast, whose `kind` (info, error) voice input uses.
- [Release & Distribution](../../development/distribution/release.md) — the helper ships inside the macOS app, with the Speech Recognition usage string and the audio-input entitlement.
- [Resource Activation](../../core/resource_activation/resource_activation.md) — transcription requires an activated session; the status read does not.
- Technical details: [voice_input_tech.md](voice_input_tech.md). LLM reference: [voice_input_llm.md](voice_input_llm.md).
