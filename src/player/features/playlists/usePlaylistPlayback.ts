import { useCallback, useEffect, useRef } from "react";

import { useDispatch, useSelector, useStore } from "react-redux";
import { RootState } from "../../app/store";
import { audioContextTime, WebAudioTrack } from "../../common/WebAudioTrack";
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
  const trackRef = useRef<WebAudioTrack | null>(null);
  /** Track that is fading out during a cross fade */
  const outgoingRef = useRef<WebAudioTrack | null>(null);
  /** Next track loaded ahead of a cross fade */
  const preloadRef = useRef<{ id: string; track: WebAudioTrack } | null>(null);
  /**
   * Cross fade gain of each live instance.
   * The master volume is multiplied by these before it reaches a track so that
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
   * stopping a track outright, which cuts the waveform part way through a
   * cycle and is heard as a click
   */
  const transportFadeRef = useRef(1);
  /** Gain the transport fade in flight is heading towards */
  const transportTargetRef = useRef(1);
  /** Interval that steps the transport fade */
  const transportRef = useRef<NodeJS.Timeout | null>(null);
  /** Timer that runs the callback of a scheduled transport fade on arrival */
  const transportEndRef = useRef<NodeJS.Timeout | null>(null);
  /** Whether the transport gain is being run as scheduled automation */
  const transportAutomatedRef = useRef(false);
  /** Interval that steps the equal power cross fade */
  const fadeRef = useRef<NodeJS.Timeout | null>(null);
  /** Timer that ends a scheduled cross fade, null while one is held */
  const fadeEndRef = useRef<NodeJS.Timeout | null>(null);
  /** Whether the cross fade gains are being run as scheduled automation */
  const fadeAutomatedRef = useRef(false);
  /** Progress the scheduled cross fade segment in flight started from */
  const fadeProgressRef = useRef(0);
  /** Audio clock time that segment was scheduled at */
  const fadeStartRef = useRef(0);
  /** Length of the cross fade as a whole */
  const fadeDurationRef = useRef(0);
  /** Timeout that starts the cross fade ahead of the end of the track */
  const crossFadeRef = useRef<NodeJS.Timeout | null>(null);
  const animationRef = useRef<number | null>(null);
  /** Track event handlers held in refs to avoid a circular dependency with play */
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

  /**
   * Push the current gain of every live instance to its track.
   * A track's volume is the master volume scaled by its cross fade gain and by
   * the transport gain, so a volume slider tick, a cross fade and a transport
   * fade can all be in flight at once without cancelling each other.
   * A gain that is being run as scheduled automation is left out of the
   * product: it is already being applied inside that track's own graph, so
   * multiplying it in here would both apply it twice and step what the
   * automation is doing smoothly.
   */
  const applyVolume = useCallback(
    (override?: number) => {
      const volume = override ?? store.getState().playlistPlayback.volume;
      const transport = transportAutomatedRef.current
        ? 1
        : transportFadeRef.current;
      const track = fadeAutomatedRef.current ? 1 : trackFadeRef.current;
      const outgoing = fadeAutomatedRef.current ? 1 : outgoingFadeRef.current;
      trackRef.current?.volume(volume * track * transport);
      outgoingRef.current?.volume(volume * outgoing * transport);
    },
    [store],
  );

  /**
   * End the cross fade in flight, however it is being run.
   * A scheduled fade hands the gain it had reached back to the refs, in the
   * same tick as it is taken out of the graph, so that nothing downstream has
   * to care which of the two paths the fade was taking.
   */
  const stopFade = useCallback(() => {
    if (fadeRef.current !== null) {
      clearInterval(fadeRef.current);
      fadeRef.current = null;
    }
    if (fadeEndRef.current !== null) {
      clearTimeout(fadeEndRef.current);
      fadeEndRef.current = null;
    }
    if (!fadeAutomatedRef.current) {
      return;
    }
    fadeAutomatedRef.current = false;
    const track = trackRef.current;
    const outgoing = outgoingRef.current;
    if (track) {
      trackFadeRef.current = track.holdGain("fade");
      track.setGain("fade", 1);
    }
    if (outgoing) {
      outgoingFadeRef.current = outgoing.holdGain("fade");
      outgoing.setGain("fade", 1);
    }
    applyVolume();
  }, [applyVolume]);

  /**
   * End the transport fade in flight without moving the gain it reached.
   * A scheduled ramp also drops the timer that would have run its completion
   * callback, which is what stops a cancelled pause from pausing the playback
   * a moment later.
   */
  const stopTransportFade = useCallback(() => {
    if (transportRef.current !== null) {
      clearInterval(transportRef.current);
      transportRef.current = null;
    }
    if (transportEndRef.current !== null) {
      clearTimeout(transportEndRef.current);
      transportEndRef.current = null;
    }
    if (!transportAutomatedRef.current) {
      return;
    }
    transportAutomatedRef.current = false;
    const track = trackRef.current;
    const outgoing = outgoingRef.current;
    // Every live instance is ramped together so either one has the gain the
    // transport reached
    let gain: number | null = null;
    if (track) {
      gain = track.holdGain("transport");
      track.setGain("transport", 1);
    }
    if (outgoing) {
      const outgoingGain = outgoing.holdGain("transport");
      gain = gain ?? outgoingGain;
      outgoing.setGain("transport", 1);
    }
    if (gain !== null) {
      transportFadeRef.current = gain;
    }
    applyVolume();
  }, [applyVolume]);

  /** Drop any transport fade in flight and return to full gain */
  const resetTransport = useCallback(() => {
    stopTransportFade();
    transportTargetRef.current = 1;
    transportFadeRef.current = 1;
  }, [stopTransportFade]);

  /**
   * Whether every live instance can have its gain scheduled on the audio clock.
   * One that can't, a remote URL that may not be routable through Web Audio,
   * drops the whole fade back to the stepped path: the two sides of a cross
   * fade have to be driven the same way to stay in step with each other.
   */
  const canAutomate = useCallback(() => {
    const track = trackRef.current;
    const outgoing = outgoingRef.current;
    if (!track && !outgoing) {
      return false;
    }
    return (!track || track.routable) && (!outgoing || outgoing.routable);
  }, []);

  /**
   * Ramp the transport gain to `target` and run `onComplete` once it arrives.
   * The duration is scaled by the distance left to cover so that a fade which
   * is reversed part way through doesn't crawl back over the remainder.
   */
  const rampTransport = useCallback(
    (target: number, onComplete?: () => void) => {
      const fading =
        transportRef.current !== null || transportEndRef.current !== null;
      if (fading && transportTargetRef.current === target) {
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
      // Raised cosine so the ramp leaves and arrives at rest. A linear ramp
      // hinges at both ends, which is audible as a chirp on a sustained note
      const shape = (progress: number) =>
        from + (target - from) * ((1 - Math.cos(progress * Math.PI)) / 2);
      if (canAutomate()) {
        const start = audioContextTime();
        transportAutomatedRef.current = true;
        // Hand the transport gain over to the graph before it is scheduled
        // there, so that the gain is never counted twice
        applyVolume();
        trackRef.current?.scheduleGain(
          "transport",
          start,
          duration / 1000,
          shape,
        );
        outgoingRef.current?.scheduleGain(
          "transport",
          start,
          duration / 1000,
          shape,
        );
        // A scheduled ramp has nothing to report its own arrival, so the
        // callback is run by a timer that `stopTransportFade` clears with it
        transportEndRef.current = setTimeout(() => {
          transportEndRef.current = null;
          transportFadeRef.current = target;
          onComplete?.();
        }, duration);
        return;
      }
      let elapsed = 0;
      let prevTime = performance.now();
      function step() {
        const time = performance.now();
        elapsed += time - prevTime;
        prevTime = time;
        const progress = Math.min(elapsed / duration, 1);
        transportFadeRef.current = shape(progress);
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
    [applyVolume, stopTransportFade, canAutomate],
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

  /**
   * Schedule the rest of the equal power cross fade on the audio clock.
   * `from` is how much of the fade is already behind it, which is how a fade
   * that was held over a pause picks up exactly where it stopped.
   */
  const scheduleFade = useCallback(
    (from: number) => {
      const track = trackRef.current;
      const outgoing = outgoingRef.current;
      const outgoingStart = outgoingStartFadeRef.current;
      // The progress of the segment being scheduled maps onto the progress of
      // the cross fade as a whole
      const at = (progress: number) => from + (1 - from) * progress;
      const trackShape = (progress: number) =>
        Math.sin((at(progress) * Math.PI) / 2);
      const outgoingShape = (progress: number) =>
        outgoingStart * Math.cos((at(progress) * Math.PI) / 2);

      fadeProgressRef.current = from;
      fadeAutomatedRef.current = true;
      // The fade gains are applied in the graph from here, so they come back
      // out of the volume that is pushed to each track
      applyVolume();

      if (!track?.playing() && !outgoing?.playing()) {
        // Scheduled automation runs on the audio clock whatever the playback
        // is doing, so a fade that isn't being heard is pinned where it
        // reached and is scheduled again once the playback resumes
        track?.setGain("fade", trackShape(0));
        outgoing?.setGain("fade", outgoingShape(0));
        return;
      }

      const remaining = Math.max(fadeDurationRef.current * (1 - from), 0);
      fadeStartRef.current = audioContextTime();
      track?.scheduleGain(
        "fade",
        fadeStartRef.current,
        remaining / 1000,
        trackShape,
      );
      outgoing?.scheduleGain(
        "fade",
        fadeStartRef.current,
        remaining / 1000,
        outgoingShape,
      );
      fadeEndRef.current = setTimeout(() => {
        fadeEndRef.current = null;
        fadeAutomatedRef.current = false;
        trackFadeRef.current = 1;
        outgoingFadeRef.current = 0;
        trackRef.current?.setGain("fade", 1);
        outgoingRef.current?.setGain("fade", 1);
        applyVolume();
        removeOutgoing();
      }, remaining);
    },
    [applyVolume, removeOutgoing],
  );

  /**
   * Hold a scheduled cross fade where it has reached while nothing is heard.
   * The stepped path does this by not advancing its own clock, automation has
   * to be taken down and put back up by `resumeFade`.
   */
  const holdFade = useCallback(() => {
    if (!fadeAutomatedRef.current || fadeEndRef.current === null) {
      return;
    }
    clearTimeout(fadeEndRef.current);
    fadeEndRef.current = null;
    const from = fadeProgressRef.current;
    const remaining = fadeDurationRef.current * (1 - from);
    const elapsed = (audioContextTime() - fadeStartRef.current) * 1000;
    const progress = remaining <= 0 ? 1 : Math.min(elapsed / remaining, 1);
    fadeProgressRef.current = from + (1 - from) * progress;
    trackRef.current?.holdGain("fade");
    outgoingRef.current?.holdGain("fade");
  }, []);

  /** Pick a held cross fade back up from the point the hold left it at */
  const resumeFade = useCallback(() => {
    if (!fadeAutomatedRef.current || fadeEndRef.current !== null) {
      return;
    }
    scheduleFade(fadeProgressRef.current);
  }, [scheduleFade]);

  /**
   * Cross fade the outgoing track out and the current track in, at equal power.
   * When every live instance is routable the curve is scheduled on the audio
   * clock, which moves the gain per sample. Everything else is hand stepped:
   * a media element's volume is all there is to move for a track that can't be
   * routed through Web Audio, and the fade a media element can run itself is
   * linear only, which dips by around -3dB at the midpoint, and is cancelled
   * by the volume slider.
   */
  const startFade = useCallback(
    (duration: number) => {
      stopFade();
      fadeDurationRef.current = duration;
      if (canAutomate()) {
        scheduleFade(0);
        return;
      }
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
    [applyVolume, stopFade, removeOutgoing, canAutomate, scheduleFade],
  );

  const removePreload = useCallback(() => {
    const preload = preloadRef.current;
    preloadRef.current = null;
    preload?.track.unload();
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
      const track = new WebAudioTrack({
        src: move.track.url,
        mute: store.getState().playlistPlayback.muted,
        volume: 0,
      });
      // A track that failed to load can never report a load again, so it has
      // to be dropped here rather than handed to `play` where it would stall
      // the playback for good
      track.once("loaderror", () => {
        if (preloadRef.current?.track === track) {
          preloadRef.current = null;
        }
        track.unload();
      });
      preloadRef.current = { id: move.track.id, track };
    } catch {
      // A track that fails to preload is loaded again when it starts playing
      preloadRef.current = null;
    }
  }, [getQueueMove, removePreload, store]);

  /** Take the preloaded instance for this track if there is a usable one */
  const takePreloadedTrack = useCallback(
    (track: Track): WebAudioTrack | null => {
      const preload = preloadRef.current;
      preloadRef.current = null;
      if (!preload) {
        return null;
      }
      // Only an instance that finished loading is safe to reuse: one that is
      // still loading, or that failed to load, would leave `play` waiting on a
      // load that may never arrive
      if (preload.id !== track.id || preload.track.state() !== "loaded") {
        preload.track.unload();
        return null;
      }
      return preload.track;
    },
    [],
  );

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
        const playback =
          takePreloadedTrack(track) ||
          new WebAudioTrack({
            src: track.url,
            mute: store.getState().playlistPlayback.muted,
            volume: 0,
          });

        trackRef.current = playback;
        const handleLoad = () => {
          dispatch(
            playTrack({
              track,
              duration: Math.floor(playback.duration()),
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
            if (playback.playing() && delta > 1000) {
              dispatch(updatePlayback(Math.floor(playback.seek())));
              prevTime = time;
            }
          }
          animationRef.current = requestAnimationFrame(animatePlayback);
        };

        playback.on("end", () => handleEndRef.current());
        playback.on("play", () => {
          // A cross fade held because nothing was being heard starts running
          // from here, the moment the samples actually start moving again
          resumeFade();
          // Arming from the play event keeps the timer in step with pause and resume
          armCrossFadeRef.current();
        });
        playback.on("pause", () => clearCrossFade());
        // A seek pauses and restarts the playback internally, which reports no
        // play, so the timer is re-armed from the seek instead
        playback.on("seek", () => armCrossFadeRef.current());

        playback.on("loaderror", error);

        playback.on("playerror", error);

        if (playback.state() === "loaded") {
          // A preloaded track has already reported its load
          handleLoad();
        } else {
          playback.once("load", handleLoad);
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
      resumeFade,
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
    const track = trackRef.current;
    if (!track?.playing()) {
      // Nothing audible to ramp down
      resetTransport();
      applyVolume();
      track?.stop();
      return;
    }
    // `playPause(false)` above reaches `pauseResume` through the store on the
    // next render. That ramp is towards the same gain as this one so it joins
    // this fade rather than starting its own, and the stop below wins
    rampTransport(0, () => {
      track.stop();
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
    const track = trackRef.current;
    if (!track) {
      return;
    }
    const crossfade = store.getState().playlistPlayback.crossfade;
    if (crossfade <= 0) {
      // Cross fading is disabled, the end event moves to the next track
      return;
    }
    if (!track.playing()) {
      // Re-armed from the play event once the playback resumes
      return;
    }
    const duration = track.duration();
    // duration can be 0 or Infinity until the metadata has loaded
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }
    const progress = track.seek();
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
    const track = trackRef.current;
    if (!track) {
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
      const move = getQueueMove(track.seek() < PREVIOUS_THRESHOLD ? -1 : 0);
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

  // Keep the handlers used by the track events up to date
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
      // Releases the element and the graph nodes the track is holding, which
      // nothing else is going to come back for once the player is gone
      trackRef.current?.unload();
      trackRef.current = null;
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  const pauseResume = useCallback(
    (resume: boolean) => {
      // Apply to all live instances so a cross fade can't leave a track
      // playing uncontrolled
      if (resume) {
        if (trackRef.current && !trackRef.current.playing()) {
          // Open the transport before the first samples are pulled so the
          // track can't be heard at full gain for a frame before the ramp
          if (
            transportRef.current === null &&
            transportEndRef.current === null
          ) {
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
        // A cross fade held over the pause runs again from here. The play
        // event does this as well, for a resume that didn't come through the
        // transport, and whichever gets there first wins
        resumeFade();
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
          // Nothing is being heard from here, so a cross fade scheduled on the
          // audio clock has to be held rather than left to run on without it
          holdFade();
        });
      }
    },
    [applyVolume, rampTransport, stopTransportFade, resumeFade, holdFade],
  );

  const mute = useCallback((muted: boolean) => {
    trackRef.current?.mute(muted);
    outgoingRef.current?.mute(muted);
    preloadRef.current?.track.mute(muted);
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
