import { ipcRenderer } from "electron";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import PCMStream from "./PCMStream.worklet";

export type StreamingMode = "lowLatency" | "balanced" | "performance";

/** How the audio leaving this window is encoded before it reaches the broadcast */
export type Encoding = "opus" | "pcm";

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
 * Duration in ms of audio in each block the worklet posts, per streaming mode
 * Every one of these is a whole number of Opus frames so that a block always
 * maps onto complete frames rather than leaving the encoder holding a partial
 * one. This is also the floor on the latency the capture adds, which is why
 * even `performance` is a fraction of the half second it used to be: that
 * buffer was sized for a socket, and the audio now crosses a message port
 */
const BUFFER_DURATIONS: Record<StreamingMode, number> = {
  lowLatency: FRAME_DURATION,
  balanced: FRAME_DURATION * 3,
  performance: FRAME_DURATION * 5,
};
/** Lookahead of the master limiter in ms */
const LIMITER_LOOKAHEAD = 5;
/** Release of the master limiter in ms */
const LIMITER_RELEASE = 200;
/** Ceiling the master limiter holds the mix below, -1dBFS as a sample value */
const LIMITER_CEILING = 0.891;
/**
 * Length in ms of the ramp applied to the first block sent after audio was
 * dropped
 * Resuming part way into a waveform is a step change, which is heard as a
 * click on top of the gap itself
 */
const RESUME_RAMP = 2;
/** Time constant in seconds used when a gain is changed, to avoid a click */
const GAIN_RAMP = 0.015;
/**
 * Loudness the normaliser aims the mix at, in LUFS
 * Around where streaming services land, which is loud enough to sit well in a
 * voice channel without leaving the limiter working constantly
 */
const NORMALIZE_TARGET_LUFS = -16;
/** Most the normaliser may raise or lower the mix by, in dB */
const NORMALIZE_MAX_GAIN_DB = 12;
const NORMALIZE_MIN_GAIN_DB = -12;
/**
 * How fast the normaliser is allowed to move, in dB per second
 * Coming down faster than it goes up is what keeps this a leveller rather than
 * a compressor: something suddenly too loud is dealt with promptly, while a
 * quiet passage is lifted slowly enough not to be heard happening
 */
const NORMALIZE_UP_DB_PER_SECOND = 1;
const NORMALIZE_DOWN_DB_PER_SECOND = 6;
/** Minimum time in ms between level reports, which only drive a meter */
const LEVEL_REPORT_INTERVAL = 66;
/**
 * Most blocks that may be waiting inside the Opus encoder before audio is
 * dropped
 * The encoder runs on its own thread and this is a realtime stream, so a
 * backlog there can only ever be shed, never caught up on
 */
const MAX_ENCODE_QUEUE = 8;
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
 * Bitrate to encode at until a voice channel has been joined and its own
 * bitrate is known, which is the Discord default for a channel that has not
 * been changed
 */
const DEFAULT_BITRATE = 64000;

/**
 * Opus settings that the WebCodecs dictionary in the current type definitions
 * does not cover yet
 * Unknown dictionary members are ignored rather than rejected, so passing
 * these is safe on a runtime that predates them, it just leaves the encoder on
 * its own defaults
 */
type ExtendedOpusConfig = OpusEncoderConfig & {
  /** Tells the encoder to stop guessing whether it is encoding speech */
  signal?: "auto" | "music" | "voice";
  application?: "voip" | "audio" | "lowdelay";
};

/** A block of audio posted by the worklet along with its metering */
type AudioBlock = {
  /** Planar samples, the left channel followed by the right */
  audio: Float32Array;
  peakLeft: number;
  peakRight: number;
  clipped: boolean;
  /** Lowest gain the limiter applied over the block, 1 when it did nothing */
  reduction: number;
  /** Gain the loudness normaliser had in force, 1 when it is off or idle */
  normalization: number;
};

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
   * Master bus processor. Limits the mix, passes the limited signal on for
   * local monitoring and posts it here in blocks to be encoded
   */
  _pcmStreamNode?: AudioWorkletNode;
  /** Gain applied to the local monitoring only, never to the broadcast */
  _monitorGainNode?: GainNode;

  /** Audio DOM element for the current output / local playback */
  _audioOutputElement?: HTMLAudioElement;
  /** Raw media streams for each browser view containing webp/opus audio */
  _mediaStreams: Record<number, MediaStream> = {};
  _mediaStreamOutputs: Record<number, GainNode> = {};
  /** Level set for each browser view, separately from whether it is muted */
  _mediaStreamGains: Record<number, number> = {};
  _mediaStreamMuted: Record<number, boolean> = {};

  /** Raw media stream for each external audio source e.g. microphone or virtual audio cables */
  _externalAudioStreams: Record<string, MediaStream> = {};
  _externalAudioStreamOutputs: Record<string, GainNode> = {};
  /** Level set for each external audio source */
  _externalAudioGains: Record<string, number> = {};

  /** Port that encoded audio or PCM data is sent to the main process over */
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
  /** Number of blocks of audio dropped since the last report */
  _droppedBlocks = 0;
  /** Time in ms that dropped audio was last reported */
  _lastDropReport = 0;
  /** Whether the next block sent follows dropped audio and has to be ramped in */
  _resumeRamp = false;

  /** How the audio leaving this window is currently encoded */
  _encoding: Encoding = "pcm";
  /** The Opus encoder, when the audio is encoded in this window */
  _encoder?: AudioEncoder;
  /** Presentation time in microseconds of the next block handed to the encoder */
  _timestamp = 0;
  /** Bitrate the encoder is configured for */
  _bitrate = DEFAULT_BITRATE;
  /** Samples per channel in each block the worklet posts */
  _framesPerBlock = 0;
  /** Time in ms that levels were last reported */
  _lastLevelReport = 0;
  /**
   * Whether the mix is levelled to a loudness target before it is broadcast
   * Kept here so that it can be handed to a worklet created after this point,
   * as the capture window builds a new one each time it loads
   */
  _normalize = false;
  /** Metering gathered from the blocks since the last report */
  _levelPeakLeft = 0;
  _levelPeakRight = 0;
  _levelClipped = false;
  _levelReduction = 1;
  _levelNormalization = 1;

  /**
   * Create the Audio Context, setup the communication port and start the
   * internal PCM stream for communicating between the renderer and main context
   */
  async start(streamingMode: StreamingMode): Promise<void> {
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

    // A context that didn't get the rate it asked for resamples everything on
    // the way out, which is worth knowing about rather than silently wearing
    if (this._audioContext.sampleRate !== SAMPLE_RATE) {
      this._reportWarning(
        `The audio engine is running at ${this._audioContext.sampleRate}Hz instead of ${SAMPLE_RATE}Hz, which adds a resampling step to everything that is broadcast.`,
      );
    }

    const bufferDuration =
      BUFFER_DURATIONS[streamingMode] ?? BUFFER_DURATIONS.balanced;
    this._framesPerBlock = (SAMPLE_RATE * bufferDuration) / 1000;
    // The worklet posts one buffer at a time, so the bound on how much audio
    // may be in flight is that duration expressed as a number of blocks
    // At least two are always allowed so that a mode with a long buffer isn't
    // dropping audio the moment a single block is late
    this._maxBlocksInFlight = Math.max(
      2,
      Math.floor(MAX_IN_FLIGHT_DURATION / bufferDuration),
    );

    // The port has to be live before the main context is told to expect audio,
    // otherwise the first blocks the worklet produces have nowhere to go
    await this._setupMessagePort();
    // Which side encodes decides what the main context has to build, so it is
    // settled before the main context is told the stream is starting
    this._encoding = await this._setupEncoder();

    ipcRenderer.send("AUDIO_CAPTURE_STREAM_START", {
      channels: NUM_CHANNELS,
      frameSize: OPUS_FRAME_SIZE,
      sampleRate: SAMPLE_RATE,
      encoding: this._encoding,
    });

    await this._audioContext.audioWorklet.addModule(PCMStream);
    this._pcmStreamNode = new AudioWorkletNode(
      this._audioContext,
      "pcm-stream",
      {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [NUM_CHANNELS],
        processorOptions: {
          framesPerBlock: this._framesPerBlock,
          lookahead: Math.round((SAMPLE_RATE * LIMITER_LOOKAHEAD) / 1000),
          releaseSamples: Math.round((SAMPLE_RATE * LIMITER_RELEASE) / 1000),
          ceiling: LIMITER_CEILING,
          normalize: {
            enabled: this._normalize,
            targetLufs: NORMALIZE_TARGET_LUFS,
            maxGainDb: NORMALIZE_MAX_GAIN_DB,
            minGainDb: NORMALIZE_MIN_GAIN_DB,
            upDbPerSecond: NORMALIZE_UP_DB_PER_SECOND,
            downDbPerSecond: NORMALIZE_DOWN_DB_PER_SECOND,
          },
        },
      },
    );
    this._pcmStreamNode.port.onmessage = (event) => {
      this._handleAudioBlock(event.data as AudioBlock);
    };

    await this._setupLoopback();

    // Connected last so that no audio is produced before everything that
    // consumes it is in place
    this._audioOutputNode.connect(this._pcmStreamNode);
  }

  /**
   * Set up the Opus encoder for this window, falling back to sending raw PCM
   * to the main process when this runtime can't encode here
   *
   * Encoding in this window keeps the audio off the main process, which also
   * drives the UI, the remote server and the Discord gateway, and it replaces
   * a continuous 1.5Mbit/s of PCM across the process boundary with the Opus
   * packets themselves
   */
  async _setupEncoder(): Promise<Encoding> {
    this._closeEncoder();
    if (typeof AudioEncoder === "undefined") {
      return "pcm";
    }
    try {
      const config = this._encoderConfig(this._bitrate);
      const support = await AudioEncoder.isConfigSupported(config);
      if (!support.supported) {
        return "pcm";
      }
      const encoder = new AudioEncoder({
        output: (chunk) => this._handleEncodedChunk(chunk),
        error: (error) => this._handleEncoderError(error),
      });
      encoder.configure(config);
      this._encoder = encoder;
      this._timestamp = 0;
      return "opus";
    } catch (error) {
      console.error("Unable to start the Opus encoder in the capture window", error);
      return "pcm";
    }
  }

  _encoderConfig(bitrate: number): AudioEncoderConfig {
    const opus: ExtendedOpusConfig = {
      // Microseconds, and the same 20ms frame the broadcast is built around
      frameDuration: FRAME_DURATION * 1000,
      complexity: 10,
      // Inband forward error correction only exists in the SILK layer, which
      // fullband stereo music at these bitrates never uses, so asking for it
      // buys nothing. Telling the encoder to expect loss is not free either:
      // it spends bits on robustness this stream can't make use of
      useinbandfec: false,
      packetlossperc: 0,
      usedtx: false,
      // Raw packets rather than an Ogg container, which is what the voice
      // connection expects to be handed
      format: "opus",
      signal: "music",
      application: "audio",
    };
    return {
      codec: "opus",
      sampleRate: SAMPLE_RATE,
      numberOfChannels: NUM_CHANNELS,
      bitrate,
      bitrateMode: "variable",
      opus,
    };
  }

  /** Encode at the bitrate of the voice channel that is being broadcast to */
  setBitrate(bitrate?: number): void {
    const next = bitrate ?? DEFAULT_BITRATE;
    if (next === this._bitrate) {
      return;
    }
    this._bitrate = next;
    if (!this._encoder || this._encoding !== "opus") {
      return;
    }
    try {
      this._encoder.configure(this._encoderConfig(next));
    } catch (error) {
      console.error("Unable to change the Opus encoder bitrate", error);
    }
  }

  _handleEncodedChunk(chunk: EncodedAudioChunk): void {
    const port = this._pcmPort;
    if (!port) {
      return;
    }
    const packet = new Uint8Array(chunk.byteLength);
    chunk.copyTo(packet);
    // Deliberately not transferred: a renderer to main port runs the message
    // through the main process' own deserialiser, which has no way to take
    // ownership of a transferred `ArrayBuffer` and hands on `null` in place of
    // the whole message instead. The data crosses a process boundary here, so
    // it is copied into the channel either way and the transfer bought nothing
    port.postMessage({ type: "opus", data: packet });
  }

  /**
   * Fall back to sending PCM when the encoder in this window fails
   * The main process can encode instead, so a broken encoder costs the stream
   * a moment rather than ending it
   */
  _handleEncoderError(error: DOMException | Error): void {
    console.error("Opus encoder error in the capture window", error);
    if (this._encoding !== "opus") {
      return;
    }
    this._closeEncoder();
    this._encoding = "pcm";
    this._pendingBlock = undefined;
    this._resumeRamp = true;
    // The main context builds its pipeline from this, so telling it the stream
    // is starting again is what moves the encoding back to that side
    ipcRenderer.send("AUDIO_CAPTURE_STREAM_START", {
      channels: NUM_CHANNELS,
      frameSize: OPUS_FRAME_SIZE,
      sampleRate: SAMPLE_RATE,
      encoding: "pcm",
    });
  }

  _closeEncoder(): void {
    const encoder = this._encoder;
    this._encoder = undefined;
    if (!encoder) {
      return;
    }
    try {
      if (encoder.state !== "closed") {
        encoder.close();
      }
    } catch (error) {
      console.error("Unable to close the Opus encoder", error);
    }
  }

  /**
   * Handle a block of limited audio from the master bus
   * The block's memory is handed back to the worklet once it has been used so
   * that a steady stream doesn't allocate a buffer per block
   */
  _handleAudioBlock(block: AudioBlock): void {
    const audio = block.audio;
    this._reportLevels(block);
    if (this._encoding === "opus") {
      this._encodeBlock(audio);
    } else {
      this._queuePCM(audio);
    }
    this._returnBlock(audio);
  }

  _encodeBlock(audio: Float32Array): void {
    const encoder = this._encoder;
    if (!encoder || encoder.state !== "configured") {
      return;
    }
    // A backlog inside the encoder is only ever shed: this is a realtime
    // stream, so audio held back to catch up would just add to the delay for
    // the rest of the session
    if (encoder.encodeQueueSize >= MAX_ENCODE_QUEUE) {
      this._recordDrop();
      return;
    }
    this._applyResumeRamp(audio);
    try {
      const data = new AudioData({
        format: "f32-planar",
        sampleRate: SAMPLE_RATE,
        numberOfFrames: this._framesPerBlock,
        numberOfChannels: NUM_CHANNELS,
        timestamp: this._timestamp,
        // The block always spans the whole of its own buffer, and the encoder
        // reads exactly the frames it was told to, so handing it the buffer
        // avoids a view whose backing store can't be proven unshared
        data: audio.buffer as ArrayBuffer,
      });
      this._timestamp += Math.round(
        (this._framesPerBlock * 1e6) / SAMPLE_RATE,
      );
      encoder.encode(data);
      data.close();
    } catch (error) {
      this._handleEncoderError(error as Error);
    }
  }

  /**
   * Convert a block to the 16bit PCM the main process encodes from and hold it
   * for the port
   * Only the newest block is ever held back: this is a realtime stream so when
   * the main context is behind the older audio is dropped rather than queued
   */
  _queuePCM(audio: Float32Array): void {
    if (this._pendingBlock) {
      this._recordDrop();
    }
    this._applyResumeRamp(audio);
    const frames = this._framesPerBlock;
    const pcm = new Int16Array(frames * NUM_CHANNELS);
    // The main process encodes from interleaved samples, so the planar block
    // is woven back together here
    for (let i = 0; i < frames; i++) {
      pcm[i * 2] = floatToInt16(audio[i]);
      pcm[i * 2 + 1] = floatToInt16(audio[frames + i]);
    }
    this._pendingBlock = pcm;
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
    // Not transferred, for the reason given in `_handleEncodedChunk`
    port.postMessage({ type: "pcm", data });
  }

  /** Give the block's memory back to the worklet so that it can be filled again */
  _returnBlock(audio: Float32Array): void {
    const node = this._pcmStreamNode;
    // A block whose memory has already been handed on has nothing left to give
    if (!node || audio.byteLength === 0) {
      return;
    }
    node.port.postMessage(audio.buffer, [audio.buffer]);
  }

  /**
   * Ramp in the start of a block that follows dropped audio
   * The gap itself can't be helped, but resuming part way into a waveform is a
   * step change that is heard as a click on top of it
   */
  _applyResumeRamp(audio: Float32Array): void {
    if (!this._resumeRamp) {
      return;
    }
    this._resumeRamp = false;
    const frames = this._framesPerBlock;
    const ramp = Math.min(
      frames,
      Math.round((SAMPLE_RATE * RESUME_RAMP) / 1000),
    );
    for (let i = 0; i < ramp; i++) {
      const gain = i / ramp;
      audio[i] *= gain;
      audio[frames + i] *= gain;
    }
  }

  /** Note that a block was dropped and that the next one has to be ramped in */
  _recordDrop(): void {
    this._droppedBlocks++;
    this._resumeRamp = true;
    this._reportDroppedBlocks();
  }

  /**
   * Pass the master bus levels on to be metered
   *
   * These only drive a meter, so they are throttled to a rate a display can
   * use. The blocks in between are folded into the next report rather than
   * discarded: a clip lasts a single block, so sampling would be the one way
   * to miss exactly what the meter exists to show
   */
  _reportLevels(block: AudioBlock): void {
    this._levelPeakLeft = Math.max(this._levelPeakLeft, block.peakLeft);
    this._levelPeakRight = Math.max(this._levelPeakRight, block.peakRight);
    this._levelClipped = this._levelClipped || block.clipped;
    this._levelReduction = Math.min(this._levelReduction, block.reduction);
    this._levelNormalization = block.normalization;

    const now = Date.now();
    if (now - this._lastLevelReport < LEVEL_REPORT_INTERVAL) {
      return;
    }
    this._lastLevelReport = now;
    ipcRenderer.send("AUDIO_CAPTURE_LEVELS", {
      peakLeft: this._levelPeakLeft,
      peakRight: this._levelPeakRight,
      clipped: this._levelClipped,
      // The worklet reports the gain it applied, which reads more naturally as
      // the number of dB the limiter took off
      reduction:
        this._levelReduction >= 1 ? 0 : 20 * Math.log10(this._levelReduction),
      // Unlike the others this is the gain in force right now rather than a
      // worst case, as it is a slow moving level rather than something to catch
      normalization:
        this._levelNormalization > 0
          ? 20 * Math.log10(this._levelNormalization)
          : 0,
    });
    this._levelPeakLeft = 0;
    this._levelPeakRight = 0;
    this._levelClipped = false;
    this._levelReduction = 1;
  }

  _reportWarning(message: string): void {
    ipcRenderer.send("AUDIO_CAPTURE_WARNING", message);
  }

  setMuted(id: number, muted: boolean): void {
    // Mute the audio context node
    // Note: we can't use `webContents.setAudioMuted()` as we are capturing a
    // separate audio stream then what is being sent to the user
    this._mediaStreamMuted[id] = muted;
    this._applyViewGain(id);
  }

  /** Set the level a browser view is mixed in at, where 1 is unity */
  setViewGain(id: number, gain: number): void {
    this._mediaStreamGains[id] = gain;
    this._applyViewGain(id);
  }

  _applyViewGain(id: number): void {
    const output = this._mediaStreamOutputs[id];
    if (!output || !this._audioContext) {
      return;
    }
    const gain = this._mediaStreamMuted[id]
      ? 0
      : (this._mediaStreamGains[id] ?? 1);
    this._rampGain(output, gain);
  }

  /** Set the level an external audio source is mixed in at, where 1 is unity */
  setExternalGain(deviceId: string, gain: number): void {
    this._externalAudioGains[deviceId] = gain;
    const output = this._externalAudioStreamOutputs[deviceId];
    if (output) {
      this._rampGain(output, gain);
    }
  }

  /**
   * Turn loudness levelling of the broadcast on or off
   *
   * Sources reach the master bus at whatever level they happen to be: a
   * mastered file, a video in a tab and a soundboard hit have no reason to
   * agree. With this on the mix is measured and moved towards a common
   * loudness, so a listener isn't reaching for their volume between tracks
   */
  setNormalize(enabled: boolean): void {
    this._normalize = enabled;
    // A worklet that hasn't been created yet is given this when it is
    this._pcmStreamNode?.port.postMessage({ type: "normalize", enabled });
  }

  /** Set the level of the local monitoring, which the broadcast never hears */
  setMonitorGain(gain: number): void {
    if (this._monitorGainNode) {
      this._rampGain(this._monitorGainNode, gain);
    }
  }

  /** Send the local monitoring to a specific output device, or the default one */
  async setMonitorDevice(deviceId: string): Promise<void> {
    const element = this._audioOutputElement;
    if (!element) {
      return;
    }
    try {
      await element.setSinkId(deviceId);
    } catch (error) {
      this._reportWarning(
        `Unable to send local audio monitoring to the selected output device: ${
          (error as Error).message
        }`,
      );
    }
  }

  /**
   * Move a gain to a new value over a short ramp
   * Stepping a gain outright is a discontinuity in the waveform, which is
   * heard as a click
   */
  _rampGain(node: GainNode, value: number): void {
    const context = this._audioContext;
    if (!context) {
      node.gain.value = value;
      return;
    }
    node.gain.setTargetAtTime(value, context.currentTime, GAIN_RAMP);
  }

  /**
   * Toggle the playback of the view audio in the current window
   * @param {boolean} loopback
   */
  setLoopback(loopback: boolean): void {
    // The main window restores its settings before the capture has started, so
    // this can arrive before there is anything to monitor
    if (!this._audioOutputElement) {
      return;
    }
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
          // Asking for the rate the mix runs at keeps the resampling in the
          // device where it belongs instead of adding a second one in the graph
          sampleRate: SAMPLE_RATE,
        },
        video: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(streamConfig);

      // As with a browser view, capturing a device that is already being
      // captured would mix it in twice rather than replace it
      this._stopExternalNodes(deviceId);
      this._externalAudioStreams[deviceId] = stream;
      this._reportSampleRate(stream, `Audio input ${deviceId}`);

      const output = this._audioContext.createGain();
      output.gain.value = this._externalAudioGains[deviceId] ?? 1;
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
    this._stopExternalNodes(deviceId);
  }

  _stopExternalNodes(deviceId: string): void {
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
   * Report a source that isn't running at the rate the mix does
   * Everything it sends is resampled on the way in, which is worth telling the
   * user about as it is usually a device setting they can change
   */
  _reportSampleRate(stream: MediaStream, label: string): void {
    const rate = stream.getAudioTracks()[0]?.getSettings().sampleRate;
    // Not every source reports a rate, and one that matches has nothing to say
    if (!rate || !this._audioContext || rate === this._audioContext.sampleRate) {
      return;
    }
    this._reportWarning(
      `${label} is running at ${rate}Hz and is being resampled to ${this._audioContext.sampleRate}Hz. Setting the device to ${this._audioContext.sampleRate}Hz will avoid this.`,
    );
  }

  /**
   * Ask the main context for a `MessagePort` to send audio over
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
      `Dropped ${this._droppedBlocks} blocks of audio, the encoder is not keeping up`
    );
    this._droppedBlocks = 0;
  }

  async _setupLoopback(): Promise<void> {
    // Create loopback media element
    const mediaDestination = this._audioContext.createMediaStreamDestination();
    this._monitorGainNode = this._audioContext.createGain();
    // The monitoring hangs off the master bus processor's output so that it
    // hears exactly what is broadcast, limiter and all
    this._pcmStreamNode.connect(this._monitorGainNode);
    this._monitorGainNode.connect(mediaDestination);

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
      // A view that is already being captured would otherwise be mixed in
      // twice, at double the level, with nothing left holding the first set of
      // nodes to disconnect them
      this._teardownViewStream(viewId);
      this._mediaStreams[viewId] = stream;

      const output = this._audioContext.createGain();
      output.gain.value = this._mediaStreamMuted[viewId]
        ? 0
        : (this._mediaStreamGains[viewId] ?? 1);
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
   * Take down the nodes capturing a browser view, leaving its level alone
   * A view that is being captured again keeps the level it was given, so this
   * is separate from stopping the view for good
   */
  _teardownViewStream(viewId: number): void {
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

  /**
   * Stop an audio capture for the given browser view
   * @param viewId Browser view id
   */
  stopBrowserViewStream(viewId: number): void {
    this._teardownViewStream(viewId);
    // The level follows the view, a new view that reuses the id is a new source
    delete this._mediaStreamGains[viewId];
    delete this._mediaStreamMuted[viewId];
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

/**
 * Convert a 32bit float sample to the 16bit int the main process encodes from
 * The master limiter holds the mix below the ceiling, so the clamp here is a
 * backstop for a sample that reached this point some other way rather than
 * something the mix is expected to hit
 */
function floatToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}
