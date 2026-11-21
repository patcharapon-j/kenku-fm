# GM-only Preview

Kenku FM's GM-only preview lets the GM audition any playlist track or soundboard sound privately on their own headphones or speakers before the table hears it. Preview audio never enters Discord, the Stream Kit's `music`/`sfx` Voice Room tracks, or any "now playing" report.

## Design goals

During a live session the main risk is **mode confusion**: broadcasting something meant to be previewed, or previewing when trying to fire live audio. Every interaction is designed to make **Live (table hears it)** and **Preview (only you hear it)** impossible to mistake for each other:

1. **Dedicated Preview Deck, physically separate from the Live Player**
   - When a preview is loaded, a separate floating **Preview Deck** appears above the live player with a clear gap between them (never fused into the same card).
   - It uses an unmistakable **amber** accent and warm dark amber surface paired with a **Headphones** icon and the explicit label **"PREVIEW · Only you hear this"**.
   - While the Preview Deck is open, the live player card below it displays a matching lavender border and **"LIVE · Table hears this"** header strip so both decks contrast explicitly side by side.
   - When no preview is active, the Preview Deck is hidden so the player stays uncluttered.

2. **Separate Preview triggers that cannot be mistaken for Live Play**
   - **Playlist tracks:** an amber-accented **Headphones** button sits next to the live Play/Pause button with clear spacing and tooltip *"Preview (only you hear this)"*. It never uses a plain play triangle.
   - **Soundboard pads:** the **Headphones** preview button is placed in the top-right card header next to the menu button, physically separated from the large bottom-right live Play/Stop button so a GM cannot fat-finger live playback when reaching to audition an SFX.
   - **All audio (Library):** an amber outlined **Preview** button with a Headphones icon sits beside the **Play** button.
   - Clicking a row's Headphones button starts previewing that item; clicking it again while previewing stops it immediately (one-click audition on/off).

3. **Preview Deck controls**
   - Shows the item title, source playlist or soundboard name, item kind (`Track` or `Sound`), a scrubbable seek bar with elapsed/remaining timestamps, Play/Pause, Close (`×`), and its own **independent preview volume and mute** (persisted separately from live playlist volume and monitor gain).
   - Previewing always plays once and stops cleanly at the end (it never loops indefinitely), leaving the deck ready to replay or promote.

4. **Promoting a preview to live ("Play live")**
   - The Preview Deck includes a lavender-styled **"Play live"** button (matching the live player's colour so crossing into broadcast is visibly intentional).
   - For a **playlist track**, clicking **"Play live"** (labeled *"Play live from M:SS"* once scrubbed past 0:00) immediately stops and closes the preview, starts the track in its playlist queue, and begins live playback from that same position. If that track is already live, it stops the preview, seeks the live track to the previewed position, and resumes live playback if paused.
   - For a **soundboard sound**, clicking **"Play live"** immediately stops and closes the preview and triggers the sound live from the start with its configured volume, fade, and loop settings.

5. **Local monitor ducking (GM headphones only — never disrupts PC voices)**
   - While a preview plays, Kenku FM's own local monitor of the live mix smoothly ducks by −12 dB (25% linear gain) so the preview is easy to hear over loud battle music.
   - Ducking happens strictly **after** the broadcast worklet in the Audio Capture window: it never touches Discord, the Stream Kit, or the output level meters.
   - It never touches OS mixer levels, communications/ducking APIs, or microphone capture, and uses standard shared-mode playback (`latencyHint: "playback"`), so player voices coming from Discord or the Stream Kit Voice Room are never ducked, interrupted, or switched out of high-quality audio profiles.
   - A persisted **Duck live** toggle on the Preview Deck lets the GM turn ducking off whenever they want to hear how a sound or track blends against the live mix at full level.
   - Preview works identically whether active live audio is routed to **This Computer**, **Discord**, **Stream Kit**, or any combination (including browser tabs like YouTube/Spotify playing live while previewing a library track).

6. **Keyboard and focus behaviour**
   - Pressing **Escape** (when no dialog, menu, or text field is active) immediately stops and closes the preview deck.
   - Inside the Preview Deck, **Space** toggles preview play/pause (never live playback) and arrow keys on the seek slider scrub only the preview.
   - Clicking a track or sound's Preview button does not steal focus from the list, making it fast to audition several tracks in a row.
   - **"Play live"** has no bare single-key shortcut, preventing accidental broadcasts.
   - OS hardware media keys (`MediaSession`) remain bound strictly to live playlist playback and never show or control preview audio.

7. **Previewing the currently live track or sound**
   - Allowed and completely non-destructive: starting, seeking, or stopping a preview never interrupts live playback.
   - Both states remain visibly marked on the item (lavender live highlight + amber preview highlight), and the Preview Deck shows an **"Also playing live"** badge.

## Audio routing and isolation

Anything the Player view (`src/player/`) outputs through its `AudioContext`, Howler, or `<audio>` elements is captured by Chromium tab capture (`chromeMediaSource: "tab"`) into the Discord broadcast, and anything hitting `outputBuses` (`music` / `sfx`) is published to LiveKit by `StreamKitVoice`.

Preview playback therefore **never runs inside the Player view**:

```
Player View (tab-captured -> Discord; outputBuses -> Stream Kit)
  │  IPC: PLAYER_PREVIEW_* (authorized to registered player main frame only)
  ▼
Main Process (PreviewManager)
  │  resolves file:// -> kenku-media://local/<token>/...
  │  forwards to hidden Audio Capture window
  ▼
Audio Capture Window (not tab-captured)
  ├── Live Capture Graph (unchanged):
  │     views + inputs -> PCMStream AudioWorklet -> Opus/PCM (Discord) + AUDIO_CAPTURE_LEVELS
  │                            └─> _monitorGainNode -> _monitorDuckGainNode -> _audioOutputElement
  │                                                      (muted when "This Computer" is unticked)
  └── PreviewAudioEngine (separate AudioContext, never connected to PCMStream):
        kenku-media:// -> <audio crossOrigin="anonymous">
          -> GainNode (preview volume/mute)
          -> MediaStreamAudioDestinationNode
          -> <audio> (setSinkId = monitorDeviceId, never muted by loopback)
        http(s):// remote URL fallback -> <audio> directly with setSinkId = monitorDeviceId
```

Because `PreviewAudioEngine` runs in the uncaptured Audio Capture window on its own `AudioContext` and outputs through its own `<audio>` element with `setSinkId(monitorDeviceId)`:

- **Discord broadcast & meter (`AUDIO_CAPTURE_LEVELS`):** zero samples from preview ever enter `_pcmStreamNode`.
- **Stream Kit (`music` / `sfx` bus taps):** zero samples from preview ever enter the Player view's `AudioContext` or `Howler`.
- **"This Computer" unticked (`loopback = false`):** only `_audioOutputElement` (the live monitor) is muted; `_previewOutputElement` stays unmuted and routed to the chosen Monitor Device, so a GM monitoring the live mix through the Voice Room still hears previews clearly.
- **Now-playing / HTTP remote / Stream Deck:** preview state lives in its own `preview` Redux slice (`src/player/features/preview/previewSlice.ts`) and is never read by `StreamKitBridge`, `PlaylistRemote`, `SoundboardRemote`, or `PlaylistMediaSession`.
- **Media protocol security:** `PreviewManager` (`src/main/managers/PreviewManager.ts`) accepts preview commands only from the registered player `webContents` main frame, rejects schemes other than `file:`, `http:`, and `https:`, and resolves `file://` paths to `kenku-media://` capability URLs in the main process before forwarding them solely to the hidden Audio Capture window.

## Verification

Run type checking and the unit test suite:

```sh
./node_modules/.bin/tsc --noEmit
node --test tests/gm-preview.test.cjs tests/library-audio.test.cjs tests/stream-kit-client.test.cjs tests/stream-kit-manager.test.cjs
```
