import {
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  webContents,
} from "electron";
import { TypedEmitter } from "tiny-typed-emitter";
import { Readable } from "stream";
import prism from "prism-media";

declare const AUDIO_CAPTURE_WINDOW_WEBPACK_ENTRY: string;
declare const AUDIO_CAPTURE_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

/** How the audio leaving the capture window is encoded */
type Encoding = "opus" | "pcm";

/** Which Opus implementation the broadcast is actually running on */
export type EncoderInfo = {
  encoding: "opus-webcodecs" | "opus-native" | "opus-js";
  detail: string;
};

/** Master bus levels, used to drive a meter */
export type AudioLevels = {
  peakLeft: number;
  peakRight: number;
  clipped: boolean;
  /** Limiter gain reduction in dB, negative, 0 when the limiter is idle */
  reduction: number;
};

type StreamStartOptions = {
  channels: number;
  frameSize: number;
  sampleRate: number;
  encoding: Encoding;
};

interface AudioCaptureManagerEvents {
  streamStart: (stream: Readable) => void;
  streamEnd: () => void;
  encoderError: (error: Error) => void;
  captureError: (error: Error) => void;
  encoderInfo: (info: EncoderInfo) => void;
  levels: (levels: AudioLevels) => void;
  warning: (message: string) => void;
}

/**
 * libopus encoder CTL requests, applied directly as `prism` either clamps them
 * or doesn't expose them at all
 */
const OPUS_SET_APPLICATION = 4000;
const OPUS_SET_BITRATE = 4002;
const OPUS_SET_MAX_BANDWIDTH = 4004;
const OPUS_SET_VBR = 4006;
const OPUS_SET_COMPLEXITY = 4010;
const OPUS_SET_INBAND_FEC = 4012;
const OPUS_SET_PACKET_LOSS_PERC = 4014;
const OPUS_SET_VBR_CONSTRAINT = 4020;
const OPUS_SET_SIGNAL = 4024;
/** Tuned for general audio rather than speech */
const OPUS_APPLICATION_AUDIO = 2049;
/** Stops the encoder guessing whether it is being given speech */
const OPUS_SIGNAL_MUSIC = 3002;
/** Keeps the full 20KHz of bandwidth rather than narrowing at lower bitrates */
const OPUS_BANDWIDTH_FULLBAND = 1105;
/** The highest quality the encoder offers, at a small cost in CPU */
const OPUS_COMPLEXITY = 10;
/** The bitrate range libopus itself accepts, in bits per second */
const MIN_BITRATE = 500;
const MAX_BITRATE = 512000;
/**
 * Maximum duration in ms of PCM data to hold while the encoder is draining
 * This is a realtime stream so it can never catch up by buffering: once the
 * encoder is behind, the oldest audio is dropped to make room for the newest
 */
const MAX_PENDING_DURATION = 100;
/**
 * Most Opus packets that may sit unread before they are dropped
 * Each packet is a self contained 20ms frame, so a decoder conceals a dropped
 * one, where letting them pile up would delay everything after them
 */
const MAX_PENDING_PACKETS = 10;
/**
 * Length in ms of the ramp applied to the first block sent after audio was
 * dropped, so that resuming part way into a waveform isn't heard as a click
 */
const RESUME_RAMP = 2;
/** Minimum time in ms between reports of dropped audio */
const DROP_REPORT_INTERVAL = 5000;
/**
 * Maximum number of times the capture window is reloaded after its process has
 * gone, so that a window that crashes on load can't be reloaded forever
 */
const MAX_CAPTURE_WINDOW_RELOADS = 3;

/**
 * Convert a block of PCM data that arrived over the message port into a
 * `Buffer` for the encoder
 * The block crosses the port as a typed array, so this wraps the memory it
 * already owns rather than copying it
 */
function toPCMBuffer(data: unknown): Buffer | undefined {
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  return undefined;
}

/**
 * Stream of Opus packets encoded by the capture window
 * Stands in for the encoder in the pipeline when the audio arrives already
 * encoded, so that the broadcast is handed the same kind of stream either way
 */
class OpusPacketStream extends Readable {
  constructor() {
    // The voice connection reads one packet at a time, so the packets have to
    // stay whole rather than being run together into a byte stream
    super({ objectMode: true, read: () => undefined });
  }

  /**
   * Add a packet, dropping it when nothing is reading
   * Returns whether the packet was kept
   */
  addPacket(packet: Buffer): boolean {
    if (this.readableLength >= MAX_PENDING_PACKETS) {
      return false;
    }
    this.push(packet);
    return true;
  }
}

/**
 * Manager to capture audio from browser views and external audio devices
 * This class is to be run on the main thread
 * For the render thread counterpart see `AudioCaptureManagerPreload.ts`
 */
export class AudioCaptureManagerMain extends TypedEmitter<AudioCaptureManagerEvents> {
  _browserWindow: BrowserWindow;
  /** Encoder for audio that arrives as PCM and has to be encoded here */
  _encoder?: prism.opus.Encoder;
  /** Stream of packets for audio that the capture window encoded itself */
  _packetStream?: OpusPacketStream;
  /**
   * The end of the PCM message channel that this process holds, if one is open
   * The capture window can be reloaded, so a fresh channel is created each time
   * the window asks for one rather than assuming the first is still live
   */
  _pcmPort?: Electron.MessagePortMain;
  /** Number of blocks of PCM data received over the current port */
  _receivedBlocks = 0;
  /**
   * The bitrate to encode at, if one has been set
   * This is kept so that it can be reapplied to any encoder created after this
   * point as a new encoder is made each time the capture is restarted
   */
  _bitrate?: number;
  /** Blocks of PCM data waiting for the encoder to ask for more */
  _pendingData: Buffer[] = [];
  /** Total number of bytes of PCM data held in `_pendingData` */
  _pendingBytes = 0;
  /**
   * Number of bytes of PCM data in one millisecond of audio for the current
   * encoder, which is what turns the duration bound above into a size
   */
  _bytesPerMillisecond = 0;
  /** Number of channels the current stream carries */
  _channels = 2;
  /** Sample rate of the current stream */
  _sampleRate = 48000;
  /** The encoder we are waiting on a `drain` from, if any */
  _drainingEncoder?: prism.opus.Encoder;
  /** Number of blocks of audio dropped since the last report */
  _droppedBlocks = 0;
  /** Time in ms that dropped audio was last reported */
  _lastDropReport = 0;
  /** Whether the next block sent follows dropped audio and has to be ramped in */
  _resumeRamp = false;
  /**
   * The streaming mode the capture was last started with, if it has been
   * started
   * The capture window is only told to start once per main window load, so this
   * is what lets a window that has been reloaded be started again
   */
  _streamingMode?: string;
  /** Number of times the capture window has been reloaded after it has crashed */
  _captureWindowReloads = 0;

  constructor() {
    super();
    this._browserWindow = new BrowserWindow({
      webPreferences: {
        preload: AUDIO_CAPTURE_WINDOW_PRELOAD_WEBPACK_ENTRY,
        // Disable sandbox for the audio capture window
        // This allows us to use a web worker in the preload script
        // https://github.com/electron/forge/issues/2931
        // This has little security concerns as we don't load any third party
        // content in the capture window
        sandbox: false,
        // This window is never shown, so Chromium would otherwise treat it as a
        // background page and throttle the work that feeds the broadcast
        backgroundThrottling: false,
      },
      minimizable: false,
      frame: false,
      show: false
    });
    this._browserWindow.webContents.loadURL(AUDIO_CAPTURE_WINDOW_WEBPACK_ENTRY);
    // The capture window holds the whole audio graph, so it has to be started
    // again whenever it is loaded again rather than only on the first load
    this._browserWindow.webContents.on(
      "did-finish-load",
      this._handleCaptureWindowLoad
    );
    this._browserWindow.webContents.on(
      "render-process-gone",
      this._handleCaptureWindowGone
    );

    ipcMain.on("AUDIO_CAPTURE_START", this._handleStart);
    ipcMain.on("AUDIO_CAPTURE_SET_LOOPBACK", this._handleSetLoopback);
    ipcMain.on("AUDIO_CAPTURE_SET_MUTED", this._handleSetMuted);
    ipcMain.on("AUDIO_CAPTURE_SET_VIEW_GAIN", this._handleSetViewGain);
    ipcMain.on("AUDIO_CAPTURE_SET_EXTERNAL_GAIN", this._handleSetExternalGain);
    ipcMain.on("AUDIO_CAPTURE_SET_MONITOR_GAIN", this._handleSetMonitorGain);
    ipcMain.on(
      "AUDIO_CAPTURE_SET_MONITOR_DEVICE",
      this._handleSetMonitorDevice
    );
    ipcMain.on(
      "AUDIO_CAPTURE_START_EXTERNAL_AUDIO_CAPTURE",
      this._handleStartExternalAudioCapture
    );
    ipcMain.on(
      "AUDIO_CAPTURE_STOP_EXTERNAL_AUDIO_CAPTURE",
      this._handleStopExternalAudioCapture
    );
    ipcMain.on("AUDIO_CAPTURE_STREAM_START", this._handleStreamStart);
    ipcMain.on("AUDIO_CAPTURE_STREAM_END", this._handleStreamEnd);
    ipcMain.on("AUDIO_CAPTURE_STREAM_ERROR", this._handleStreamError);
    ipcMain.on("AUDIO_CAPTURE_LEVELS", this._handleLevels);
    ipcMain.on("AUDIO_CAPTURE_WARNING", this._handleWarning);
    ipcMain.on("AUDIO_CAPTURE_REQUEST_PORT", this._handleRequestPort);
    ipcMain.on(
      "AUDIO_CAPTURE_START_BROWSER_VIEW_STREAM",
      this._handleStartBrowserViewStream
    );
    ipcMain.on(
      "AUDIO_CAPTURE_STOP_BROWSER_VIEW_STREAM",
      this._handleStopBrowserViewStream
    );
    ipcMain.on(
      "AUDIO_CAPTURE_STOP_ALL_BROWSER_VIEW_STREAMS",
      this._handleStopAllBrowserViewStreams
    );
  }

  destroy() {
    ipcMain.off("AUDIO_CAPTURE_START", this._handleStart);
    ipcMain.off("AUDIO_CAPTURE_SET_LOOPBACK", this._handleSetLoopback);
    ipcMain.off("AUDIO_CAPTURE_SET_MUTED", this._handleSetMuted);
    ipcMain.off("AUDIO_CAPTURE_SET_VIEW_GAIN", this._handleSetViewGain);
    ipcMain.off("AUDIO_CAPTURE_SET_EXTERNAL_GAIN", this._handleSetExternalGain);
    ipcMain.off("AUDIO_CAPTURE_SET_MONITOR_GAIN", this._handleSetMonitorGain);
    ipcMain.off(
      "AUDIO_CAPTURE_SET_MONITOR_DEVICE",
      this._handleSetMonitorDevice
    );
    ipcMain.off(
      "AUDIO_CAPTURE_START_EXTERNAL_AUDIO_CAPTURE",
      this._handleStartExternalAudioCapture
    );
    ipcMain.off(
      "AUDIO_CAPTURE_STOP_EXTERNAL_AUDIO_CAPTURE",
      this._handleStopExternalAudioCapture
    );
    ipcMain.off("AUDIO_CAPTURE_STREAM_START", this._handleStreamStart);
    ipcMain.off("AUDIO_CAPTURE_STREAM_END", this._handleStreamEnd);
    ipcMain.off("AUDIO_CAPTURE_STREAM_ERROR", this._handleStreamError);
    ipcMain.off("AUDIO_CAPTURE_LEVELS", this._handleLevels);
    ipcMain.off("AUDIO_CAPTURE_WARNING", this._handleWarning);
    ipcMain.off("AUDIO_CAPTURE_REQUEST_PORT", this._handleRequestPort);
    ipcMain.off(
      "AUDIO_CAPTURE_START_BROWSER_VIEW_STREAM",
      this._handleStartBrowserViewStream
    );
    ipcMain.off(
      "AUDIO_CAPTURE_STOP_BROWSER_VIEW_STREAM",
      this._handleStopBrowserViewStream
    );
    ipcMain.off(
      "AUDIO_CAPTURE_STOP_ALL_BROWSER_VIEW_STREAMS",
      this._handleStopAllBrowserViewStreams
    );
    this._browserWindow.webContents.close();
    (this._browserWindow.webContents as any).destroy();
    this._handleStreamEnd();
    this._closePCMPort();
  }

  /**
   * Set the bitrate of the opus encoder
   * This is used to match the bitrate of the Discord voice channel that we're
   * broadcasting to
   * @param bitrate The bitrate in bits per second e.g. 64000
   */
  setBitrate(bitrate?: number): void {
    this._bitrate = bitrate;
    this._applyBitrate(this._encoder);
    // The encoder may live in the capture window, which has no other way of
    // hearing about a channel being joined
    this._browserWindow.webContents.send("AUDIO_CAPTURE_SET_BITRATE", bitrate);
  }

  /**
   * Apply an encoder CTL directly
   * `prism` only exposes a handful of these and clamps the ones it does, so
   * the native handle is used instead where it is available
   */
  _applyCTL(
    encoder: prism.opus.Encoder,
    request: number,
    value: number
  ): boolean {
    try {
      const native = encoder.encoder;
      const ctl = native?.applyEncoderCTL ?? native?.encoderCTL;
      if (typeof ctl !== "function") {
        return false;
      }
      ctl.apply(native, [request, value]);
      return true;
    } catch (error) {
      // Not every Opus implementation supports every CTL, and the encoder
      // frees its native handle when it ends, so this is expected to fail
      return false;
    }
  }

  /** Apply the current bitrate, if any, to the given encoder */
  _applyBitrate(encoder?: prism.opus.Encoder) {
    if (!encoder || this._bitrate === undefined) {
      return;
    }
    // `prism.opus.Encoder.setBitrate` clamps to 16kbps-128kbps, which neither
    // matches a boosted channel nor a channel below 16kbps, so the CTL is
    // applied directly and clamped to the range libopus itself accepts
    const bitrate = Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, this._bitrate));
    if (this._applyCTL(encoder, OPUS_SET_BITRATE, bitrate)) {
      return;
    }
    try {
      encoder.setBitrate(bitrate);
    } catch (error) {
      console.error("Unable to set the audio encoder bitrate", error);
    }
  }

  /**
   * Tune the encoder for the music this app exists to stream
   *
   * The defaults are chosen for an encoder that doesn't know what it is being
   * given. Telling it that it is encoding fullband stereo music stops it
   * narrowing the bandwidth or switching to a speech mode on tonal material.
   *
   * Note what is deliberately not set here: inband forward error correction
   * only exists in the SILK layer, which fullband stereo music at these
   * bitrates never reaches, so enabling it protects nothing. Declaring an
   * expected packet loss on top of that is not free either, as the encoder
   * spends bits on a robustness this stream can't use.
   */
  _applyEncoderQuality(encoder: prism.opus.Encoder) {
    this._applyCTL(encoder, OPUS_SET_APPLICATION, OPUS_APPLICATION_AUDIO);
    this._applyCTL(encoder, OPUS_SET_SIGNAL, OPUS_SIGNAL_MUSIC);
    this._applyCTL(encoder, OPUS_SET_MAX_BANDWIDTH, OPUS_BANDWIDTH_FULLBAND);
    this._applyCTL(encoder, OPUS_SET_COMPLEXITY, OPUS_COMPLEXITY);
    this._applyCTL(encoder, OPUS_SET_INBAND_FEC, 0);
    this._applyCTL(encoder, OPUS_SET_PACKET_LOSS_PERC, 0);
    this._applyCTL(encoder, OPUS_SET_VBR, 1);
    // Variable bitrate, but held to the channel's bitrate over time. Letting
    // it run unconstrained would put peaks above what the voice channel
    // accepts, which is worse than the quality the constraint costs
    this._applyCTL(encoder, OPUS_SET_VBR_CONSTRAINT, 1);
  }

  /**
   * Open a message channel for the capture window's audio and transfer one
   * end of it to that window
   * The audio never leaves the two processes that need it, so unlike the socket
   * this replaces there is nothing for anything else to connect to
   */
  _handleRequestPort = (event: Electron.IpcMainEvent) => {
    // The capture window is the only renderer allowed to feed the broadcast
    if (event.sender !== this._browserWindow.webContents) {
      return;
    }
    // The window may have been reloaded, in which case its old port is dead
    this._closePCMPort();

    const { port1, port2 } = new MessageChannelMain();
    port1.on("message", this._handlePortMessage);
    port1.on("close", () => {
      // A close from a port that has since been replaced says nothing about the
      // current one
      if (this._pcmPort !== port1) {
        return;
      }
      this._pcmPort = undefined;
      // No more audio can arrive over a closed port, so end the stream rather
      // than leave the broadcast starving on an encoder nothing is feeding
      this._handleStreamEnd();
    });
    port1.start();
    this._pcmPort = port1;

    this._browserWindow.webContents.postMessage("AUDIO_CAPTURE_PORT", null, [
      port2,
    ]);
  };

  /**
   * Handle a message from the capture window, which is either a block of PCM
   * data to encode here or a packet the window encoded itself
   */
  _handlePortMessage = (event: Electron.MessageEvent) => {
    const message = event.data as { type?: string; data?: unknown };
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.type === "opus") {
      const packet = toPCMBuffer(message.data);
      if (packet) {
        this._handleOpusPacket(packet);
      }
      return;
    }
    if (message.type !== "pcm") {
      return;
    }
    const data = toPCMBuffer(message.data);
    if (!data) {
      return;
    }
    this._handleStreamData(data);
    // Only PCM is acknowledged: it is the only thing large enough for the
    // capture window to need to know whether this process is keeping up
    this._receivedBlocks++;
    this._pcmPort?.postMessage(this._receivedBlocks);
  };

  _handleOpusPacket = (packet: Buffer) => {
    const stream = this._packetStream;
    if (!stream) {
      return;
    }
    if (!stream.addPacket(packet)) {
      this._recordDrop();
    }
  };

  /** Close the PCM message channel, if one is open */
  _closePCMPort = () => {
    if (this._pcmPort) {
      this._pcmPort.removeAllListeners();
      this._pcmPort.close();
      this._pcmPort = undefined;
    }
    // The capture window counts from zero again for each new port
    this._receivedBlocks = 0;
  };

  _handleStart = (_: Electron.IpcMainEvent, streamingMode: string) => {
    this._streamingMode = streamingMode;
    this._browserWindow.webContents.send("AUDIO_CAPTURE_START", streamingMode);
  };

  /**
   * Start the capture in a window that has just finished loading
   * Nothing else asks the window to start after the main window's first render,
   * so without this a window that has been reloaded would sit idle for the rest
   * of the session
   * The window ignores this if it is already capturing
   */
  _handleCaptureWindowLoad = () => {
    if (this._streamingMode === undefined) {
      return;
    }
    this._browserWindow.webContents.send(
      "AUDIO_CAPTURE_START",
      this._streamingMode
    );
  };

  /**
   * Reload the capture window after its process has gone
   * The window is a separate process, so it can be lost without taking this one
   * with it, in which case no more audio is produced until it is loaded again
   */
  _handleCaptureWindowGone = (
    _: Electron.Event,
    details: Electron.RenderProcessGoneDetails
  ) => {
    if (details.reason === "clean-exit" || this._browserWindow.isDestroyed()) {
      return;
    }
    // Whatever the window was feeding the encoder has stopped, so tear the
    // broadcast down rather than leave it waiting on audio that isn't coming
    this._closePCMPort();
    if (this._captureWindowReloads >= MAX_CAPTURE_WINDOW_RELOADS) {
      // `_handleStreamError` ends the stream as well as reporting it
      this._handleStreamError(
        undefined,
        "The audio capture window stopped and could not be restarted"
      );
      return;
    }
    this._handleStreamEnd();
    this._captureWindowReloads++;
    this._browserWindow.webContents.reload();
  };

  _handleSetLoopback = (_: Electron.IpcMainEvent, loopback: boolean) => {
    this._browserWindow.webContents.send("AUDIO_CAPTURE_SET_LOOPBACK", loopback);
  };

  _handleSetMuted = (
    _: Electron.IpcMainEvent,
    viewId: number,
    muted: boolean
  ) => {
    this._browserWindow.webContents.send(
      "AUDIO_CAPTURE_BROWSER_VIEW_MUTED",
      viewId,
      muted
    );
  };

  _handleSetViewGain = (
    _: Electron.IpcMainEvent,
    viewId: number,
    gain: number
  ) => {
    this._browserWindow.webContents.send(
      "AUDIO_CAPTURE_SET_VIEW_GAIN",
      viewId,
      gain
    );
  };

  _handleSetExternalGain = (
    _: Electron.IpcMainEvent,
    deviceId: string,
    gain: number
  ) => {
    this._browserWindow.webContents.send(
      "AUDIO_CAPTURE_SET_EXTERNAL_GAIN",
      deviceId,
      gain
    );
  };

  _handleSetMonitorGain = (_: Electron.IpcMainEvent, gain: number) => {
    this._browserWindow.webContents.send(
      "AUDIO_CAPTURE_SET_MONITOR_GAIN",
      gain
    );
  };

  _handleSetMonitorDevice = (_: Electron.IpcMainEvent, deviceId: string) => {
    this._browserWindow.webContents.send(
      "AUDIO_CAPTURE_SET_MONITOR_DEVICE",
      deviceId
    );
  };

  _handleStartExternalAudioCapture = (
    _: Electron.IpcMainEvent,
    deviceId: string
  ) => {
    this._browserWindow.webContents.send(
      "AUDIO_CAPTURE_START_EXTERNAL_AUDIO_CAPTURE",
      deviceId
    );
  };

  _handleStopExternalAudioCapture = (
    _: Electron.IpcMainEvent,
    deviceId: string
  ) => {
    this._browserWindow.webContents.send(
      "AUDIO_CAPTURE_STOP_EXTERNAL_AUDIO_CAPTURE",
      deviceId
    );
  };

  _handleLevels = (_: Electron.IpcMainEvent, levels: AudioLevels) => {
    this.emit("levels", levels);
  };

  _handleWarning = (_: Electron.IpcMainEvent, message: string) => {
    this.emit("warning", message);
  };

  _handleStreamStart = (
    _: Electron.IpcMainEvent,
    options: StreamStartOptions
  ) => {
    this._endOutput();
    this._resetPendingData();
    this._channels = options.channels;
    this._sampleRate = options.sampleRate;
    // Each sample of each channel is a 16bit integer
    this._bytesPerMillisecond = (options.channels * 2 * options.sampleRate) / 1000;

    if (options.encoding === "opus") {
      this._startEncodedStream();
      return;
    }
    this._startPCMStream(options);
  };

  /**
   * Take the audio the capture window has already encoded
   * There is no encoder on this side in this case, the packets only have to be
   * handed to the broadcast in the order they arrive
   */
  _startEncodedStream() {
    const stream = new OpusPacketStream();
    this._packetStream = stream;
    this.emit("encoderInfo", {
      encoding: "opus-webcodecs",
      detail: "Encoding in the audio capture window",
    });
    this.emit("streamStart", stream);
  }

  /** Encode the PCM the capture window sends into Opus on this side */
  _startPCMStream(options: StreamStartOptions) {
    // Create a pipeline for converting raw PCM data into opus packets
    const encoder = new prism.opus.Encoder({
      channels: options.channels,
      frameSize: options.frameSize,
      rate: options.sampleRate,
    });
    this._encoder = encoder;

    // A packaged build that is missing the native module silently falls back to
    // the pure JS encoder, which is a real cost rather than a detail, so which
    // one is in use is reported rather than only logged
    const type = prism.opus.Encoder.type;
    this.emit("encoderInfo", {
      encoding: type === "opusscript" ? "opus-js" : "opus-native",
      detail: `Encoding in the main process with ${type}`,
    });

    // `pipe` doesn't forward errors so without a listener here an encoder error
    // would go unhandled and take down the main process
    encoder.on("error", (error) => {
      console.error("Audio encoder error", error);
      // A broken encoder stops producing packets without ending the streams it
      // feeds, which would leave the broadcast silently stuck in `Playing`
      // forever, so the pipeline is torn down deterministically instead.
      // The guard also stops the `end()` below from re-entering this handler.
      if (this._encoder !== encoder) {
        return;
      }
      this._handleStreamEnd();
      this.emit("encoderError", error);
    });

    this._applyEncoderQuality(encoder);
    this._applyBitrate(encoder);

    // Setup any listener streams
    this.emit("streamStart", encoder);
  }

  _handleStreamData = (data: Buffer) => {
    const encoder = this._encoder;
    if (!encoder) {
      return;
    }
    // Once the encoder has told us to back off everything is queued, otherwise
    // this block would overtake the ones already waiting
    if (this._drainingEncoder === encoder) {
      this._queuePendingData(data);
      return;
    }
    this._applyResumeRamp(data);
    if (!encoder.write(data)) {
      this._waitForDrain(encoder);
    }
  };

  /**
   * Add a block of PCM data to the pending queue, dropping the oldest blocks
   * when it is full
   */
  _queuePendingData = (data: Buffer) => {
    this._pendingData.push(data);
    this._pendingBytes += data.byteLength;
    const maxPendingBytes = this._bytesPerMillisecond * MAX_PENDING_DURATION;
    // The newest block is always kept, even when a single block is longer than
    // the bound, otherwise there would be nothing left to send once the encoder
    // has room again
    while (
      this._pendingData.length > 1 &&
      this._pendingBytes > maxPendingBytes
    ) {
      this._pendingBytes -= this._pendingData.shift().byteLength;
      this._recordDrop();
    }
  };

  /** Write the queued PCM data until the encoder asks us to back off again */
  _flushPendingData = () => {
    const encoder = this._encoder;
    if (!encoder) {
      this._pendingData.length = 0;
      this._pendingBytes = 0;
      return;
    }
    while (this._pendingData.length > 0) {
      const data = this._pendingData.shift();
      this._pendingBytes -= data.byteLength;
      this._applyResumeRamp(data);
      if (!encoder.write(data)) {
        this._waitForDrain(encoder);
        return;
      }
    }
  };

  /**
   * Ramp in the start of a block that follows dropped audio
   * The gap itself can't be helped, but resuming part way into a waveform is a
   * step change that is heard as a click on top of it
   */
  _applyResumeRamp = (data: Buffer) => {
    if (!this._resumeRamp) {
      return;
    }
    this._resumeRamp = false;
    const bytesPerFrame = this._channels * 2;
    const frames = Math.floor(data.byteLength / bytesPerFrame);
    const ramp = Math.min(
      frames,
      Math.round((this._sampleRate * RESUME_RAMP) / 1000)
    );
    for (let frame = 0; frame < ramp; frame++) {
      const gain = frame / ramp;
      for (let channel = 0; channel < this._channels; channel++) {
        const offset = frame * bytesPerFrame + channel * 2;
        data.writeInt16LE(
          Math.round(data.readInt16LE(offset) * gain),
          offset
        );
      }
    }
  };

  /** Queue any further data until the given encoder has room again */
  _waitForDrain = (encoder: prism.opus.Encoder) => {
    this._drainingEncoder = encoder;
    encoder.once("drain", () => {
      // A `drain` from an encoder that has since been replaced must not be
      // taken as the current one having room
      if (this._drainingEncoder !== encoder || this._encoder !== encoder) {
        return;
      }
      this._drainingEncoder = undefined;
      this._flushPendingData();
    });
  };

  /** Note that audio was dropped and that the next block has to be ramped in */
  _recordDrop = () => {
    this._droppedBlocks++;
    this._resumeRamp = true;
    this._reportDroppedBlocks();
  };

  /**
   * Report the audio dropped so far, at most once every
   * `DROP_REPORT_INTERVAL` so that a sustained stall can't spam the console
   */
  _reportDroppedBlocks = () => {
    const now = Date.now();
    if (now - this._lastDropReport < DROP_REPORT_INTERVAL) {
      return;
    }
    this._lastDropReport = now;
    console.warn(
      `Dropped ${this._droppedBlocks} blocks of audio, the encoder is not keeping up`
    );
    this._droppedBlocks = 0;
  };

  /** Forget any audio queued for the encoder that is being replaced or ended */
  _resetPendingData = () => {
    this._pendingData.length = 0;
    this._pendingBytes = 0;
    this._drainingEncoder = undefined;
    this._droppedBlocks = 0;
    this._resumeRamp = false;
  };

  /** End whichever kind of stream is currently feeding the broadcast */
  _endOutput = () => {
    this._encoder?.end();
    this._encoder = undefined;
    this._packetStream?.push(null);
    this._packetStream = undefined;
  };

  _handleStreamEnd = () => {
    this._endOutput();
    this._resetPendingData();
    this.emit("streamEnd");
  };

  /**
   * Report an error from the capture window
   * The window can only reach the main context over IPC, so it sends errors
   * here rather than handling them itself
   */
  _handleStreamError = (
    _: Electron.IpcMainEvent | undefined,
    message: string
  ) => {
    console.error("Audio capture error", message);
    // The capture only reports errors it can't carry on from, so stop the
    // broadcast instead of leaving it showing as playing with nothing to play
    this._handleStreamEnd();
    this.emit("captureError", new Error(message));
  };

  _handleStartBrowserViewStream = (
    _: Electron.IpcMainEvent,
    viewId: number
  ) => {
    const contents = webContents.fromId(viewId);
    const mediaSourceId = contents.getMediaSourceId(
      this._browserWindow.webContents
    );
    this._browserWindow.webContents.send(
      "AUDIO_CAPTURE_START_BROWSER_VIEW_STREAM",
      viewId,
      mediaSourceId
    );
  };

  _handleStopBrowserViewStream = (_: Electron.IpcMainEvent, viewId: number) => {
    this._browserWindow.webContents.send(
      "AUDIO_CAPTURE_STOP_BROWSER_VIEW_STREAM",
      viewId
    );
  };

  _handleStopAllBrowserViewStreams = () => {
    this._browserWindow.webContents.send(
      "AUDIO_CAPTURE_STOP_ALL_BROWSER_VIEW_STREAMS"
    );
  };
}
