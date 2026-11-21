import { PreviewEngineState, PreviewLoadCommand } from "../../types/preview";

const MEDIA_SCHEME = "kenku-media://";
const SAMPLE_RATE = 48000;
const GAIN_RAMP = 0.015;
const PROGRESS_INTERVAL_MS = 200;

export interface PreviewAudioEngineCallbacks {
  onState: (state: PreviewEngineState) => void;
  onPlayingChange: (playing: boolean) => void;
  onWarning?: (message: string) => void;
}

export interface PreviewDiagnostics {
  requestId: number;
  routable: boolean;
  playing: boolean;
  sinkId: string;
  outputMuted: boolean;
  peakLevel: number;
}

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) {
    return 0;
  }
  return Math.min(Math.max(volume, 0), 1);
}

/**
 * GM-only preview playback engine that runs inside the hidden Audio Capture window.
 *
 * Preview playback lives here rather than in the Player view because the entire
 * Player view is tab-captured into the Discord broadcast and its Web Audio buses
 * feed the Stream Kit Voice Room. By decoding and playing preview audio on a
 * dedicated AudioContext inside this uncaptured window, preview samples never
 * enter the broadcast worklet (`_pcmStreamNode`) or the player's output buses.
 *
 * Output goes through a dedicated `<audio>` sink following the chosen monitor
 * device (`setSinkId`), completely independent of the live loopback element's
 * `muted` flag so previews remain audible even when "This Computer" is unticked.
 */
export class PreviewAudioEngine {
  private _callbacks: PreviewAudioEngineCallbacks;
  /** Dedicated AudioContext for routable local preview files, isolated from the live mix */
  private _context?: AudioContext;
  private _gainNode?: GainNode;
  private _analyser?: AnalyserNode;
  private _analyserData?: Float32Array<ArrayBuffer>;
  private _destination?: MediaStreamAudioDestinationNode;
  /** Dedicated sink element for Web Audio preview output, never muted by loopback */
  private _outputElement?: HTMLAudioElement;

  /** Currently loaded preview media element */
  private _element?: HTMLAudioElement;
  private _sourceNode?: MediaElementAudioSourceNode;
  private _routable = false;

  private _requestId = 0;
  private _loading = false;
  private _ended = false;
  private _volume = 0.8;
  private _muted = false;
  private _monitorDeviceId = "";
  private _pendingSeek: number | null = null;
  private _progressTimer: ReturnType<typeof setInterval> | null = null;
  private _lastReportedPlaying = false;

  constructor(callbacks: PreviewAudioEngineCallbacks) {
    this._callbacks = callbacks;
  }

  /** Route preview playback to the chosen monitor device, or system default when empty */
  async setMonitorDevice(deviceId: string): Promise<void> {
    this._monitorDeviceId = deviceId;
    const targets: HTMLAudioElement[] = [];
    if (this._outputElement) {
      targets.push(this._outputElement);
    }
    if (this._element && !this._routable) {
      targets.push(this._element);
    }
    for (const target of targets) {
      await this._applySinkId(target, deviceId);
    }
  }

  /** Load and start playing a preview track or sound */
  load(command: PreviewLoadCommand): void {
    this._teardownElement();
    this._requestId = command.requestId;
    this._volume = clampVolume(command.volume);
    this._muted = Boolean(command.muted);
    this._loading = true;
    this._ended = false;
    this._pendingSeek = null;

    const routable = command.url.startsWith(MEDIA_SCHEME);
    const element = document.createElement("audio");
    element.preload = "auto";
    element.loop = false;

    if (routable) {
      element.crossOrigin = "anonymous";
      const graphReady = this._ensurePreviewGraph();
      if (graphReady && this._context && this._gainNode) {
        try {
          this._sourceNode = this._context.createMediaElementSource(element);
          this._sourceNode.connect(this._gainNode);
          this._routable = true;
        } catch {
          this._routable = false;
        }
      } else {
        this._routable = false;
      }
    } else {
      // Remote URLs may not send CORS headers; driving the element directly
      // avoids Web Audio muting them silently while still following the monitor sink.
      this._routable = false;
    }

    this._element = element;
    this._applyVolume();

    if (!this._routable && this._monitorDeviceId) {
      void this._applySinkId(element, this._monitorDeviceId);
    }

    element.addEventListener("loadedmetadata", this._handleLoadedMetadata);
    element.addEventListener("canplay", this._handleCanPlay);
    element.addEventListener("play", this._handlePlay);
    element.addEventListener("pause", this._handlePause);
    element.addEventListener("ended", this._handleEnded);
    element.addEventListener("seeked", this._handleSeeked);
    element.addEventListener("error", this._handleError);

    element.src = command.url;
    element.load();
    this._emitState();
    this._startPlayback(element);
  }

  play(): void {
    const element = this._element;
    if (!element) {
      return;
    }
    if (this._ended || element.ended) {
      this._ended = false;
      element.currentTime = 0;
    }
    this._startPlayback(element);
  }

  pause(): void {
    if (!this._element) {
      return;
    }
    this._element.pause();
  }

  seek(to: number): void {
    const element = this._element;
    if (!element || !Number.isFinite(to)) {
      return;
    }
    const clamped = Math.max(0, to);
    const duration = this._safeDuration(element);
    const target = duration > 0 ? Math.min(clamped, duration) : clamped;
    this._ended = false;
    if (element.readyState === HTMLMediaElement.HAVE_NOTHING) {
      this._pendingSeek = target;
    } else {
      this._pendingSeek = null;
      element.currentTime = target;
    }
    this._emitState();
  }

  setVolume(volume: number): void {
    this._volume = clampVolume(volume);
    this._applyVolume();
  }

  setMuted(muted: boolean): void {
    this._muted = Boolean(muted);
    this._applyVolume();
  }

  stop(): void {
    const hadElement = Boolean(this._element);
    this._teardownElement();
    this._loading = false;
    this._ended = false;
    this._pendingSeek = null;
    this._setPlaying(false);
    if (hadElement) {
      this._emitState();
    }
  }

  destroy(): void {
    this.stop();
    if (this._outputElement) {
      this._outputElement.pause();
      this._outputElement.srcObject = null;
      this._outputElement = undefined;
    }
    this._gainNode?.disconnect();
    this._analyser?.disconnect();
    this._gainNode = undefined;
    this._analyser = undefined;
    this._analyserData = undefined;
    this._destination = undefined;
    if (this._context) {
      void this._context.close().catch(() => {
        // Already closed
      });
      this._context = undefined;
    }
  }

  getDiagnostics(): PreviewDiagnostics {
    const activeOutput = this._routable ? this._outputElement : this._element;
    return {
      requestId: this._requestId,
      routable: this._routable,
      playing: this._isPlaying(),
      sinkId:
        (activeOutput as (HTMLAudioElement & { sinkId?: string }) | undefined)
          ?.sinkId ?? this._monitorDeviceId,
      outputMuted: activeOutput ? activeOutput.muted : false,
      peakLevel: this._measurePeakLevel(),
    };
  }

  private _ensurePreviewGraph(): boolean {
    if (this._context && this._gainNode && this._destination && this._outputElement) {
      return true;
    }
    try {
      const context = new AudioContext({
        latencyHint: "playback",
        sampleRate: SAMPLE_RATE,
      });
      const gainNode = context.createGain();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      const destination = context.createMediaStreamDestination();

      gainNode.connect(analyser);
      analyser.connect(destination);

      const outputElement = document.createElement("audio");
      outputElement.srcObject = destination.stream;
      outputElement.muted = false;
      outputElement.onloadedmetadata = () => {
        void outputElement.play().catch(() => {
          // Resumed on next preview play
        });
      };

      this._context = context;
      this._gainNode = gainNode;
      this._analyser = analyser;
      this._analyserData = new Float32Array(analyser.fftSize);
      this._destination = destination;
      this._outputElement = outputElement;
      this._applyVolume();

      if (this._monitorDeviceId) {
        void this._applySinkId(outputElement, this._monitorDeviceId);
      }
      return true;
    } catch {
      return false;
    }
  }

  private _startPlayback(element: HTMLAudioElement): void {
    if (this._routable && this._context?.state === "suspended") {
      void this._context.resume().catch(() => {
        // Resumed on next play
      });
    }
    if (this._routable && this._outputElement && this._outputElement.paused) {
      void this._outputElement.play().catch(() => {
        // Output stream will start once metadata arrives
      });
    }
    const played = element.play();
    if (played) {
      played.catch((error: unknown) => {
        if (this._element !== element) {
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        this._loading = false;
        this._setPlaying(false);
        this._emitState("Unable to play preview audio");
      });
    }
  }

  private _applyVolume(): void {
    const effective = this._muted ? 0 : this._volume;
    if (this._routable && this._gainNode && this._context) {
      this._gainNode.gain.setTargetAtTime(
        effective,
        this._context.currentTime,
        GAIN_RAMP,
      );
      if (this._element) {
        this._element.volume = 1;
        this._element.muted = false;
      }
      return;
    }
    if (this._element) {
      this._element.volume = this._volume;
      this._element.muted = this._muted;
    }
  }

  private async _applySinkId(
    element: HTMLAudioElement,
    deviceId: string,
  ): Promise<void> {
    const sinkable = element as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (typeof sinkable.setSinkId !== "function") {
      return;
    }
    try {
      await sinkable.setSinkId(deviceId);
    } catch (error) {
      this._callbacks.onWarning?.(
        `Unable to send preview audio to the selected monitor device: ${
          (error as Error).message
        }`,
      );
    }
  }

  private _teardownElement(): void {
    this._stopProgressTimer();
    const element = this._element;
    this._element = undefined;
    if (this._sourceNode) {
      this._sourceNode.disconnect();
      this._sourceNode = undefined;
    }
    this._routable = false;
    if (!element) {
      return;
    }
    element.removeEventListener("loadedmetadata", this._handleLoadedMetadata);
    element.removeEventListener("canplay", this._handleCanPlay);
    element.removeEventListener("play", this._handlePlay);
    element.removeEventListener("pause", this._handlePause);
    element.removeEventListener("ended", this._handleEnded);
    element.removeEventListener("seeked", this._handleSeeked);
    element.removeEventListener("error", this._handleError);
    element.pause();
    element.removeAttribute("src");
    element.load();
  }

  private _startProgressTimer(): void {
    if (this._progressTimer !== null) {
      return;
    }
    this._progressTimer = setInterval(() => {
      if (!this._isPlaying()) {
        this._stopProgressTimer();
        return;
      }
      this._emitState();
    }, PROGRESS_INTERVAL_MS);
  }

  private _stopProgressTimer(): void {
    if (this._progressTimer !== null) {
      clearInterval(this._progressTimer);
      this._progressTimer = null;
    }
  }

  private _isPlaying(): boolean {
    return Boolean(
      this._element && !this._element.paused && !this._element.ended,
    );
  }

  private _setPlaying(playing: boolean): void {
    if (playing === this._lastReportedPlaying) {
      return;
    }
    this._lastReportedPlaying = playing;
    this._callbacks.onPlayingChange(playing);
  }

  private _safeDuration(element?: HTMLAudioElement): number {
    if (!element) {
      return 0;
    }
    const duration = element.duration;
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  }

  private _measurePeakLevel(): number {
    if (!this._isPlaying()) {
      return 0;
    }
    if (!this._routable || !this._analyser || !this._analyserData) {
      return this._muted ? 0 : this._volume;
    }
    this._analyser.getFloatTimeDomainData(this._analyserData);
    let peak = 0;
    for (let i = 0; i < this._analyserData.length; i++) {
      const sample = Math.abs(this._analyserData[i]);
      if (sample > peak) {
        peak = sample;
      }
    }
    return Math.min(peak, 1);
  }

  private _emitState(error?: string): void {
    const element = this._element;
    const playing = this._isPlaying();
    const duration = this._safeDuration(element);
    const rawProgress =
      this._pendingSeek ?? (element ? element.currentTime : 0);
    const progress =
      Number.isFinite(rawProgress) && rawProgress >= 0 ? rawProgress : 0;
    this._callbacks.onState({
      requestId: this._requestId,
      loading: this._loading,
      playing,
      progress: duration > 0 ? Math.min(progress, duration) : progress,
      duration,
      ended: this._ended,
      level: this._measurePeakLevel(),
      ...(error ? { error } : {}),
    });
  }

  private _handleLoadedMetadata = (): void => {
    const element = this._element;
    if (!element) {
      return;
    }
    if (this._pendingSeek !== null) {
      const target = this._pendingSeek;
      this._pendingSeek = null;
      const duration = this._safeDuration(element);
      element.currentTime =
        duration > 0 ? Math.min(target, duration) : target;
    }
    this._emitState();
  };

  private _handleCanPlay = (): void => {
    this._loading = false;
    this._emitState();
  };

  private _handlePlay = (): void => {
    this._loading = false;
    this._ended = false;
    this._setPlaying(true);
    this._startProgressTimer();
    this._emitState();
  };

  private _handlePause = (): void => {
    if (this._element?.ended) {
      return;
    }
    this._stopProgressTimer();
    this._setPlaying(false);
    this._emitState();
  };

  private _handleEnded = (): void => {
    this._stopProgressTimer();
    this._loading = false;
    this._ended = true;
    this._setPlaying(false);
    if (this._element) {
      this._element.currentTime = 0;
    }
    this._emitState();
  };

  private _handleSeeked = (): void => {
    this._emitState();
  };

  private _handleError = (): void => {
    this._stopProgressTimer();
    this._loading = false;
    this._setPlaying(false);
    this._emitState("Unable to load preview audio");
  };
}
