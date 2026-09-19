import { isWebAudioRoutable, toPlaybackURL } from "./mediaURL";

/** Events emitted by a track, named to match the Howler events they replace */
export type TrackEvent =
  | "load"
  | "loaderror"
  | "play"
  | "pause"
  | "stop"
  | "end"
  | "seek"
  | "fade"
  | "playerror";

export type TrackState = "unloaded" | "loading" | "loaded";

/**
 * Gains that sit between the source and the track's own volume.
 * They are separate AudioParams so that a cross fade, a transport fade and the
 * volume slider can be in flight at once and multiply together in the graph
 * instead of fighting over a single value.
 */
export type TrackGain = "fade" | "transport";

/** Maps the progress of an automated gain, 0 to 1, onto the gain to apply */
export type GainShape = (progress: number) => number;

export type WebAudioTrackOptions = {
  /** Stored URL of the track, converted to a playback URL by the track */
  src: string;
  volume?: number;
  mute?: boolean;
  loop?: boolean;
  autoplay?: boolean;
};

type Listener = {
  event: TrackEvent;
  fn: () => void;
  once: boolean;
};

/** A linear volume fade in flight, kept so its value can be read back */
type Fade = {
  from: number;
  to: number;
  /** Wall clock time the fade started at */
  start: number;
  duration: number;
};

/** Step of a fade driven by the element's own volume, matching Howler's */
const FALLBACK_FADE_STEP = 25;
/**
 * Resolution of an automated gain. Each step is a linear ramp rather than a
 * held value, so this is the rate at which the curve is re-aimed rather than
 * the rate at which the gain moves, and the gain itself is continuous.
 */
const CURVE_STEPS_PER_SECOND = 400;
const MIN_CURVE_STEPS = 8;
const MAX_CURVE_STEPS = 512;

/**
 * One AudioContext is shared by the whole player renderer. A context holds an
 * output device open, so one per track would run the renderer out of them, and
 * the two sides of a cross fade can only be scheduled against each other when
 * they share a clock.
 */
let sharedContext: AudioContext | null = null;
let contextUnavailable = false;

function getAudioContext(): AudioContext | null {
  if (contextUnavailable) {
    return null;
  }
  if (!sharedContext) {
    try {
      sharedContext = new AudioContext();
    } catch {
      // Without a context every track falls back to driving the element's own
      // volume, which is what playback did before any of this existed
      contextUnavailable = true;
      return null;
    }
  }
  return sharedContext;
}

/** The clock scheduled gain changes are timed against, in seconds */
export function audioContextTime(): number {
  return sharedContext?.currentTime ?? 0;
}

/**
 * A context can be handed over suspended and only start once the page has been
 * interacted with. Nothing is heard until it is running, so every path that
 * starts playback asks for it back.
 */
function resumeAudioContext(): void {
  if (sharedContext?.state === "suspended") {
    // A rejected resume leaves the context suspended, which is where it
    // already is, so there is nothing to handle
    void sharedContext.resume().catch(() => {
      // Resumed again by the next play
    });
  }
}

/**
 * Drop the automation on a param and leave it at the value it has reached.
 * `cancelScheduledValues` on its own restores the value from before the
 * automation started, which is heard as a jump, so the value is pinned first.
 */
function holdParam(param: AudioParam, time: number): number {
  const value = param.value;
  if (typeof param.cancelAndHoldAtTime === "function") {
    param.cancelAndHoldAtTime(time);
  } else {
    param.cancelScheduledValues(time);
    param.setValueAtTime(value, time);
  }
  return value;
}

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) {
    return 0;
  }
  return Math.min(Math.max(volume, 0), 1);
}

/**
 * A single streaming track with the part of the Howler API the player uses.
 *
 * A local file is served over a CORS enabled scheme so its element can be
 * routed through Web Audio, where every gain change is scheduled on the audio
 * clock and is therefore sample accurate. A remote URL may not answer with the
 * CORS headers that routing needs, and an element that is refused is silent
 * rather than failing, so those keep driving the element's own volume exactly
 * as Howler's html5 mode does. `routable` says which of the two happened.
 *
 * Neither mode decodes the file up front: the element streams it either way.
 */
export class WebAudioTrack {
  /** Whether this instance's gains can be automated on the audio clock */
  readonly routable: boolean;

  private _element: HTMLAudioElement;
  private _context: AudioContext | null = null;
  private _source: MediaElementAudioSourceNode | null = null;
  private _fadeGain: GainNode | null = null;
  private _transportGain: GainNode | null = null;
  private _volumeGain: GainNode | null = null;
  private _muteGain: GainNode | null = null;

  private _listeners: Listener[] = [];
  private _state: TrackState = "unloaded";
  private _volume: number;
  private _muted: boolean;
  private _autoplay: boolean;
  private _unloaded = false;
  /** Volume fade in flight, driven by `fade()` rather than by the playlist */
  private _fade: Fade | null = null;
  private _fadeTimeout: NodeJS.Timeout | null = null;
  private _fadeInterval: NodeJS.Timeout | null = null;
  /** Seek requested before there was any media data to seek within */
  private _pendingSeek: number | null = null;
  /** Whether the next pause event came from `stop` rather than the transport */
  private _suppressPause = false;

  constructor(options: WebAudioTrackOptions) {
    const url = toPlaybackURL(options.src);
    const context = isWebAudioRoutable(url) ? getAudioContext() : null;

    this._volume = clampVolume(options.volume ?? 1);
    this._muted = options.mute ?? false;
    this._autoplay = options.autoplay ?? false;

    const element = new Audio();
    if (context) {
      // The response is only CORS approved, and so the element only allowed
      // into the graph, when the request was a CORS request. The attribute is
      // read when the load starts so it has to be set before the source is
      element.crossOrigin = "anonymous";
    }
    // Stream rather than hold the file in memory, a track can be an hour of
    // ambience and nothing here ever needs the samples up front
    element.preload = "auto";
    element.loop = options.loop ?? false;
    this._element = element;

    if (context) {
      try {
        this._source = context.createMediaElementSource(element);
        this._fadeGain = context.createGain();
        this._transportGain = context.createGain();
        this._volumeGain = context.createGain();
        this._muteGain = context.createGain();
        this._source
          .connect(this._fadeGain)
          .connect(this._transportGain)
          .connect(this._volumeGain)
          .connect(this._muteGain)
          .connect(context.destination);
        this._context = context;
      } catch {
        // An element can only be given to `createMediaElementSource` once and
        // a context that has been closed refuses to build nodes at all. Either
        // way this track plays back through the element's own volume instead
        this._releaseNodes();
      }
    }
    this.routable = this._context !== null;

    this._applyVolume();
    this._applyMute();

    this._addElementListeners();
    element.src = url;
    element.load();
    this._state = "loading";
  }

  state(): TrackState {
    return this._state;
  }

  duration(): number {
    const duration = this._element.duration;
    // The duration is unknown until the metadata arrives, and is Infinity for
    // a stream, which is what Howler's html5 mode reports here as well
    return Number.isNaN(duration) ? 0 : duration;
  }

  playing(): boolean {
    return !this._element.paused && !this._element.ended;
  }

  seek(): number;
  seek(to: number): void;
  seek(to?: number): number | void {
    if (to === undefined) {
      return this._pendingSeek ?? this._element.currentTime;
    }
    if (this._unloaded) {
      return;
    }
    if (this._element.readyState === HTMLMediaElement.HAVE_NOTHING) {
      // Seeking before there is any media data is rejected, so the position is
      // held and applied as soon as the metadata arrives
      this._pendingSeek = to;
    } else {
      this._pendingSeek = null;
      this._element.currentTime = to;
    }
    this._emit("seek");
  }

  play(): void {
    if (this._unloaded || this.playing()) {
      return;
    }
    resumeAudioContext();
    const played = this._element.play();
    if (played) {
      played.catch((error: unknown) => {
        // A play that is interrupted by a pause or by an unload rejects with
        // an AbortError. That isn't a playback failure and must not be turned
        // into one or a quick pause would stop the queue
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        this._emit("playerror");
      });
    }
  }

  pause(): void {
    if (this._unloaded) {
      return;
    }
    this._element.pause();
  }

  stop(): void {
    if (this._unloaded) {
      return;
    }
    if (!this._element.paused) {
      // Howler's stop doesn't report a pause, and the playlist uses the pause
      // event to decide the playback is being held rather than torn down
      this._suppressPause = true;
    }
    this._element.pause();
    this.seek(0);
    this._emit("stop");
  }

  volume(): number;
  volume(volume: number): void;
  volume(volume?: number): number | void {
    if (volume === undefined) {
      const fade = this._fade;
      if (!fade) {
        return this._volume;
      }
      // Read the fade back off its own clock rather than off the graph: an
      // AudioParam only reports the value it had at the start of the current
      // render quantum, and a fade that has just been started would read back
      // as the value it is moving away from
      const progress =
        fade.duration <= 0
          ? 1
          : Math.min((performance.now() - fade.start) / fade.duration, 1);
      return fade.from + (fade.to - fade.from) * progress;
    }
    // Setting the volume outright drops a fade in flight, as Howler does, so
    // that the volume slider always wins over a fade it didn't start
    this._stopFade(true);
    this._volume = clampVolume(volume);
    this._applyVolume();
  }

  mute(muted: boolean): void {
    this._muted = muted;
    this._applyMute();
  }

  loop(loop: boolean): void {
    this._element.loop = loop;
  }

  /**
   * Linearly fade the track's own volume and emit `fade` once it arrives.
   * This is the declick and soundboard fade; the playlist cross fade and
   * transport fade run on the gains below instead so that the volume slider
   * and a fade can't cancel each other.
   */
  fade(from: number, to: number, duration: number): void {
    // Cancelled without reporting a fade: the handler that is waiting on this
    // fade's own completion is usually registered just before it starts, and
    // an earlier fade ending here would fire it before this one has moved
    this._stopFade(false);
    if (this._unloaded) {
      return;
    }
    const start = clampVolume(from);
    const end = clampVolume(to);
    const length = Math.max(duration, 0);
    this._fade = {
      from: start,
      to: end,
      start: performance.now(),
      duration: length,
    };
    if (this._volumeGain && this._context) {
      const now = this._context.currentTime;
      const param = this._volumeGain.gain;
      holdParam(param, now);
      param.setValueAtTime(start, now);
      param.linearRampToValueAtTime(end, now + length / 1000);
    } else {
      this._element.volume = start;
      this._fadeInterval = setInterval(() => {
        this._element.volume = clampVolume(this.volume());
      }, FALLBACK_FADE_STEP);
    }
    this._fadeTimeout = setTimeout(() => {
      this._fadeTimeout = null;
      this._clearFadeInterval();
      this._fade = null;
      this._volume = end;
      this._applyVolume();
      this._emit("fade");
    }, length);
  }

  /** Current value of a scheduled gain */
  gain(which: TrackGain): number {
    return this._gainNode(which)?.gain.value ?? 1;
  }

  /** Set a scheduled gain outright, dropping anything scheduled on it */
  setGain(which: TrackGain, value: number): void {
    const node = this._gainNode(which);
    if (!node || !this._context) {
      return;
    }
    const now = this._context.currentTime;
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(value, now);
  }

  /**
   * Drop the automation on a gain and leave it where it has reached.
   * Returns that value so the caller can carry on from it, which is how a
   * cross fade survives being held over a pause.
   */
  holdGain(which: TrackGain): number {
    const node = this._gainNode(which);
    if (!node || !this._context) {
      return 1;
    }
    return holdParam(node.gain, this._context.currentTime);
  }

  /**
   * Schedule `shape` onto a gain on the audio clock, from `startTime` for
   * `duration` seconds.
   *
   * The shape is laid down as a run of linear ramps. `setValueCurveAtTime`
   * interpolates between its points in exactly the same way, but a curve event
   * can't overlap another one, which a cross fade that is held over a pause
   * and rescheduled from where it stopped would do.
   */
  scheduleGain(
    which: TrackGain,
    startTime: number,
    duration: number,
    shape: GainShape,
  ): void {
    const node = this._gainNode(which);
    if (!node || !this._context) {
      return;
    }
    const param = node.gain;
    const start = Math.max(startTime, this._context.currentTime);
    holdParam(param, start);
    if (duration <= 0) {
      param.setValueAtTime(shape(1), start);
      return;
    }
    const steps = Math.min(
      MAX_CURVE_STEPS,
      Math.max(MIN_CURVE_STEPS, Math.ceil(duration * CURVE_STEPS_PER_SECOND)),
    );
    param.setValueAtTime(shape(0), start);
    for (let step = 1; step <= steps; step++) {
      const progress = step / steps;
      param.linearRampToValueAtTime(
        shape(progress),
        start + duration * progress,
      );
    }
  }

  on(event: TrackEvent, fn: () => void): void {
    this._listeners.push({ event, fn, once: false });
  }

  once(event: TrackEvent, fn: () => void): void {
    this._listeners.push({ event, fn, once: true });
  }

  /** Remove one handler, every handler for an event, or every handler */
  off(event?: TrackEvent, fn?: () => void): void {
    this._listeners = this._listeners.filter((listener) => {
      const matchesEvent = event === undefined || listener.event === event;
      const matchesHandler = fn === undefined || listener.fn === fn;
      return !(matchesEvent && matchesHandler);
    });
  }

  /**
   * Tear the track down: stop the playback, abort the download and release the
   * graph. Without the disconnect each track would leave a node chain and a
   * source holding its element alive for as long as the player is open.
   */
  unload(): void {
    if (this._unloaded) {
      return;
    }
    this._unloaded = true;
    this._stopFade(false);
    this._removeElementListeners();
    this._element.pause();
    this._releaseNodes();
    // Dropping the source and reloading is what stops the element pulling the
    // rest of the file down in the background
    this._element.removeAttribute("src");
    this._element.load();
    this._state = "unloaded";
    this._listeners = [];
  }

  private _gainNode(which: TrackGain): GainNode | null {
    return which === "fade" ? this._fadeGain : this._transportGain;
  }

  private _applyVolume(): void {
    if (this._volumeGain && this._context) {
      // Applied at the head of the next render quantum rather than ramped:
      // the playlist hands a gain over between this volume and the scheduled
      // gains below in a single tick, and the two only stay in step with each
      // other, rather than dipping or jumping between them, if neither moves
      const now = this._context.currentTime;
      this._volumeGain.gain.cancelScheduledValues(now);
      this._volumeGain.gain.setValueAtTime(this._volume, now);
    } else {
      this._element.volume = this._volume;
    }
  }

  private _applyMute(): void {
    if (this._muteGain && this._context) {
      const now = this._context.currentTime;
      this._muteGain.gain.cancelScheduledValues(now);
      this._muteGain.gain.setValueAtTime(this._muted ? 0 : 1, now);
    } else {
      this._element.muted = this._muted;
    }
  }

  /**
   * End a volume fade early, leaving the volume where the fade had reached so
   * that cancelling one is never heard as a jump.
   */
  private _stopFade(emit: boolean): void {
    if (this._fadeTimeout !== null) {
      clearTimeout(this._fadeTimeout);
      this._fadeTimeout = null;
    }
    this._clearFadeInterval();
    if (!this._fade) {
      return;
    }
    this._volume = clampVolume(this.volume());
    this._fade = null;
    this._applyVolume();
    if (emit) {
      // Howler reports a cancelled fade as a completed one, and a handler that
      // is waiting on `fade` to release a track would otherwise never run
      this._emit("fade");
    }
  }

  private _clearFadeInterval(): void {
    if (this._fadeInterval !== null) {
      clearInterval(this._fadeInterval);
      this._fadeInterval = null;
    }
  }

  private _releaseNodes(): void {
    this._source?.disconnect();
    this._fadeGain?.disconnect();
    this._transportGain?.disconnect();
    this._volumeGain?.disconnect();
    this._muteGain?.disconnect();
    this._source = null;
    this._fadeGain = null;
    this._transportGain = null;
    this._volumeGain = null;
    this._muteGain = null;
    this._context = null;
  }

  private _emit(event: TrackEvent): void {
    // Copied because a handler is free to remove handlers, and `once` handlers
    // remove themselves before they run so that a handler which unloads the
    // track can't be reached a second time
    const listeners = this._listeners.filter(
      (listener) => listener.event === event,
    );
    if (listeners.length === 0) {
      return;
    }
    this._listeners = this._listeners.filter(
      (listener) => !(listener.event === event && listener.once),
    );
    for (const listener of listeners) {
      listener.fn();
    }
  }

  private _handleLoadedMetadata = (): void => {
    if (this._pendingSeek !== null) {
      const to = this._pendingSeek;
      this._pendingSeek = null;
      this._element.currentTime = to;
    }
  };

  private _handleCanPlay = (): void => {
    if (this._state === "loaded") {
      return;
    }
    this._state = "loaded";
    this._emit("load");
    if (this._autoplay) {
      this._autoplay = false;
      this.play();
    }
  };

  private _handlePlay = (): void => {
    this._emit("play");
  };

  private _handlePause = (): void => {
    if (this._suppressPause) {
      this._suppressPause = false;
      return;
    }
    // The element reports a pause as it ends as well, which is the end of the
    // track rather than the playback being held, and is reported as `end`
    if (this._element.ended) {
      return;
    }
    this._emit("pause");
  };

  private _handleEnded = (): void => {
    this._emit("end");
  };

  private _handleError = (): void => {
    if (this._state === "loaded") {
      this._emit("playerror");
    } else {
      this._state = "unloaded";
      this._emit("loaderror");
    }
  };

  private _addElementListeners(): void {
    this._element.addEventListener(
      "loadedmetadata",
      this._handleLoadedMetadata,
    );
    this._element.addEventListener("canplay", this._handleCanPlay);
    this._element.addEventListener("play", this._handlePlay);
    this._element.addEventListener("pause", this._handlePause);
    this._element.addEventListener("ended", this._handleEnded);
    this._element.addEventListener("error", this._handleError);
  }

  private _removeElementListeners(): void {
    this._element.removeEventListener(
      "loadedmetadata",
      this._handleLoadedMetadata,
    );
    this._element.removeEventListener("canplay", this._handleCanPlay);
    this._element.removeEventListener("play", this._handlePlay);
    this._element.removeEventListener("pause", this._handlePause);
    this._element.removeEventListener("ended", this._handleEnded);
    this._element.removeEventListener("error", this._handleError);
  }
}
