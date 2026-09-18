import { useCallback, useEffect, useRef } from "react";
import { Howl } from "howler";

import { useDispatch, useSelector, useStore } from "react-redux";
import { RootState } from "../../app/store";
import {
  playPause,
  playTrack,
  updatePlayback,
  updateQueue,
  stopTrack,
} from "./playlistPlaybackSlice";
import { Track } from "./playlistsSlice";

/** Length of the fade used when cross fading is disabled */
const DEFAULT_FADE = 1000;
/** Time between each step of the hand stepped equal power cross fade */
const FADE_STEP = 25;
/** How long before a cross fade starts that the next track is loaded */
const PRELOAD_AHEAD = 5000;
/** Only move to the previous track when within this many seconds of the start */
const PREVIOUS_THRESHOLD = 5;
/** Length of the ramp used when an audible track has to be removed */
const DECLICK_FADE = 50;
/** Length of the fade to and from silence used by play, pause and stop */
const TRANSPORT_FADE = 400;

/** A track to move to in the queue or the reason there isn't one */
type QueueMove =
  /** Move to this track */
  | { type: "track"; track: Track; index: number }
  /** There is no track to move to so the playback should stop */
  | { type: "stop" }
  /** The queue entry couldn't be found so the playback should be left as is */
  | { type: "none" };

export function usePlaylistPlayback(onError: (message: string) => void) {
  /** Track that is currently playing */
  const trackRef = useRef<Howl | null>(null);
  /** Track that is fading out during a cross fade */
  const outgoingRef = useRef<Howl | null>(null);
  /** Next track loaded ahead of a cross fade */
  const preloadRef = useRef<{ id: string; howl: Howl } | null>(null);
  /**
   * Cross fade gain of each live instance.
   * The master volume is multiplied by these before it reaches a howl so that
   * moving the volume slider doesn't cancel an in flight cross fade.
   */
  const trackFadeRef = useRef(1);
  const outgoingFadeRef = useRef(0);
  /** Cross fade gain of the outgoing track when the cross fade started */
  const outgoingStartFadeRef = useRef(1);
  /** Whether the outgoing track was paused by the transport rather than ended */
  const outgoingPausedRef = useRef(false);
  /**
   * Gain applied on top of the cross fade gain by the transport.
   * Pause, resume and stop ramp this between 1 and 0 rather than starting and
   * stopping a howl outright, which cuts the waveform part way through a cycle
   * and is heard as a click
   */
  const transportFadeRef = useRef(1);
  /** Gain the transport fade in flight is heading towards */
  const transportTargetRef = useRef(1);
  /** Interval that steps the transport fade */
  const transportRef = useRef<NodeJS.Timeout | null>(null);
  /** Interval that steps the equal power cross fade */
  const fadeRef = useRef<NodeJS.Timeout | null>(null);
  /** Timeout that starts the cross fade ahead of the end of the track */
  const crossFadeRef = useRef<NodeJS.Timeout | null>(null);
  const animationRef = useRef<number | null>(null);
  /** Howl event handlers held in refs to avoid a circular dependency with play */
  const handleEndRef = useRef<() => void>(() => {});
  const armCrossFadeRef = useRef<() => void>(() => {});

  const store = useStore<RootState>();
  const crossfade = useSelector(
    (state: RootState) => state.playlistPlayback.crossfade,
  );
  const dispatch = useDispatch();

  const clearCrossFade = useCallback(() => {
    if (crossFadeRef.current !== null) {
      clearTimeout(crossFadeRef.current);
      crossFadeRef.current = null;
    }
  }, []);

  const stopFade = useCallback(() => {
    if (fadeRef.current !== null) {
      clearInterval(fadeRef.current);
      fadeRef.current = null;
    }
  }, []);

  /**
   * Push the current gain of every live instance to its howl.
   * A howl's volume is the master volume scaled by its cross fade gain and by
   * the transport gain, so a volume slider tick, a cross fade and a transport
   * fade can all be in flight at once without cancelling each other.
   */
  const applyVolume = useCallback(
    (override?: number) => {
      const volume = override ?? store.getState().playlistPlayback.volume;
      const transport = transportFadeRef.current;
      trackRef.current?.volume(volume * trackFadeRef.current * transport);
      outgoingRef.current?.volume(volume * outgoingFadeRef.current * transport);
    },
    [store],
  );

  const stopTransportFade = useCallback(() => {
    if (transportRef.current !== null) {
      clearInterval(transportRef.current);
      transportRef.current = null;
    }
  }, []);

  /** Drop any transport fade in flight and return to full gain */
  const resetTransport = useCallback(() => {
    stopTransportFade();
    transportTargetRef.current = 1;
    transportFadeRef.current = 1;
  }, [stopTransportFade]);

  /**
   * Ramp the transport gain to `target` and run `onComplete` once it arrives.
   * The duration is scaled by the distance left to cover so that a fade which
   * is reversed part way through doesn't crawl back over the remainder.
   */
  const rampTransport = useCallback(
    (target: number, onComplete?: () => void) => {
      if (
        transportRef.current !== null &&
        transportTargetRef.current === target
      ) {
        // Already heading there, let the fade in flight finish the job so that
        // a repeated request can't restart the ramp from part way down
        return;
      }
      stopTransportFade();
      transportTargetRef.current = target;
      const from = transportFadeRef.current;
      const distance = Math.abs(target - from);
      if (distance === 0) {
        onComplete?.();
        return;
      }
      const duration = TRANSPORT_FADE * distance;
      let elapsed = 0;
      let prevTime = performance.now();
      function step() {
        const time = performance.now();
        elapsed += time - prevTime;
        prevTime = time;
        const progress = Math.min(elapsed / duration, 1);
        // Raised cosine so the ramp leaves and arrives at rest. A linear ramp
        // hinges at both ends, which is audible as a chirp on a sustained note
        const eased = (1 - Math.cos(progress * Math.PI)) / 2;
        transportFadeRef.current = from + (target - from) * eased;
        applyVolume();
        if (progress >= 1) {
          stopTransportFade();
          transportFadeRef.current = target;
          applyVolume();
          onComplete?.();
        }
      }
      transportRef.current = setInterval(step, FADE_STEP);
      step();
    },
    [applyVolume, stopTransportFade],
  );

  const removeOutgoing = useCallback(() => {
    const outgoing = outgoingRef.current;
    const gain = outgoingFadeRef.current;
    outgoingRef.current = null;
    outgoingFadeRef.current = 0;
    outgoingPausedRef.current = false;
    if (!outgoing) {
      return;
    }
    // Unloading a track that is still audible cuts the waveform part way
    // through a cycle, which is heard as a click, so ramp it down first.
    // A cross fade that ran to completion is already silent here.
    if (gain > 0 && outgoing.playing()) {
      outgoing.once("fade", () => outgoing.unload());
      outgoing.fade(outgoing.volume(), 0, DECLICK_FADE);
    } else {
      outgoing.unload();
    }
  }, []);

  const removePreload = useCallback(() => {
    const preload = preloadRef.current;
    preloadRef.current = null;
    preload?.howl.unload();
  }, []);

  /**
   * Find the track at an offset from the current index in the queue.
   * Used by next, previous, the cross fade and the track end fallback so that
   * they can't disagree about which track comes next.
   */
  const getQueueMove = useCallback(
    (offset: number): QueueMove => {
      const { queue, repeat, shuffle } = store.getState().playlistPlayback;
      if (!queue) {
        return { type: "stop" };
      }
      let index = queue.current + offset;
      if (index >= queue.tracks.length) {
        // Repeat off just stop the playback
        if (repeat === "off") {
          return { type: "stop" };
        }
        index = 0;
      } else if (index < 0) {
        // Start of playlist with repeat off just stop the track
        if (repeat === "off") {
          return { type: "stop" };
        }
        index = queue.tracks.length - 1;
      }
      let id: string;
      if (shuffle) {
        id = queue.tracks[queue.shuffled[index]];
      } else {
        id = queue.tracks[index];
      }
      if (!id) {
        return { type: "none" };
      }
      const track = store.getState().playlists.tracks[id];
      if (!track) {
        return { type: "none" };
      }
      return { type: "track", track, index };
    },
    [store],
  );

  /**
   * Hand step an equal power cross fade between the outgoing and current track.
   * howl.fade() is linear only, which dips by around -3dB at the midpoint, and
   * it is cancelled by howl.volume() which the volume slider calls on every
   * tick, so the gain is stepped here and applied as master volume * fade gain.
   */
  const startFade = useCallback(
    (duration: number) => {
      stopFade();
      let elapsed = 0;
      let prevTime = performance.now();
      function step() {
        const time = performance.now();
        const delta = time - prevTime;
        prevTime = time;
        // Don't advance the fade while the playback is paused
        if (trackRef.current?.playing() || outgoingRef.current?.playing()) {
          elapsed += delta;
        }
        const progress = duration <= 0 ? 1 : Math.min(elapsed / duration, 1);
        trackFadeRef.current = Math.sin((progress * Math.PI) / 2);
        outgoingFadeRef.current =
          outgoingStartFadeRef.current * Math.cos((progress * Math.PI) / 2);
        applyVolume();
        if (progress >= 1) {
          stopFade();
          trackFadeRef.current = 1;
          removeOutgoing();
        }
      }
      fadeRef.current = setInterval(step, FADE_STEP);
      step();
    },
    [applyVolume, stopFade, removeOutgoing],
  );

  /** Load the next track in the queue so its decode latency doesn't reopen the gap */
  const preloadNextTrack = useCallback(() => {
    const move = getQueueMove(1);
    if (move.type !== "track") {
      return;
    }
    if (preloadRef.current?.id === move.track.id) {
      return;
    }
    removePreload();
    try {
      const howl = new Howl({
        src: move.track.url,
        html5: true,
        mute: store.getState().playlistPlayback.muted,
        volume: 0,
      });
      // A howl that failed to load stays in the `loading` state and can never
      // fire `load` or `loaderror` again, so it has to be dropped here rather
      // than handed to `play` where it would stall the playback for good
      howl.once("loaderror", () => {
        if (preloadRef.current?.howl === howl) {
          preloadRef.current = null;
        }
        howl.unload();
      });
      preloadRef.current = { id: move.track.id, howl };
    } catch {
      // A track that fails to preload is loaded again when it starts playing
      preloadRef.current = null;
    }
  }, [getQueueMove, removePreload, store]);

  /** Take the preloaded howl for this track if there is a usable one */
  const takePreloadedTrack = useCallback((track: Track): Howl | null => {
    const preload = preloadRef.current;
    preloadRef.current = null;
    if (!preload) {
      return null;
    }
    // Only a howl that finished loading is safe to reuse: one that is still
    // loading, or that failed to load, would leave `play` waiting on a `load`
    // event that may never arrive
    if (preload.id !== track.id || preload.howl.state() !== "loaded") {
      preload.howl.unload();
      return null;
    }
    return preload.howl;
  }, []);

  const play = useCallback(
    (track: Track) => {
      clearCrossFade();
      stopFade();
      // A track that starts fades in with the cross fade, so the transport
      // opens straight away rather than ramping a second time on top of it.
      // This also releases a transport fade left closed by a pause, so picking
      // a track while paused starts it instead of leaving it silent
      resetTransport();
      // Any track still fading out from an earlier transition has had its turn
      removeOutgoing();

      const outgoing = trackRef.current;
      trackRef.current = null;
      if (outgoing) {
        // Remove all handlers so the outgoing track can't advance the queue
        // or re-arm the cross fade once it reaches its own end
        outgoing.off();
        outgoingRef.current = outgoing;
        outgoingStartFadeRef.current = trackFadeRef.current;
        outgoingFadeRef.current = trackFadeRef.current;
      }
      trackFadeRef.current = 0;

      function error() {
        trackRef.current = null;
        stopFade();
        resetTransport();
        dispatch(stopTrack());
        removeOutgoing();
        onError(`Unable to play track: ${track.title}`);
      }

      try {
        const howl =
          takePreloadedTrack(track) ||
          new Howl({
            src: track.url,
            html5: true,
            mute: store.getState().playlistPlayback.muted,
            volume: 0,
          });

        trackRef.current = howl;
        const handleLoad = () => {
          dispatch(
            playTrack({
              track,
              duration: Math.floor(howl.duration()),
            }),
          );
          // Fade out previous track and fade in new track
          const crossfade = store.getState().playlistPlayback.crossfade;
          startFade(crossfade > 0 ? crossfade : DEFAULT_FADE);
          // Update playback
          // Create playback animation
          if (animationRef.current !== null) {
            cancelAnimationFrame(animationRef.current);
          }
          let prevTime = performance.now();
          function animatePlayback(time: number) {
            animationRef.current = requestAnimationFrame(animatePlayback);
            // Limit update to 1 time per second
            const delta = time - prevTime;
            if (howl.playing() && delta > 1000) {
              dispatch(updatePlayback(Math.floor(howl.seek())));
              prevTime = time;
            }
          }
          animationRef.current = requestAnimationFrame(animatePlayback);
        };

        howl.on("end", () => handleEndRef.current());
        // Arming from the play event keeps the timer in step with pause and resume
        howl.on("play", () => armCrossFadeRef.current());
        howl.on("pause", () => clearCrossFade());
        // Howler pauses the sound before it seeks and restarts it internally,
        // which emits no `play` event, so the timer is re-armed from `seek`
        howl.on("seek", () => armCrossFadeRef.current());

        howl.on("loaderror", error);

        howl.on("playerror", error);

        const sound = (howl as any)._sounds[0];
        if (!sound) {
          error();
        } else if (howl.state() === "loaded") {
          // A preloaded track has already fired its load event
          handleLoad();
        } else {
          howl.once("load", handleLoad);
        }
      } catch {
        error();
      }
    },
    [
      onError,
      store,
      clearCrossFade,
      stopFade,
      startFade,
      removeOutgoing,
      resetTransport,
      takePreloadedTrack,
    ],
  );

  const seek = useCallback((to: number) => {
    dispatch(updatePlayback(to));
    // A wall clock timer desynchronises on seek so it's re-armed from the new
    // position by the `seek` handler registered in `play`
    trackRef.current?.seek(to);
  }, []);

  const stop = useCallback(() => {
    dispatch(playPause(false));
    dispatch(updatePlayback(0));
    clearCrossFade();
    stopFade();
    removeOutgoing();
    // Reset the fade gain so the track isn't left quiet if it's played again
    trackFadeRef.current = 1;
    const howl = trackRef.current;
    if (!howl?.playing()) {
      // Nothing audible to ramp down
      resetTransport();
      applyVolume();
      howl?.stop();
      return;
    }
    // `playPause(false)` above reaches `pauseResume` through the store on the
    // next render. That ramp is towards the same gain as this one so it joins
    // this fade rather than starting its own, and the stop below wins
    rampTransport(0, () => {
      howl.stop();
      resetTransport();
      applyVolume();
    });
  }, [
    clearCrossFade,
    stopFade,
    removeOutgoing,
    applyVolume,
    rampTransport,
    resetTransport,
  ]);

  /** Start the cross fade into the next track ahead of the end of this one */
  const startCrossFade = useCallback(() => {
    const { repeat, track: playbackTrack } = store.getState().playlistPlayback;
    if (repeat === "track") {
      // Cross fading a single looping track is out of scope
      return;
    }
    const move = getQueueMove(1);
    if (move.type !== "track" || move.track.id === playbackTrack?.id) {
      // Nothing to cross fade into, the end event handles the end of the queue
      return;
    }
    // The displayed track flips at the start of the cross fade
    play(move.track);
    dispatch(updateQueue(move.index));
  }, [store, getQueueMove, play]);

  /**
   * Schedule the cross fade ahead of the end of the current track.
   * The end event is kept as a fallback for everything this can't arm for.
   */
  const armCrossFade = useCallback(() => {
    clearCrossFade();
    const howl = trackRef.current;
    if (!howl) {
      return;
    }
    const crossfade = store.getState().playlistPlayback.crossfade;
    if (crossfade <= 0) {
      // Cross fading is disabled, the end event moves to the next track
      return;
    }
    if (!howl.playing()) {
      // Re-armed from the play event once the playback resumes
      return;
    }
    const duration = howl.duration();
    // duration can be 0 or Infinity in html5 mode until the metadata has loaded
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }
    const progress = howl.seek();
    const remaining =
      duration * 1000 - (Number.isFinite(progress) ? progress : 0) * 1000;
    if (remaining <= crossfade) {
      // Not enough of the track left to cross fade, the end event takes over
      return;
    }
    const preloadDelay = Math.max(remaining - crossfade - PRELOAD_AHEAD, 0);
    crossFadeRef.current = setTimeout(() => {
      preloadNextTrack();
      crossFadeRef.current = setTimeout(
        startCrossFade,
        remaining - crossfade - preloadDelay,
      );
    }, preloadDelay);
  }, [store, clearCrossFade, preloadNextTrack, startCrossFade]);

  const next = useCallback(() => {
    if (!trackRef.current) {
      return;
    }
    const {
      queue,
      repeat,
      track: playbackTrack,
    } = store.getState().playlistPlayback;
    if (!queue) {
      stop();
    } else if (repeat === "track") {
      seek(0);
    } else {
      const move = getQueueMove(1);
      if (move.type === "stop") {
        stop();
      } else if (move.type === "track") {
        if (move.track.id === playbackTrack?.id) {
          // Playing the same track just restart it
          seek(0);
        } else {
          // Play the next track
          play(move.track);
          dispatch(updateQueue(move.index));
        }
      }
    }
  }, [store, getQueueMove, seek, play, stop]);

  const previous = useCallback(() => {
    const howl = trackRef.current;
    if (!howl) {
      return;
    }
    const {
      queue,
      repeat,
      track: playbackTrack,
    } = store.getState().playlistPlayback;
    if (!queue) {
      stop();
    } else if (repeat === "track") {
      seek(0);
    } else {
      // Only go to previous if at the start of the track
      const move = getQueueMove(howl.seek() < PREVIOUS_THRESHOLD ? -1 : 0);
      if (move.type === "stop") {
        stop();
      } else if (move.type === "track") {
        if (move.track.id === playbackTrack?.id) {
          // Playing the same track just restart it
          seek(0);
        } else {
          // Play the previous track
          play(move.track);
          dispatch(updateQueue(move.index));
        }
      }
    }
  }, [store, getQueueMove, seek, play, stop]);

  // Move to next song or repeat this song on track end
  // This is a fallback for when the cross fade couldn't be armed, for the end
  // of the queue and for repeat off
  const handleEnd = useCallback(() => {
    const {
      queue,
      repeat,
      track: playbackTrack,
    } = store.getState().playlistPlayback;
    if (!queue) {
      stop();
    } else if (repeat === "track") {
      seek(0);
      trackRef.current?.play();
    } else {
      const move = getQueueMove(1);
      if (move.type === "stop") {
        stop();
      } else if (move.type === "track") {
        if (move.track.id === playbackTrack?.id) {
          // Playing the same track just restart it
          seek(0);
          trackRef.current?.play();
        } else {
          // Play the next track
          play(move.track);
          dispatch(updateQueue(move.index));
        }
      }
    }
  }, [store, getQueueMove, seek, play, stop]);

  // Keep the handlers used by the howl events up to date
  useEffect(() => {
    handleEndRef.current = handleEnd;
  }, [handleEnd]);

  useEffect(() => {
    armCrossFadeRef.current = armCrossFade;
  }, [armCrossFade]);

  // Re-arm the cross fade when the setting changes
  useEffect(() => {
    armCrossFadeRef.current();
  }, [crossfade]);

  useEffect(() => {
    return () => {
      clearCrossFade();
      stopFade();
      stopTransportFade();
      removePreload();
      removeOutgoing();
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  const pauseResume = useCallback(
    (resume: boolean) => {
      // Apply to all live instances so a cross fade can't leave a track playing
      // uncontrolled. Howler creates a second sound when play is called on an
      // already playing howl so only call it when it isn't playing.
      if (resume) {
        if (trackRef.current && !trackRef.current.playing()) {
          // Open the transport before the first samples are pulled so the
          // track can't be heard at full gain for a frame before the ramp
          if (transportRef.current === null) {
            applyVolume();
          }
          trackRef.current.play();
        }
        // Only resume an outgoing track that was paused, one that reached its
        // own end would otherwise start playing again from the beginning
        if (outgoingPausedRef.current && outgoingRef.current) {
          outgoingPausedRef.current = false;
          if (!outgoingRef.current.playing()) {
            outgoingRef.current.play();
          }
        }
        // Ramp back up from wherever the pause left the transport. A track
        // that is starting rather than resuming is already at full gain, so
        // this is a no op there and the cross fade does the fade in
        rampTransport(1);
      } else {
        if (!trackRef.current?.playing() && !outgoingRef.current?.playing()) {
          // Nothing audible to ramp down
          stopTransportFade();
          trackRef.current?.pause();
          return;
        }
        rampTransport(0, () => {
          trackRef.current?.pause();
          if (outgoingRef.current?.playing()) {
            outgoingPausedRef.current = true;
            outgoingRef.current.pause();
          }
        });
      }
    },
    [applyVolume, rampTransport, stopTransportFade],
  );

  const mute = useCallback((muted: boolean) => {
    trackRef.current?.mute(muted);
    outgoingRef.current?.mute(muted);
    preloadRef.current?.howl.mute(muted);
  }, []);

  const volume = useCallback(
    (volume: number) => {
      applyVolume(volume);
    },
    [applyVolume],
  );

  return {
    seek,
    play,
    next,
    previous,
    stop,
    pauseResume,
    mute,
    volume,
  };
}
