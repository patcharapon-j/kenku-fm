import { useCallback, useEffect, useRef } from "react";
import { useDispatch, useSelector, useStore } from "react-redux";

import { RootState } from "../../app/store";
import { normalizedSource } from "../../common/mediaURL";
import { PreviewEngineState } from "../../../types/preview";
import { Playlist, Track } from "../playlists/playlistsSlice";
import { playPause, startQueue } from "../playlists/playlistPlaybackSlice";
import { Sound, Soundboard } from "../soundboards/soundboardsSlice";
import {
  clearPreview,
  setPreviewDuckLiveMonitor,
  setPreviewMuted,
  setPreviewVolume,
  startPreview,
  syncPreviewEngine,
  updatePreviewItemMeta,
} from "./previewSlice";

type UsePreviewPlaybackOptions = {
  onError: (message: string) => void;
  onLivePlaylistPlay: (track: Track, startAt?: number) => void;
  onLivePlaylistSeek: (to: number) => void;
  onLiveSoundboardPlay: (sound: Sound) => void;
};

/**
 * Controls GM-only preview playback from the Player view.
 *
 * Audio itself never plays in this view (which is tab-captured into Discord and
 * tapped by Stream Kit). Instead, commands travel over IPC to the hidden Audio
 * Capture window's `PreviewAudioEngine`, and playback progress flows back here
 * into the isolated `preview` Redux slice.
 */
export function usePreviewPlayback({
  onError,
  onLivePlaylistPlay,
  onLivePlaylistSeek,
  onLiveSoundboardPlay,
}: UsePreviewPlaybackOptions) {
  const dispatch = useDispatch();
  const store = useStore<RootState>();
  const requestIdRef = useRef(0);

  const previewItem = useSelector((state: RootState) => state.preview.item);
  const playlists = useSelector((state: RootState) => state.playlists);
  const soundboards = useSelector((state: RootState) => state.soundboards);

  const close = useCallback(() => {
    // Advance the request id so any state update already in flight from the
    // capture window is dropped rather than reviving a closed preview deck.
    requestIdRef.current += 1;
    window.player.previewStop();
    dispatch(clearPreview());
  }, [dispatch]);

  // Listen for engine state updates from the Audio Capture window
  useEffect(() => {
    window.player.on("PLAYER_PREVIEW_STATE", (args) => {
      const state = args[0] as PreviewEngineState | undefined;
      if (!state || state.requestId !== requestIdRef.current) {
        return;
      }
      dispatch(syncPreviewEngine(state));
      if (state.error) {
        const title = store.getState().preview.item?.title;
        onError(
          title ? `Unable to preview "${title}"` : state.error,
        );
        requestIdRef.current += 1;
        window.player.previewStop();
        dispatch(clearPreview());
      }
    });

    return () => {
      window.player.removeAllListeners("PLAYER_PREVIEW_STATE");
      window.player.previewStop();
    };
  }, [dispatch, onError, store]);

  // Stop preview if the underlying item/container is deleted, and keep titles synced
  useEffect(() => {
    if (!previewItem) {
      return;
    }
    if (previewItem.kind === "track") {
      const track = playlists.tracks[previewItem.id];
      const playlist = playlists.playlists.byId[previewItem.parentId];
      if (!track || !playlist) {
        close();
        return;
      }
      if (
        track.title !== previewItem.title ||
        playlist.title !== previewItem.parentTitle
      ) {
        dispatch(
          updatePreviewItemMeta({
            title: track.title,
            parentTitle: playlist.title,
          }),
        );
      }
    } else {
      const sound = soundboards.sounds[previewItem.id];
      const soundboard = soundboards.soundboards.byId[previewItem.parentId];
      if (!sound || !soundboard) {
        close();
        return;
      }
      if (
        sound.title !== previewItem.title ||
        soundboard.title !== previewItem.parentTitle
      ) {
        dispatch(
          updatePreviewItemMeta({
            title: sound.title,
            parentTitle: soundboard.title,
          }),
        );
      }
    }
  }, [previewItem, playlists, soundboards, close, dispatch]);

  // Escape is a safe panic-off for preview when no dialog, menu, or input is active
  useEffect(() => {
    if (!previewItem) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.tagName === "SELECT" ||
          active.isContentEditable)
      ) {
        return;
      }
      if (
        document.querySelector(
          '[role="dialog"], [role="menu"], [role="listbox"]',
        )
      ) {
        return;
      }
      event.preventDefault();
      close();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [previewItem, close]);

  const previewTrack = useCallback(
    (track: Track, playlist: Playlist) => {
      const current = store.getState().preview;
      if (current.item?.kind === "track" && current.item.id === track.id) {
        if (current.playing || current.loading) {
          close();
        } else {
          window.player.previewPlay();
        }
        return;
      }
      const requestId = ++requestIdRef.current;
      const url = normalizedSource(track);
      dispatch(
        startPreview({
          requestId,
          item: {
            id: track.id,
            kind: "track",
            title: track.title,
            parentId: playlist.id,
            parentTitle: playlist.title,
            url,
          },
        }),
      );
      window.player.previewLoad({
        url,
        volume: current.volume,
        muted: current.muted,
        duckLiveMonitor: current.duckLiveMonitor,
        requestId,
      });
    },
    [close, dispatch, store],
  );

  const previewSound = useCallback(
    (sound: Sound, soundboard: Soundboard) => {
      const current = store.getState().preview;
      if (current.item?.kind === "sound" && current.item.id === sound.id) {
        if (current.playing || current.loading) {
          close();
        } else {
          window.player.previewPlay();
        }
        return;
      }
      const requestId = ++requestIdRef.current;
      const url = normalizedSource(sound);
      dispatch(
        startPreview({
          requestId,
          item: {
            id: sound.id,
            kind: "sound",
            title: sound.title,
            parentId: soundboard.id,
            parentTitle: soundboard.title,
            url,
          },
        }),
      );
      window.player.previewLoad({
        url,
        volume: current.volume,
        muted: current.muted,
        duckLiveMonitor: current.duckLiveMonitor,
        requestId,
      });
    },
    [close, dispatch, store],
  );

  const togglePlay = useCallback(() => {
    const current = store.getState().preview;
    if (!current.item) {
      return;
    }
    if (current.playing) {
      window.player.previewPause();
    } else {
      window.player.previewPlay();
    }
  }, [store]);

  const seek = useCallback((to: number) => {
    window.player.previewSeek(to);
  }, []);

  const setVolume = useCallback(
    (volume: number) => {
      const current = store.getState().preview;
      dispatch(setPreviewVolume(volume));
      window.player.previewSetVolume(volume);
      if (current.muted && volume > 0) {
        dispatch(setPreviewMuted(false));
        window.player.previewSetMuted(false);
      }
    },
    [dispatch, store],
  );

  const toggleMute = useCallback(() => {
    const next = !store.getState().preview.muted;
    dispatch(setPreviewMuted(next));
    window.player.previewSetMuted(next);
  }, [dispatch, store]);

  const toggleDuck = useCallback(() => {
    const next = !store.getState().preview.duckLiveMonitor;
    dispatch(setPreviewDuckLiveMonitor(next));
    window.player.previewSetDuck(next);
  }, [dispatch, store]);

  const promoteToLive = useCallback(() => {
    const state = store.getState();
    const { item, progress, duration, ended } = state.preview;
    if (!item) {
      return;
    }
    // Always stop preview before starting live so the GM never hears both stacked
    close();

    if (item.kind === "track") {
      const startAt =
        !ended &&
        progress >= 1 &&
        (duration <= 0 || progress < duration - 1)
          ? progress
          : 0;
      const livePlayback = state.playlistPlayback;
      if (livePlayback.track?.id === item.id && livePlayback.playback) {
        onLivePlaylistSeek(Math.floor(startAt));
        if (!livePlayback.playing) {
          dispatch(playPause(true));
        }
        return;
      }
      const track = state.playlists.tracks[item.id];
      const playlist = state.playlists.playlists.byId[item.parentId];
      if (!track || !playlist) {
        return;
      }
      dispatch(
        startQueue({
          tracks: [...playlist.tracks],
          trackId: track.id,
          playlistId: playlist.id,
        }),
      );
      onLivePlaylistPlay(track, startAt);
    } else {
      const sound = state.soundboards.sounds[item.id];
      if (sound) {
        onLiveSoundboardPlay(sound);
      }
    }
  }, [
    close,
    dispatch,
    onLivePlaylistPlay,
    onLivePlaylistSeek,
    onLiveSoundboardPlay,
    store,
  ]);

  return {
    previewTrack,
    previewSound,
    togglePlay,
    seek,
    setVolume,
    toggleMute,
    toggleDuck,
    promoteToLive,
    close,
  };
}
