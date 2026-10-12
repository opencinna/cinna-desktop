# Voice Input

## Purpose

A microphone button left of Send in the chat composer turns what the user says into text in the draft, using macOS's own speech recognition on the Mac. The text is never sent by itself; the user reads it, edits it and sends it, or sends it from the headphone button.

## Core Concepts

- **Voice input button** — The microphone beside Send. It exists only where main reports a working speech engine (today: macOS with the bundled helper) and the user has not hidden it.
- **Speech engine** — One speech-to-text backend in main. Only `macos` exists; the boundary is there so an OpenAI or remote engine can be added beside it later.
- **Backend** — Which Apple recognizer the `macos` engine runs. **SpeechAnalyzer** (with SpeechTranscriber) on macOS 26 and later once that language's model is installed; **SFSpeechRecognizer** everywhere else. Reported in the speech status for diagnostics only; the user never sees it.
- **Speech helper** — `cinna-speech`, a small native program shipped inside the app. Main runs it once per probe or transcription. Both backends live in this one helper.
- **Speech status** — Main's answer to "does voice input work here": supported or not, the engine, the backend, and the Speech Recognition permission state.
- **Dictation** — One recording: started by a click, stopped by the next, transcribed, and appended to the draft.

## User Stories / Flows

### Dictating
1. The user clicks the microphone. It turns red and pulses while it records.
2. The user clicks it again. It becomes a spinner and is disabled while the recording is transcribed.
3. The text joins the end of the draft after a space, and the cursor moves to its end. Nothing is sent.
4. The first transcription on a Mac asks for the Speech Recognition permission; the first recording asks for the Microphone permission.

### From the headphones (EarPods, AirPods)
1. A single click on the headphone button does what a click on the microphone does.
2. A double click while idle sends the draft exactly as Send would, and does nothing where Send is disabled or where Stop stands in its place. A double click never stops a turn.
3. A double click while recording stops, transcribes and sends once the text is in the draft. A double click while transcribing sends once the text lands. Any failure (nothing heard, permission denied, an error) drops the send, so a draft without the dictation never goes out.

### Choosing the microphone
1. Right-click the microphone. A menu lists **System default** and every audio input, with a check on the one in use.
2. The choice is remembered on this machine. A remembered microphone that is unplugged records from the system default, and the menu shows System default checked.
3. Before the first recording the menu shows only System default, because the system hides microphone names until the Microphone permission is granted.

### Hiding and showing it
1. The same right-click menu ends with a **Show audio input** switch. Turning it off hides the button and shows an info toast that says where to turn it back on, with a link to Settings → Features. A recording in progress is discarded, and the toast says so.
2. The button is hidden by default. **Settings → Features → Interface → Show audio input** turns it on. That row exists only where voice input is supported.

### When it cannot work
1. Speech Recognition denied or restricted: the button is still shown, dimmed; a click explains where to allow it in System Settings instead of recording. Coming back from System Settings enables it without a restart.
2. Microphone denied, no microphone, microphone busy, nothing heard, a recording under a quarter of a second, a language with no on-device model, or a helper failure: an error toast with the reason.

## Business Rules

- **Recognition never leaves the Mac.** SFSpeechRecognizer is always asked for on-device recognition; for a language with no on-device model it refuses with an error toast rather than send the audio to Apple's servers. This was the user's decision, so that the settings row can promise that Cinna sends the recording nowhere. SpeechAnalyzer is on-device by design.
- **Backend choice, per transcription.** On macOS 26+, when SpeechTranscriber supports the language and its model is installed, SpeechAnalyzer runs. While the model is missing, the recording is transcribed by SFSpeechRecognizer and main starts one background model install; later transcriptions pick SpeechAnalyzer up by themselves. If SpeechAnalyzer fails, the same recording is retried on SFSpeechRecognizer, because a new API on a new OS should never cost the user a dictation.
- **The macOS 26 path has not been run on a real machine.** It builds against the macOS 26 SDK and is covered by unit tests of main's side, but every hands-on test so far was on macOS 15, i.e. the SFSpeechRecognizer path. Treat SpeechAnalyzer behaviour as unverified until someone dictates on macOS 26.
- **Language** is the Mac's own (the user's current locale); the composer does not choose one.
- **One transcription at a time.** A second request while one runs is answered busy, not queued.
- **Time limit**: one minute plus twice the recording's length, so a long dictation is not killed halfway and the first run has time for the system permission prompt.
- **The button never moves its neighbours.** It keeps one box through idle, recording and transcribing, and the speech status is fetched when the app starts so the button and the settings row never appear a beat after their surface ([UX rules](../../development/ui_guidelines/ux_rules.md) §1).
- **Recording red is not Stop red.** Recording shows the same microphone, red and pulsing; an earlier red square was rejected because it read as the turn's Stop button.
- **Errors are toasts, not the composer's error line**, because voice input is often used from headphones, heard rather than watched. Starting the next recording takes down the error toast this composer showed, and never anyone else's toast.
- **A chat switch ends the dictation.** A recording in progress is discarded. A transcription already in flight still lands in the draft of the chat it was dictated in, and is never sent from the new chat.
- **The headphone button belongs to Cinna only while a composer with voice input is on screen and the window is focused.** On blur it is handed back to whatever else plays.

### Headphone button limits (platform, not fixable here)
- Works only in music mode. Opening an AirPods microphone switches them to the call profile, and the stem click may stop arriving; record with the Mac's microphone when using the headphone button.
- No press-and-hold: holding is reserved for Siri or noise control, and apps receive only finished commands.
- While Cinna is focused it owns Now Playing, so Music or Spotify do not get the headphone button.

## Architecture Overview

```
Mic button / headphone click -> recorder (16 kHz mono WAV) -> window.api.speech.transcribe
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
