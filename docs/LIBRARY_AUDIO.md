# Library search, tags, and audio leveling

Search names and tags inside a playlist or soundboard. The home screen's All audio section searches both libraries. Tags can be added when importing or editing an item. Press Enter after each tag. Tags are trimmed, case insensitive, and deduplicated. Sort by name or tags, or return to Saved order to drag items. Search and sorting change the view, not the playback queue or saved order.

New local files are processed in the background, including folder drops and replacement sources. Processing creates a 24-bit lossless FLAC copy in the application's `normalized-audio` data directory. Original files remain unchanged. Playback uses the copy on its next start after processing completes; audio already playing is not interrupted. Remote audio URLs are not processed.

The first run with unprocessed existing files offers bulk processing. It is also available from All audio, with remaining-item progress, cancellation of remaining bulk jobs, and error reporting. Failed files remain eligible for retry. Deleted items and replaced sources are checked before and after processing to prevent stale jobs from updating the library. Only one file is processed at a time.

FFmpeg measures integrated loudness and true peak across the file. The output pass applies only a constant volume multiplier, targeting -16 LUFS with a -1 dBTP ceiling and at most 24 dB of boost. A track whose peaks prevent reaching the target stays quieter to preserve its dynamics. Silence stays silent. The measurement pads short clips with silence; the output retains the original duration. See the [FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html#loudnorm).

Processed copies are reused by source path, size, modification time, and processing version when processing is requested again. Copies consume additional disk space. Do not remove the normalized-audio directory while the library references its files. Modifying a source file outside Kenku does not automatically invalidate an already saved playback copy.

The live leveler now receives browser tabs and external inputs only. Playlist and soundboard audio bypasses it, then joins the mix before the existing peak limiter. The peak limiter still protects the combined output when sources overlap.

Play / pause fade is a separate saved playback setting, defaulting to 1500 ms. Track-transition crossfade settings are unchanged. A value of 0 disables the transport fade.

## Verification

Run `node --test tests/library-audio.test.cjs` after dependency installation. Tests run the bundled FFmpeg against generated fixtures to check matching adjustments, constant sample scaling, unchanged duration, silence, cached reuse, error recovery, search behavior, and the browser/player mix split. Run `tsc --noEmit` for type checking.

The new FFmpeg binary is included through the existing Forge externals plugin. Install dependencies for the target platform before packaging, as required by ffmpeg-static. Cross-platform installers still need their normal platform release checks.

## Local verification on September 22, 2026

Type checking and all three automated tests passed. An isolated Electron profile verified tagged imports, automatic normalization and normalized-copy playback, local and global search, soundboard tag filtering and playback, the legacy bulk-processing prompt, and persistence. Pause reached the media element after 1506 ms with the default 1500 ms setting. Changing the transport setting persisted independently of track crossfade. No browser errors were reported during these checks. This was not a listening test or a packaged Windows/Linux release test.

The existing lint command cannot initialize: ESLint 7 is paired with TypeScript ESLint 7, which requires ESLint 8.56 or newer. This dependency mismatch was left outside the feature changes.
