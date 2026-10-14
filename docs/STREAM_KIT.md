# Stream Kit output

Kenku FM can send its audio to the [GLUniverse Stream Kit](https://stream.gluniverse.com) as well as to Discord. Either output can be on by itself, or both can be on together.

The Stream Kit output publishes the Kenku Player's **Music** (playlists) and **SFX** (soundboards) into the Campaign's LiveKit Voice Room as two separate stereo tracks, named `music` and `sfx`. The table hears both tracks in the Voice Room, and OBS gets Music and SFX as separate sources. Music is ducked under voices and SFX never is. The Stream Kit console also sees the library and what's playing, and can control playback. This is how stream events trigger sounds.

Only the built-in player is sent. Browser tabs such as YouTube, and external inputs, still go to Discord and the local monitor as before, but they aren't sent to the Stream Kit.

## Pairing

1. Open the Stream Kit console for the Campaign and copy a pairing code. The code looks like `ABCD-EFGH`. Each code works once.
2. In Kenku FM, go to the **Stream Kit** section under Outputs in the left drawer and click the entry to open its settings.
3. Check the Stream Kit address. It defaults to `https://stream.gluniverse.com`. Then enter the code and press **Pair**. The code isn't case-sensitive.
4. When pairing works, the entry shows the Campaign's name, and the Voice Room line changes to *Publishing Music + SFX* once Kenku has joined the room.

Kenku saves the address and the token from the pairing (`stream-kit.json` in the app's data folder) and reconnects with them on every start. If the Stream Kit refuses the token, for example because Kenku was unpaired on the console, Kenku forgets it, shows the reason and stops retrying. Pair again with a new code.

**Unpair** in Kenku disconnects and forgets the token on this computer. To revoke the token itself, unpair on the Stream Kit side as well.

## Outputs

- The switch on the Stream Kit entry turns publishing into the Voice Room on or off. While it is off, Kenku stays connected to the Stream Kit and keeps reporting the library and playback, so the console can still control it.
- Discord works exactly as before: it follows the voice channels you pick under Outputs. Picking or leaving a Discord channel doesn't affect the Stream Kit, and the Stream Kit switch doesn't affect Discord.
- The Stream Kit is told which outputs are live: `outputs.discord` is true while Kenku is in any Discord voice channel.

If the Stream Kit has no Voice Room set up for the Campaign, the entry shows *Voice Room not set up on the Stream Kit*. The connection stays up and commands still work.

## How the audio is split

Discord gets its audio from a capture of the whole player view, which is already one mix by the time it is captured. The Stream Kit tracks are therefore taken inside the player, before the mix:

- Every playlist track is routed through a `music` bus. Every cross-fading soundboard sound is routed through an `sfx` bus. Each bus is a unity gain that feeds the speakers exactly as before, so the local sound and the Discord capture don't change.
- While the Stream Kit output is publishing, each bus also feeds a `MediaStreamAudioDestinationNode`. The player publishes those two streams with `livekit-client` (stereo, 256 kbps max, DTX off, RED on, source `Unknown`).
- Soundboard sounds without a cross fade are played by Howler, which has its own AudioContext. Its master output is carried onto the `sfx` stream through a MediaStream.
- When nothing is publishing, the stream copies are disconnected.

Volume, mute, cross fades and transport fades are applied before the buses, so the Voice Room hears what the player plays. Only local files can be routed through Web Audio. A playlist track or sound that is a remote URL (not a local file) plays locally and on Discord, but it is silent on the Stream Kit tracks.

## Remote commands

Commands from the console reach the player on the same internal channels as the HTTP remote used by the Stream Deck plugin, so they behave the same way:

| Stream Kit command | Player behaviour |
| --- | --- |
| `play-playlist` | Same as `PUT /v1/playlist/play` with the playlist id: starts the playlist from the top, or from a random track when shuffle is on |
| `play-track` | Plays the track as part of the given playlist |
| `playback` `play` / `pause` / `next` / `previous` | Same as the matching `/v1/playlist/playback` routes |
| `music-volume` | Same as `PUT /v1/playlist/playback/volume`, clamped to 0–1 |
| `play-sound` | Same as `PUT /v1/soundboard/play` with the sound id |
| `stop-sounds` | Stops every playing sound, with its fade out |

Kenku sends the library when it connects and whenever it changes. It sends what's playing whenever that changes, every 5 seconds while music plays, and after a seek. It sends the status (music volume, mute, shuffle, repeat, outputs) whenever it changes. Soundboards have no master volume, so `sfx.volume` is always 1.

## Protocol

Kenku opens a WebSocket to `<Stream Kit address>/kenku` (`https` becomes `wss`). The first message is a greeting: `pair` with the code, or `hello` with the saved token, plus the app version. Replies are `paired` (with the token and Campaign), `welcome`, or `refused` followed by close code 4401.

After a successful greeting, the Stream Kit sends `voice` with the LiveKit URL and token. It sends `voice` again about every five hours and whenever Kenku asks with `voice-please`. A new token for the room Kenku is already in is kept for the next time it has to join from scratch, and the live connection isn't interrupted. If the room address changes, Kenku joins the new room and leaves the old one only after the new one is publishing.

Kenku ignores unknown message types. A dropped socket is reopened after 1 s, with the delay doubling up to 30 s. A refusal is never retried. A pairing attempt that gets no answer isn't retried either, because the Operator can press Pair again.

The client is in `src/main/streamKit`. The main-process glue is in `src/main/managers/StreamKitManager.ts`. The Voice Room publisher and the reporting are in `src/player/features/streamKit`, and the buses are in `src/player/common/outputBuses.ts`.

## Testing against a mock Stream Kit

`scripts/stream-kit-mock-server.cjs` implements the Stream Kit side of the protocol.

```
node scripts/stream-kit-mock-server.cjs --port 8787 --code ABCD-EFGH
```

Set Kenku's Stream Kit address to `http://localhost:8787` and pair with `ABCD-EFGH`. The server prints everything Kenku sends. Type commands to drive Kenku: `playlist <id>`, `track <playlistId> <trackId>`, `play`, `pause`, `next`, `previous`, `volume 0.5`, `sound <soundboardId> <soundId>`, `stop-sounds`, `unpair`, `drop`, and `library`, which prints the ids to use. To test the Voice Room, start the server with `--voice-url wss://<project>.livekit.cloud --voice-token <jwt>`, or type `voice <url> <token>`. The token must allow publishing.

Automated tests run the client and the main-process manager, with Electron stubbed, against the same mock:

```
node --test tests/stream-kit-client.test.cjs tests/stream-kit-manager.test.cjs
```
