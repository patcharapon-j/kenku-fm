import { ipcRenderer } from "electron";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import PCMStream from "./PCMStream.worklet";

/** Sample rate of the audio context */
const SAMPLE_RATE = 48000;
/** Number of channels for the audio context */
const NUM_CHANNELS = 2;
/** 20ms Opus frame duration */
const FRAME_DURATION = 20;
/** Duration of each audio frame in seconds */
const FRAME_DURATION_SECONDS = FRAME_DURATION / 1000;
/**
 * Number of samples **per channel** in each Opus frame
 * This is the unit the encoder's `frameSize` is given in, so at 48KHz with a
 * frame duration of 20ms (or 0.02s) it is:
 * `SAMPLE_RATE * FRAME_DURATION_SECONDS`
 * or:
 * `48000 * 0.02 = 960`
 */
const OPUS_FRAME_SIZE = SAMPLE_RATE * FRAME_DURATION_SECONDS;
/**
 * Number of 16bit elements in one millisecond of audio
 * The worklet's ring buffer is sized in Int16 elements and holds both channels
 * interleaved, so a millisecond of audio is:
 * `SAMPLE_RATE * NUM_CHANNELS / 1000`
 * or:
 * `48000 * 2 / 1000 = 96`
 * Note that this is a different unit to `OPUS_FRAME_SIZE`, which counts the
 * samples of a single channel. One 20ms frame is 1920 interleaved elements
 */
const ELEMENTS_PER_MILLISECOND = (SAMPLE_RATE * NUM_CHANNELS) / 1000;
/** Duration in ms of the worklet's ring buffer in the `performance` streaming mode */
const PERFORMANCE_BUFFER_DURATION = 500;
/** Duration in ms of the worklet's ring buffer in the `lowLatency` streaming mode */
const LOW_LATENCY_BUFFER_DURATION = 10;
/**
 * Maximum duration in ms of audio that may be in flight to the main process
 * The port carries no measure of how much data is waiting on it, so the main
 * process reports what it has handled and anything beyond this bound is
 * dropped. This is a realtime stream: it can never catch up by buffering, so
 * letting the backlog grow would just add to the delay for the rest of the
 * session
 */
const MAX_IN_FLIGHT_DURATION = 500;
/** Minimum time in ms between reports of dropped audio */
const DROP_REPORT_INTERVAL = 5000;

/**
 * Manager to capture audio from browser views and external audio devices
 * This class is to be run on the renderer thread
 * For the main thread counterpart see `AudioCaptureManagerMain.ts`
 */
export class AudioCaptureManagerPreload {
  /** Audio context to mix media streams into one audio output */
  _audioContext?: AudioContext;
  /** Audio output node that streams will connect to */
  _audioOutputNode?: AudioNode;
  /**
   * Limiter on the master bus that everything leaving this window passes
   * through. See `_createLimiter`
   */
  _limiterNode?: DynamicsCompressorNode;

  /** Audio DOM element for the current output / local playback */
  _audioOutputElement?: HTMLAudioElement;
  /** Raw media streams for each browser view containing webp/opus audio */
  _mediaStreams: Record<number, MediaStream> = {};
  _mediaStreamOutputs: Record<number, GainNode> = {};

  /** Raw media stream for each external audio source e.g. microphone or virtual audio cables */
  _externalAudioStreams: Record<string, MediaStream> = {};
  _externalAudioStreamOutputs: Record<string, GainNode> = {};

  /** Port that PCM data is sent to the main process over */
  _pcmPort?: MessagePort;
  /** Number of blocks of PCM data posted to the port */
  _sentBlocks = 0;
  /** Number of blocks of PCM data the main process has reported handling */
  _handledBlocks = 0;
  /**
   * Maximum number of blocks that may be in flight before audio is dropped
   * This is derived from `MAX_IN_FLIGHT_DURATION` when the capture starts as
   * each block holds one streaming mode's buffer worth of audio
   */
  _maxBlocksInFlight = 1;
  /** The newest block of PCM data, held back while the main process catches up */
  _pendingBlock?: Int16Array;
  /** Number of blocks of PCM data dropped since the last report */
  _droppedBlocks = 0;
  /** Time in ms that dropped audio was last reported */
  _lastDropReport = 0;

  /**
   * Create the Audio Context, setup the communication port and start the
   * internal PCM stream for communicating between the renderer and main context
   */
  async start(streamingMode: "lowLatency" | "performance"): Promise<void> {
    // The main context starts the capture each time this window loads, so a
    // start that arrives while one is already running is ignored: a second
    // audio graph in this window would feed the broadcast everything twice
    if (this._audioContext) {
      return;
    }
    this._audioContext = new AudioContext({
      // Setting the latency hint to `playback` fixes audio glitches on some Windows 11 machines.
      latencyHint: "playback",
      sampleRate: SAMPLE_RATE,
    });
    this._audioOutputNode = this._audioContext.createGain();
    this._limiterNode = this._createLimiter();
    // Everything that leaves this window goes through the limiter, so both the
    // PCM stream and the local loopback hear the same thing
    this._audioOutputNode.connect(this._limiterNode);

    // The port has to be live before the main context is told to expect audio,
    // otherwise the first blocks the worklet produces have nowhere to go
    await this._setupMessagePort();
    await this._setupLoopback();

    ipcRenderer.send(
      "AUDIO_CAPTURE_STREAM_START",
      NUM_CHANNELS,
      OPUS_FRAME_SIZE,
      SAMPLE_RATE
    );

    const bufferDuration =
      streamingMode === "performance"
        ? PERFORMANCE_BUFFER_DURATION
        : LOW_LATENCY_BUFFER_DURATION;
    // The worklet posts one buffer at a time, so the bound on how much audio
    // may be in flight is that duration expressed as a number of blocks
    // At least two are always allowed so that a mode with a long buffer isn't
    // dropping audio the moment a single block is late
    this._maxBlocksInFlight = Math.max(
      2,
      Math.floor(MAX_IN_FLIGHT_DURATION / bufferDuration)
    );

    // Create PCM stream node
    await this._audioContext.audioWorklet.addModule(PCMStream);
    const pcmStreamNode = new AudioWorkletNode(
      this._audioContext,
      "pcm-stream",
      {
        parameterData: {
          // The buffer is measured in interleaved 16bit elements, so its size
          // is the duration we want multiplied by the elements per millisecond
          bufferSize: ELEMENTS_PER_MILLISECOND * bufferDuration,
        },
      }
    );
    pcmStreamNode.port.onmessage = (event) => {
      this._sendPCMData(event.data);
    };

    // Pipe the audio output into the stream
    this._limiterNode.connect(pcmStreamNode);
  }

  /**
   * Create the master bus limiter
   * Every source connects into the master gain at unity and the worklet then
   * hard clamps to +/-1, so two loud sources playing at once clip. A compressor
   * with a high ratio and a fast attack catches those peaks before the clamp
   * ever sees them
   */
  _createLimiter(): DynamicsCompressorNode {
    const limiter = this._audioContext.createDynamicsCompressor();
    // Sit just below 0dBFS so the limiter only acts on material that would
    // otherwise clip and leaves everything quieter than that untouched
    limiter.threshold.value = -1;
    // No soft knee, we want a ceiling rather than a gradual compression that
    // would colour audio that was never going to clip
    limiter.knee.value = 0;
    // The highest ratio the node accepts, which is what makes this a limiter
    // rather than a compressor
    limiter.ratio.value = 20;
    // The fastest attack the node accepts so that a transient such as a
    // soundboard hit is caught rather than let through
    limiter.attack.value = 0;
    // Long enough to avoid audible pumping on music, short enough that the
    // level recovers before the next phrase
    limiter.release.value = 0.25;
    return limiter;
  }

  setMuted(id: number, muted: boolean): void {
    // Mute the audio context node
    // Note: we can't use `webContents.setAudioMuted()` as we are capturing a
    // separate audio stream then what is being sent to the user
    if (this._mediaStreamOutputs[id]) {
      this._mediaStreamOutputs[id].gain.value = muted ? 0 : 1;
    }
  }

  /**
   * Toggle the playback of the view audio in the current window
   * @param {boolean} loopback
   */
  setLoopback(loopback: boolean): void {
    this._audioOutputElement.muted = !loopback;
  }

  async startExternalAudioCapture(deviceId: string): Promise<void> {
    try {
      const streamConfig: MediaStreamConstraints = {
        audio: {
          deviceId: deviceId,
          noiseSuppression: false,
          autoGainControl: false,
          echoCancellation: false,
        },
        video: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(streamConfig);

      this._externalAudioStreams[deviceId] = stream;

      const output = this._audioContext.createGain();
      this._externalAudioStreamOutputs[deviceId] = output;

      const audioSource = this._audioContext.createMediaStreamSource(stream);
      audioSource.connect(output);

      output.connect(this._audioOutputNode);
    } catch (error) {
      console.error(
        `Unable to start stream for external audio device ${deviceId}`
      );
      console.error(error);
    }
  }

  stopExternalAudioCapture(deviceId: string): void {
    const stream = this._externalAudioStreams[deviceId];
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      delete this._externalAudioStreams[deviceId];
    }
    const output = this._externalAudioStreamOutputs[deviceId];
    if (output) {
      // Without this the node stays connected to the master bus for the life of
      // the session
      output.disconnect();
      delete this._externalAudioStreamOutputs[deviceId];
    }
  }

  /**
   * Ask the main context for a `MessagePort` to send PCM data over
   * This window can be reloaded, so a port is asked for each time the capture
   * starts rather than assuming the first one is still live
   */
  async _setupMessagePort(): Promise<void> {
    this._closeMessagePort();

    const port = await new Promise<MessagePort>((resolve) => {
      ipcRenderer.once("AUDIO_CAPTURE_PORT", (event) => {
        // Electron types the transferred ports as `MessagePortMain` even though
        // they arrive in a renderer as native DOM `MessagePort` objects
        resolve(event.ports[0] as unknown as MessagePort);
      });
      ipcRenderer.send("AUDIO_CAPTURE_REQUEST_PORT");
    });

    port.addEventListener("message", (event: MessageEvent) => {
      // The main context reports the running total of blocks it has handled,
      // which is what tells us how much audio is still in flight
      this._handledBlocks = event.data;
      this._flushPendingBlock();
    });
    port.addEventListener("close", () => {
      // A close from a port that has since been replaced is just this window
      // moving on, it doesn't mean the current stream is broken
      if (this._pcmPort !== port) {
        return;
      }
      this._pcmPort = undefined;
      // Note: `ipcRenderer.emit` would only emit on this window's own emitter,
      // so the error has to be sent to the main context to be reported
      ipcRenderer.send(
        "AUDIO_CAPTURE_STREAM_ERROR",
        "Audio stream port was closed by the main context"
      );
    });
    // Queued messages are only delivered once the port is started, so the
    // counters that bound how much audio may be in flight are cleared first
    this._sentBlocks = 0;
    this._handledBlocks = 0;
    this._pendingBlock = undefined;
    this._droppedBlocks = 0;
    this._pcmPort = port;
    port.start();
  }

  /** Close the PCM message port, if one is open */
  _closeMessagePort(): void {
    if (this._pcmPort) {
      const port = this._pcmPort;
      this._pcmPort = undefined;
      port.close();
    }
  }

  /**
   * Hand a block of PCM data from the worklet to the main context
   * Only the newest block is ever held back: this is a realtime stream so when
   * the main context is behind the older audio is dropped rather than queued,
   * which would add to the delay for the rest of the session
   */
  _sendPCMData(data: Int16Array): void {
    if (this._pendingBlock) {
      this._droppedBlocks++;
      this._reportDroppedBlocks();
    }
    this._pendingBlock = data;
    this._flushPendingBlock();
  }

  /** Post the block waiting to be sent, if the main context has room for it */
  _flushPendingBlock(): void {
    const port = this._pcmPort;
    const data = this._pendingBlock;
    if (!port || !data) {
      return;
    }
    if (this._sentBlocks - this._handledBlocks >= this._maxBlocksInFlight) {
      return;
    }
    this._pendingBlock = undefined;
    this._sentBlocks++;
    port.postMessage(data);
  }

  /**
   * Report the audio dropped so far, at most once every
   * `DROP_REPORT_INTERVAL` so that a sustained stall can't spam the console
   */
  _reportDroppedBlocks(): void {
    const now = Date.now();
    if (now - this._lastDropReport < DROP_REPORT_INTERVAL) {
      return;
    }
    this._lastDropReport = now;
    console.warn(
      `Dropped ${this._droppedBlocks} blocks of audio, the main context is not keeping up`
    );
    this._droppedBlocks = 0;
  }

  async _setupLoopback(): Promise<void> {
    // Create loopback media element
    const mediaDestination = this._audioContext.createMediaStreamDestination();
    this._limiterNode.connect(mediaDestination);

    this._audioOutputElement = document.createElement("audio");
    this._audioOutputElement.srcObject = mediaDestination.stream;
    this._audioOutputElement.onloadedmetadata = () => {
      this._audioOutputElement.play();
    };
  }

  /**
   * Start an audio capture for the given browser view
   * @param viewId Browser view id
   * @param mediaSourceId The media source id to use with `getUserMedia`
   */
  async startBrowserViewStream(
    viewId: number,
    mediaSourceId: string
  ): Promise<void> {
    try {
      const streamConfig = {
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: mediaSourceId,
          },
        },
        video: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(
        // Reason
        // We use custom chromium MediaStreamConfig values here to capture the tabs audio
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        streamConfig as any
      );
      this._mediaStreams[viewId] = stream;

      const output = this._audioContext.createGain();
      this._mediaStreamOutputs[viewId] = output;

      const audioSource = this._audioContext.createMediaStreamSource(stream);
      audioSource.connect(output);

      output.connect(this._audioOutputNode);
    } catch (error) {
      console.error(`Unable to start stream for web view ${viewId}`);
      console.error(error);
    }
  }

  /**
   * Stop an audio capture for the given browser view
   * @param viewId Browser view id
   */
  stopBrowserViewStream(viewId: number): void {
    if (this._mediaStreams[viewId]) {
      for (const track of this._mediaStreams[viewId].getTracks()) {
        track.stop();
      }
      delete this._mediaStreams[viewId];
    }
    const output = this._mediaStreamOutputs[viewId];
    if (output) {
      // Without this the node stays connected to the master bus for the life of
      // the session
      output.disconnect();
      delete this._mediaStreamOutputs[viewId];
    }
  }

  /** Stop the audio capture for every browser view */
  stopAllBrowserViewStreams(): void {
    for (const viewId of Object.keys(this._mediaStreams)) {
      this.stopBrowserViewStream(Number(viewId));
    }
    // Catch any output left behind by a capture that never got a media stream
    for (const viewId of Object.keys(this._mediaStreamOutputs)) {
      this.stopBrowserViewStream(Number(viewId));
    }
  }
}
