# Kenku FM — Audio Pipeline Improvement Plan

**Status:** proposal, awaiting approval before implementation
**Scope:** Discord connection stability, stream quality, playlist crossfade
**Baseline:** v1.5.5, branch `claude/peaceful-mendel-fscwko`

---

## 1. Why this document exists

Three goals drove this review:

1. A more stable Discord connection — fewer dropouts.
2. Higher quality music streaming.
3. Crossfade between local music files.

Every finding below was verified against the source at the cited `file:line`. Claims of the form
"X is never called" were verified by a repository-wide grep returning zero matches; those greps are
listed in §4.6 so they can be re-run.

### Settled decisions

These were agreed before any code was written and constrain everything that follows.

| # | Decision | Choice |
|---|---|---|
| 1 | Deliverable | Report first, then implement what is approved |
| 2 | Native modules | Allowed. Newest/best library available may be used |
| 3 | Relationship to upstream | Full divergence. No PRs back to `owlbear-rodeo/kenku-fm` |
| 4 | Observed symptoms | Bot drops out of voice **and** audio crackles/stutters |
| 5 | Crossfade duration | One global, persisted setting. `0` disables |
| 6 | Fade curve | Equal-power, hand-stepped. Limiter added as a separate change |
| 7 | "Now playing" during overlap | Flips at crossfade start |
| 8 | Which transitions crossfade | Automatic advance **and** manual skip. Not `repeat: "track"` |
| 9 | Local-file architecture | Fix the existing path first; rewrite only if measurement demands it |
| 10 | PCM transport | Move to `MessagePortMain`; land the security fixes first |
| 11 | Reconnect policy | Rejoin recoverable states with capped backoff; restore channels |
| 12 | Opus parameters | Match the voice channel's own bitrate; enable FEC |
| 13 | Electron | Stay on the castlabs Widevine build |

---

## 2. The pipeline as it stands

```
                   ┌──────────────────────────────────────┐
  local files ───► │ player renderer (WebContentsView)    │
                   │   Howler, html5:true, one Howl       │
  web content ───► │ browser views (YouTube/Spotify/…)    │
                   └───────────────┬──────────────────────┘
                                   │  Chromium tab capture
                                   │  getUserMedia chromeMediaSource:"tab"
                                   ▼
                   ┌──────────────────────────────────────┐
                   │ hidden capture window (own process)  │
                   │   AudioContext 48k, latencyHint      │
                   │     "playback"                       │
                   │   per-source GainNode ──► master Gain│
                   │   master ──► PCMStream AudioWorklet  │
                   │   master ──► <audio> loopback monitor│
                   └───────────────┬──────────────────────┘
                                   │  Int16 PCM over ws://localhost
                                   ▼
                   ┌──────────────────────────────────────┐
                   │ main process                         │
                   │   prism.opus.Encoder (opusscript)    │
                   │   createAudioResource ─► AudioPlayer │
                   │   VoiceConnection.subscribe          │
                   └──────────────────────────────────────┘
```

Two facts about this shape matter throughout:

- **Local music and web audio share one pipeline.** Anything that improves the shared path improves
  both. Anything that only improves local files leaves YouTube and Spotify untouched.
- **The capture window is a separate OS process.** This rules out `SharedArrayBuffer` between the
  worklet and the main process — shared memory cannot cross a process boundary in Electron.

---

## 3. Findings

Ordered by severity. Each is independently fixable.

### S1 — There is no voice reconnect logic whatsoever

**This is the direct cause of the "bot drops out of VC" symptom.**

`src/main/broadcast/DiscordBroadcast.ts` is the entire voice layer, 173 lines. It creates a
connection at `:123`, subscribes the player at `:128`, and registers exactly one handler — a
`connection.on("error")` at `:130` that destroys the connection and gives up.

Verified absent from the whole repository: `entersState`, `VoiceConnectionStatus`,
`AudioPlayerStatus`, `rejoin`. All zero matches.

Consequences:

- Close code **4014** (voice server crash, region move, channel deleted) is never handled. The
  connection sits in `Disconnected` forever. Audio stops; the UI still shows the channel as joined.
- `DISCORD_CHANNEL_JOINED` is emitted at `:129`, **synchronously after `joinVoiceChannel`** and
  before the connection reaches `Ready`. The UI reports success while the connection is still
  signalling — so a join that never completes looks identical to one that did.
- `connection.on("error")` is registered at `:130`, *after* the subscribe and the success reply. An
  error thrown during those two lines is caught only by the outer `try`/`catch`.
- After an `AudioPlayer` error the player goes Idle and nothing replays the resource. Playback is
  dead until the user restarts capture. The only handler (`:39`) logs and shows a message.
- `destroy()` never destroys voice connections or the audio player, leaking connections.
- `_handleDisconnect` (`:111`) and `_handleLeaveChannel` (`:163`) dereference `this.client` and the
  connection unguarded. Double-leave throws a `TypeError`.
- Nothing restores the previously selected voice channels after a Discord client reconnect.

### S2 — Opus encoding is pure JavaScript

`package.json` ships **`opusscript`** and nothing else. No `@discordjs/opus`, no `node-opus`
(confirmed against `yarn.lock`). `opusscript` is a pure-JS/WASM Opus implementation, and it encodes
48kHz stereo on the main process thread every 20ms.

When that encoder cannot keep its deadline, frames arrive late or not at all — which is heard as
crackle and stutter, and which `@discordjs/voice` eventually reports as a stalled stream. This is the
most likely single cause of the second reported symptom.

`@discordjs/opus` 0.10.0 is available and is a native libopus binding.

`@timfish/forge-externals-plugin` is already configured (`forge.config.js:92-97`) with
`includeDeps: true` — the packaging machinery for native modules is already in place.

### S3 — No Opus parameters are set at all

`src/main/managers/AudioCaptureManagerMain.ts:158-162`:

```ts
const encoder = new prism.opus.Encoder({
  channels: channels,
  frameSize: frameSize,
  rate: sampleRate,
});
```

That is the complete configuration. Verified zero matches for `setBitrate` and `setFEC` anywhere in
`src/`. The stream runs at whatever libopus defaults to, with **inband FEC off**.

Discord voice channels carry their own `bitrate` — 96kbps by default, up to 384kbps on boosted
servers. Kenku currently ignores it in both directions: it may under-use a boosted channel, or
produce bits Discord discards.

Inband FEC is specifically designed for the dropout symptom being reported, and it is off.

### S4 — PCM crosses processes over an unauthenticated TCP socket

`src/main/managers/AudioCaptureManagerMain.ts:42`:

```ts
this._wss = new WebSocketServer({ port: 0 });
```

No `host` option, so this binds **all interfaces**, not loopback. There is no authentication and no
origin check. Anyone on the same network who finds the ephemeral port can connect and inject
arbitrary PCM into your Discord voice stream, or connect and stall it.

This should be fixed regardless of anything else in this document.

Beyond the security problem, loopback TCP is the wrong transport for a realtime stream: it adds
Nagle buffering, head-of-line blocking, and a kernel round trip per block.

### S5 — No backpressure anywhere on the PCM path

Two places, neither of which handles it:

- `AudioCaptureManagerPreload.ts` sends whenever `readyState === OPEN` and never consults
  `bufferedAmount`. Verified zero matches for `bufferedAmount` in `src/`. If the socket backs up, the
  send queue grows without bound and latency drifts upward for the rest of the session.
- `AudioCaptureManagerMain.ts:169-171`: `this._encoder?.write(data)` — the return value of
  `.write()` is discarded. No `drain` handling, no queue bound.

For a realtime stream, the correct response to a full buffer is to **drop old audio**, not to queue
it. Queuing converts a momentary stall into permanent added latency.

### S6 — Everything sums at unity gain with no limiter

`AudioCaptureManagerPreload.ts`: each source gets its own `GainNode` (`:131`, `:210`), and all of
them connect straight into the master gain (`:137`, `:216`). Verified zero matches for
`createDynamicsCompressor` in `src/`.

The worklet then hard-clamps: `Math.max(-1, Math.min(1, samples[i]))`.

So two loud sources — a playlist plus a soundboard hit, or two browser tabs — clip. Crossfade makes
this strictly worse, because it deliberately overlaps two tracks.

### S7 — The crossfade already exists, but is dead on the path that matters

`src/player/features/playlists/usePlaylistPlayback.ts:67-71`:

```ts
if (prevTrack) {
  prevTrack.fade(prevTrack.volume(), 0, 1000);
  prevTrack.once("fade", removePrevTrack);
}
howl.fade(0, store.getState().playlistPlayback.volume, 1000);
```

A genuine 1000ms two-instance crossfade. But track advance is driven **only** by Howler's `"end"`
event (`:243`). By the time the handler runs, the outgoing track has already finished and gone
silent — so `prevTrack.fade(…, 0, …)` fades silence. What you actually hear is a gap (file read +
decode of the next track), then a 1s fade-in from zero.

**The crossfade is therefore only audible on manual skip, never on automatic advance.**

Three structural problems block simply lengthening it:

- **`prevTrack` is a local closure variable** (`:36`), not a ref. It is invisible to `volume()`
  (`:266`), `mute()` (`:260`), `pauseResume()` (`:250`), `stop()` (`:113`) and `seek()` (`:107`).
  Pause or mute during a crossfade and the outgoing track keeps playing, uncontrolled. A longer
  crossfade widens that window.
- **`howl.volume()` cancels an in-flight fade**, and `PlaylistPlaybackSync.tsx:30` fires it on every
  volume-slider tick. Touching the slider mid-transition kills the fade.
- **Next-track index maths is copy-pasted three times** — `next()` (`:117`), `previous()` (`:159`)
  and `handleEnd()` (`:203`). Crossfade needs to resolve and preload the next track early, so all
  three have to agree.

### S8 — The correct pattern is already in this repository

`src/player/features/soundboards/Sound.ts` solves exactly this problem for soundboards:

```ts
this._timeout = setTimeout(() => {
  ...
  howl.fade(howl.volume(), 0, this.options.fadeOut);
  createHowlerInstance();          // starts the overlapping next instance
}, Math.floor(howl.duration() * 1000) - this.options.fadeOut);   // :63
```

Scheduled ahead of the end rather than reacting to it. Playlists should adopt this, not reinvent it.

Note also that `Sound` already carries `fadeIn`/`fadeOut` per item (`soundboardsSlice.ts`), while
`Track` (`playlistsSlice.ts`) carries no fade metadata at all.

### S9 — Frame-size units are conflated

`AudioCaptureManagerPreload.ts` defines a single `FRAME_SIZE = 960` and uses it for two different
things:

- As the encoder's `frameSize` — **correct**. Opus wants 960 samples *per channel* = 20ms.
- As the worklet ring buffer's length in Int16 *elements* — **half of what the comment claims**. 960
  interleaved stereo samples is 480 frames = **10ms**, not 20ms.

So `performance` mode buffers 500ms, not the "1 second" its comment states, and `lowLatency` buffers
10ms, not 20ms. The values may be defensible; the comments are wrong and the shared constant is a
trap for whoever edits this next.

### S10 — Smaller defects found in passing

- `AudioCaptureManagerPreload.ts:163` calls `ipcRenderer.emit` on WebSocket close. That is a *local*
  self-emit — it never reaches the main process. The error is silently swallowed, and there is no
  reconnect, so a closed socket means audio stops with no diagnostic.
- `stopBrowserViewStream` and `stopExternalAudioCapture` delete their bookkeeping but never
  `disconnect()` the `GainNode`. Nodes accumulate on the master bus for the life of the session.
- `src/preload.ts` sends `AUDIO_CAPTURE_STOP_ALL_BROWSER_VIEW_STREAMS`; nothing listens for it.
- The worklet drops all audio unless `input.length === 2`. A mono resolution of the graph silences
  the stream with no error.
- `createAudioResource` is called with no options at all (`PlaybackManager.ts:14`) — no `inputType`,
  so the stream type is inferred rather than declared.
- `PlaylistRemote.tsx` has a dead, empty `…PLAYBACK_SEEK` handler shadowed by the real one, whose
  cleanup does not remove it.
- `next()` and `previous()` in `usePlaylistPlayback.ts` have their explanatory comments swapped.

---

## 4. Plan

### Phase 1 — Stop the bleeding

Small, independent, each shippable alone. These target both reported symptoms directly.

| | Change | Fixes |
|---|---|---|
| 1.1 | Bind the PCM WebSocket to `127.0.0.1` and add a handshake token | S4 |
| 1.2 | Swap `opusscript` → `@discordjs/opus`, keeping the pure-JS path as a fallback if the native build is unavailable | S2 |
| 1.3 | Set encoder bitrate from the joined channel's `bitrate`; enable inband FEC at ~5% expected loss | S3 |
| 1.4 | Handle `VoiceConnectionStatus`: rejoin recoverable disconnects with capped backoff (~5 attempts, 1s→16s), treat kick/permission loss as final | S1 |
| 1.5 | Emit `DISCORD_CHANNEL_JOINED` only after `entersState(…, Ready)` | S1 |
| 1.6 | Handle `AudioPlayerStatus` so a player error replays the resource instead of going permanently Idle | S1 |
| 1.7 | Guard the unchecked `this.client` / connection dereferences; destroy connections in `destroy()` | S1 |
| 1.8 | Restore previously selected voice channels after a Discord client reconnect | S1 |
| 1.9 | Drop-oldest backpressure on both the send and the encoder-write side | S5 |
| 1.10 | Bump `@discordjs/voice` 0.19.0→0.19.2, `discord.js` 14.25.1→14.27.0 | — |

> `prism-media` 1.3.5 and `howler` 2.2.4 are already the latest published versions. No upgrade exists.

**1.2 is a prerequisite for 1.3** — `opusscript` does not reliably expose the CTL calls that
`setBitrate`/`setFEC` need.

### Phase 2 — Quality

| | Change | Fixes |
|---|---|---|
| 2.1 | Insert a limiter on the master bus before the worklet | S6 |
| 2.2 | Replace the localhost WebSocket with `MessagePortMain` | S4, S5 |
| 2.3 | Split the conflated `FRAME_SIZE` into two correctly named constants; fix the comments | S9 |
| 2.4 | Clear the S10 defect list | S10 |

2.1 should land **before** crossfade ships, since crossfade increases the clipping it prevents.

### Phase 3 — Crossfade

Per decisions 5–8: one global persisted setting (`0` disables), equal-power curve, "now playing"
flips at crossfade start, applies to automatic advance and manual skip but not `repeat: "track"`.

| | Change |
|---|---|
| 3.1 | Collapse the three copies of next-track index maths into one `getNextTrack()` helper |
| 3.2 | Replace the single `trackRef` with current/outgoing slots; apply volume, mute, pause and stop to **all** live instances |
| 3.3 | Schedule the transition ahead of the end, following the `Sound.ts:63` pattern, rather than reacting to `"end"` |
| 3.4 | Preload the next track before the switch point so decode latency does not reopen the gap |
| 3.5 | Hand-step an equal-power gain ramp instead of `howl.fade()`, applying `master × fadeFactor` so the volume slider no longer cancels fades |
| 3.6 | Add the setting to `playlistPlaybackSlice`, the persist whitelist, and the settings UI |
| 3.7 | Keep the `"end"` handler as a fallback for unknown/zero duration and end-of-queue |

Two implementation hazards worth stating up front:

- **`duration()` can be `Infinity` or `0`** in Howler's HTML5 mode until metadata loads. The timer
  must be guarded, which is why 3.7 keeps `"end"` as a fallback.
- **A wall-clock timer desynchronises across pause, resume and seek.** Either re-arm from
  `howl.seek()` on every transport change, or drive the check from the existing progress loop.
  Re-arming is the safer of the two.

### 4.5 Measurement — the gate on the rewrite

Decision 9 deferred the direct-decode rewrite pending evidence. The decision procedure:

1. Record a baseline: main-process CPU during a 30-minute playlist, and any dropouts.
2. Ship Phase 1. Re-measure the same scenario.
3. **If crackle survives Phase 1**, the tab-capture path is implicated and the direct main-process
   decode rewrite becomes justified. Record the numbers here and re-open decision 9.
4. **If crackle is gone**, the rewrite is not needed, and the result is recorded here so nobody
   relitigates it later.

The rewrite would bypass Chromium tab capture for local playlist audio, decoding directly in the
main process. It buys sample-accurate crossfade, no tab-mixer clipping and lower CPU — but it drops
Howler, needs its own decoder, seek and progress implementation, and **cannot help browser-view
audio**, which is the majority of Kenku's use.

### 4.6 Verification greps

Every "never called" claim above reduces to one of these, all currently returning zero:

```sh
grep -rn "entersState\|VoiceConnectionStatus\|AudioPlayerStatus\|rejoin" src/
grep -rn "bufferedAmount" src/
grep -rn "setBitrate\|setFEC" src/
grep -rn "inputType\|StreamType" src/
grep -rn "createDynamicsCompressor" src/
```

---

## 5. Explicitly out of scope

- **Upgrading Electron past the castlabs build.** Upstream is 44.4.2; this project pins
  `castlabs/electron-releases#37.6.0+wvcus`. The castlabs fork supplies Widevine, without which DRM
  sites do not play in browser views — that is what makes sharing Spotify work. A newer Chromium is
  not worth losing it. Bumping to the newest `+wvcus` tag is in scope; leaving castlabs is not.
- **Replacing `sodium-native` for voice encryption.** Initially flagged, then withdrawn:
  `@discordjs/voice` 0.19 prefers `aead_aes256_gcm_rtpsize`, which uses Node's native crypto, so the
  WASM `libsodium-wrappers` is likely not on the hot path. Low value; revisit only if profiling
  disagrees.
- **Crossfaded single-track looping** (`repeat: "track"`). A distinct feature needing two instances
  of the same file; the soundboard path already does this for users who need it.
- **Per-track or per-playlist fade settings.** Deferred to a global setting for the first pass.
