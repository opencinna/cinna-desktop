# Voice Input

## Purpose

A microphone button left of Send in the chat composer turns what the user says into text in the draft, using macOS's own speech recognition on the Mac. The words appear at the caret while the user is still speaking. The text is never sent by itself; the user reads it, edits it and sends it, or sends it from the headphone button.

## Core Concepts

- **Voice input button** — The microphone beside Send. It exists only where main reports a working speech engine (today: macOS with the bundled helper) and the user has not hidden it.
- **Speech engine** — One speech-to-text backend in main. Only `macos` exists; the boundary is there so an OpenAI or remote engine can be added beside it later.
- **Backend** — Which Apple recognizer the `macos` engine runs. **SpeechAnalyzer** (with SpeechTranscriber) on macOS 26 and later once that language's model is installed; **SFSpeechRecognizer** everywhere else. Reported in the speech status for diagnostics only; the user never sees it.
- **Speech helper** — `cinna-speech`, a small native program shipped inside the app. Main runs it once per probe, transcription or live dictation. Both backends live in this one helper.
- **Speech status** — Main's answer to "does voice input work here": supported or not, the engine, the backend, and the Speech Recognition permission state.
- **Dictation** — One recording: started by a click, stopped by the next, its words written into the draft at the caret.
- **Live dictation** — A dictation whose audio streams to the helper while the user speaks. The engine answers with **partial** text (the current unconfirmed segment, revised as more is heard) and **final** text (confirmed, never revised). Confirmed text is written into the draft; the partial is only shown.
- **Batch dictation** — The older shape: record, stop, transcribe the whole WAV, append. Used only where the preload has no streaming (`speech.stream` missing).
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
1. The same right-click menu ends with a **Show audio input** switch. Turning it off hides the button and shows an info toast that says where to turn it back on, with a link to Settings → Features. A recording in progress is discarded, and the toast says so.
2. The button is hidden by default. **Settings → Features → Interface → Show audio input** turns it on. That row exists only where voice input is supported.

### When it cannot work
1. Speech Recognition denied or restricted: the button is still shown, dimmed; a click explains where to allow it in System Settings instead of recording. Coming back from System Settings enables it without a restart.
2. Microphone denied, no microphone, microphone busy, nothing heard (batch only), a recording under a quarter of a second, a language with no on-device model, or a helper failure: an error toast with the reason. In live dictation a fatal failure ends the dictation at once: the confirmed text stays in the draft, the unconfirmed tail is lost, and there is no retry through the batch path.

## Business Rules

- **Recognition never leaves the Mac.** SFSpeechRecognizer is always asked for on-device recognition; for a language with no on-device model it refuses with an error toast rather than send the audio to Apple's servers. This was the user's decision, so that the settings row can promise that Cinna sends the recording nowhere. SpeechAnalyzer is on-device by design.
- **Backend choice, per transcription.** On macOS 26+, when SpeechTranscriber supports the language and its model is installed, SpeechAnalyzer runs. While the model is missing, the recording is transcribed by SFSpeechRecognizer and main starts one background model install; later transcriptions pick SpeechAnalyzer up by themselves. If SpeechAnalyzer fails, the same recording is retried on SFSpeechRecognizer, because a new API on a new OS should never cost the user a dictation.
- **The macOS 26 path has not been run on a real machine**, for batch transcription or for streaming. It builds against the macOS 26 SDK and is covered by unit tests of main's side, but every hands-on test so far was on macOS 15, i.e. the SFSpeechRecognizer path. Treat SpeechAnalyzer behaviour, including its live partial/final cadence, as unverified until someone dictates on macOS 26.
- **Language** is the Mac's own (the user's current locale); the composer does not choose one.
- **One recording at a time.** A live dictation and a batch transcription share one slot; a second request while one runs is answered busy, not queued. The slot is held until the session ends, including while the last words finalize.
- **Time limits.** Batch: one minute plus twice the recording's length, so a long dictation is not killed halfway and the first run has time for the system permission prompt. Live: 30 minutes of audio, after which the dictation stops itself as if the user had stopped it; after a stop the engine has 10 s in main (20 s in the renderer) to finish, and what was confirmed or pending by then is kept.
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
- There is no batch fallback in live mode: a fatal error loses the unconfirmed tail (the confirmed text is kept).

## Architecture Overview

```
Live: Mic button / headphone click -> recorder (16 kHz mono PCM, ~100 ms chunks)
  -> window.api.speech.stream (MessagePort) -> speech:stream -> speechService -> macos engine
  -> cinna-speech stream (PCM on stdin, NDJSON on stdout)
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
- [Settings](../../ui/settings/settings.md) — the Features → Interface **Show audio input** row.
- [App Shell](../../ui/app_shell/app_shell.md) — the app-wide toast, whose `kind` (info, error) voice input uses.
- [Release & Distribution](../../development/distribution/release.md) — the helper ships inside the macOS app, with the Speech Recognition usage string and the audio-input entitlement.
- [Resource Activation](../../core/resource_activation/resource_activation.md) — transcription requires an activated session; the status read does not.
- Technical details: [voice_input_tech.md](voice_input_tech.md). LLM reference: [voice_input_llm.md](voice_input_llm.md).
