import React, { useEffect, useMemo, useRef } from "react";
import { useSelector } from "react-redux";

import { RootState } from "../../app/store";
import { Library, NowPlaying, PlayerStatus } from "../../../types/streamKit";
import { StreamKitVoice } from "./StreamKitVoice";

/** How often what's playing is reported while it plays, in ms */
const NOW_PLAYING_INTERVAL = 5000;
/**
 * How far the reported position may drift from where the last report would
 * have it before it is reported straight away, which is what catches a seek
 */
const POSITION_TOLERANCE = 2500;

/**
 * Keeps the main process, and through it the Stream Kit, up to date with the
 * library, what's playing and the playback settings, and publishes music and
 * effects into the Voice Room when the main process hands over credentials.
 * Commands from the Stream Kit arrive over the same channels as the HTTP
 * remote's, so they are handled by `PlaylistRemote` and `SoundboardRemote`.
 */
export function StreamKitBridge() {
  const playlists = useSelector((state: RootState) => state.playlists);
  const soundboards = useSelector((state: RootState) => state.soundboards);
  const playback = useSelector((state: RootState) => state.playlistPlayback);

  // Whatever was last reported, for when the main process asks for it again
  const reportsRef = useRef<{ library?: Library; status?: PlayerStatus }>({});

  useEffect(() => {
    window.player.on("PLAYER_STREAM_KIT_RESEND", () => {
      const { library, status } = reportsRef.current;
      if (library) {
        window.player.streamKitLibrary(library);
      }
      if (status) {
        window.player.streamKitStatus(status);
      }
      sendNowPlaying();
    });

    return () => {
      window.player.removeAllListeners("PLAYER_STREAM_KIT_RESEND");
    };
  }, []);

  useEffect(() => {
    const voice = new StreamKitVoice(
      (state) => window.player.streamKitVoiceState(state),
      () => window.player.streamKitVoicePlease(),
    );
    window.player.on("PLAYER_STREAM_KIT_VOICE", (args) => {
      const [url, token] = args;
      voice.setCredentials(url ?? null, token ?? null);
    });
    window.player.streamKitReady();

    return () => {
      window.player.removeAllListeners("PLAYER_STREAM_KIT_VOICE");
      voice.stop();
    };
  }, []);

  const library = useMemo<Library>(
    () => ({
      playlists: playlists.playlists.allIds
        .map((id) => playlists.playlists.byId[id])
        .filter(Boolean)
        .map((playlist) => ({
          id: playlist.id,
          title: playlist.title,
          tracks: playlist.tracks
            .map((id) => playlists.tracks[id])
            .filter(Boolean)
            .map((track) => ({ id: track.id, title: track.title })),
        })),
      soundboards: soundboards.soundboards.allIds
        .map((id) => soundboards.soundboards.byId[id])
        .filter(Boolean)
        .map((soundboard) => ({
          id: soundboard.id,
          title: soundboard.title,
          sounds: soundboard.sounds
            .map((id) => soundboards.sounds[id])
            .filter(Boolean)
            .map((sound) => ({ id: sound.id, title: sound.title })),
        })),
    }),
    [playlists, soundboards],
  );

  // Renaming a track's tags or reordering an unrelated field changes the
  // store without changing what the Stream Kit is shown, so compare the text
  const libraryJSON = JSON.stringify(library);
  useEffect(() => {
    const library = JSON.parse(libraryJSON);
    reportsRef.current.library = library;
    window.player.streamKitLibrary(library);
  }, [libraryJSON]);

  const status = useMemo<PlayerStatus>(
    () => ({
      music: {
        volume: playback.volume,
        muted: playback.muted,
        shuffle: playback.shuffle,
        repeat: playback.repeat,
      },
      // Each sound has its own volume and there is no master for effects, so
      // the effects bus always runs at unity
      sfx: { volume: 1 },
    }),
    [playback.volume, playback.muted, playback.shuffle, playback.repeat],
  );
  useEffect(() => {
    reportsRef.current.status = status;
    window.player.streamKitStatus(status);
  }, [status]);

  const playlistId = playback.queue?.playlistId ?? null;
  const nowPlaying: NowPlaying = {
    playing: playback.playing,
    track: playback.track
      ? {
          id: playback.track.id,
          title: playback.track.title,
          playlistId,
          playlistTitle:
            (playlistId && playlists.playlists.byId[playlistId]?.title) || null,
          durationMs: playback.playback
            ? Math.round(playback.playback.duration * 1000)
            : null,
          positionMs: playback.playback
            ? Math.round(playback.playback.progress * 1000)
            : null,
        }
      : null,
  };
  const nowPlayingRef = useRef(nowPlaying);
  nowPlayingRef.current = nowPlaying;
  const lastSentRef = useRef<{ key: string; position: number; at: number }>();

  function sendNowPlaying() {
    const current = nowPlayingRef.current;
    window.player.streamKitNowPlaying(current);
    lastSentRef.current = {
      key: nowPlayingKey(current),
      position: current.track?.positionMs ?? 0,
      at: performance.now(),
    };
  }

  // Reported whenever anything but the position changes, or the position
  // jumps away from where it is expected to be
  useEffect(() => {
    const last = lastSentRef.current;
    if (!last || last.key !== nowPlayingKey(nowPlaying)) {
      sendNowPlaying();
      return;
    }
    const position = nowPlaying.track?.positionMs;
    if (position === null || position === undefined) {
      return;
    }
    const expected = nowPlaying.playing
      ? last.position + (performance.now() - last.at)
      : last.position;
    if (Math.abs(position - expected) > POSITION_TOLERANCE) {
      sendNowPlaying();
    }
  });

  // And every few seconds while playing, so the position doesn't drift
  useEffect(() => {
    if (!playback.playing) {
      return;
    }
    const interval = setInterval(sendNowPlaying, NOW_PLAYING_INTERVAL);
    return () => clearInterval(interval);
  }, [playback.playing]);

  return <></>;
}

/** Everything about what's playing except where in the track it is */
function nowPlayingKey(nowPlaying: NowPlaying): string {
  return JSON.stringify({
    ...nowPlaying,
    track: nowPlaying.track ? { ...nowPlaying.track, positionMs: null } : null,
  });
}
