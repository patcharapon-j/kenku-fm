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

interface AudioCaptureManagerEvents {
  streamStart: (stream: Readable) => void;
  streamEnd: () => void;
  encoderError: (error: Error) => void;
  captureError: (error: Error) => void;
}

/** libopus `OPUS_SET_BITRATE_REQUEST`, applied directly to bypass prism's clamp */
const OPUS_SET_BITRATE = 4002;
/** The bitrate range libopus itself accepts, in bits per second */
const MIN_BITRATE = 500;
const MAX_BITRATE = 512000;
/** Expected packet loss used to size the inband forward error correction */
const EXPECTED_PACKET_LOSS = 0.05;
/**
 * Maximum duration in ms of PCM data to hold while the encoder is draining
 * This is a realtime stream so it can never catch up by buffering: once the
 * encoder is behind, the oldest audio is dropped to make room for the newest
 * The bound is a duration rather than a number of blocks as a block is one of
 * the capture window's buffers, which is 50x longer in the `performance`
 * streaming mode than in `lowLatency`
 */
const MAX_PENDING_DURATION = 100;
/** Minimum time in ms between reports of dropped audio */
const DROP_REPORT_INTERVAL = 5000;
/**
 * Maximum number of times the capture window is reloaded after its process has
 * gone, so that a window that crashes on load can't be reloaded forever
 */
const MAX_CAPTURE_WINDOW_RELOADS = 3;

/** Only report which Opus module was loaded once per process */
let loggedEncoderType = false;

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
 * Manager to capture audio from browser views and external audio devices
 * This class is to be run on the main thread
 * For the render thread counterpart see `AudioCaptureManagerPreload.ts`
 */
export class AudioCaptureManagerMain extends TypedEmitter<AudioCaptureManagerEvents> {
  _browserWindow: BrowserWindow;
  _encoder?: prism.opus.Encoder;
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
  /** The encoder we are waiting on a `drain` from, if any */
  _drainingEncoder?: prism.opus.Encoder;
  /** Number of blocks of PCM data dropped since the last report */
  _droppedBlocks = 0;
  /** Time in ms that dropped audio was last reported */
  _lastDropReport = 0;
  /**
   * The streaming mode the capture was last started with, if it has been
   * started
   * The capture window is only told to start once per main window load, so this
   * is what lets a window that has been reloaded be started again
   */
  _streamingMode?: "lowLatency" | "performance";
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
    try {
      const native = encoder.encoder;
      const ctl = native?.applyEncoderCTL ?? native?.encoderCTL;
      if (typeof ctl === "function") {
        ctl.apply(native, [OPUS_SET_BITRATE, bitrate]);
      } else {
        encoder.setBitrate(bitrate);
      }
    } catch (error) {
      // The encoder frees its native handle when it ends so setting the bitrate
      // on an encoder that has already been cleaned up will throw
      console.error("Unable to set the audio encoder bitrate", error);
    }
  }

  /**
   * Enable inband forward error correction so that the decoder can rebuild a
   * lost packet from the redundant copy carried in the next one
   */
  _applyErrorCorrection(encoder: prism.opus.Encoder) {
    try {
      encoder.setFEC(true);
      encoder.setPLP(EXPECTED_PACKET_LOSS);
    } catch (error) {
      console.error(
        "Unable to enable audio encoder forward error correction",
        error
      );
    }
  }

  /**
   * Open a message channel for the capture window's PCM data and transfer one
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
   * Handle a block of PCM data from the capture window
   * The port has no measure of how much data is waiting on it, so the running
   * total of what has been received is sent back after each block. That is what
   * lets the capture window tell whether this process is keeping up
   */
  _handlePortMessage = (event: Electron.MessageEvent) => {
    const data = toPCMBuffer(event.data);
    if (!data) {
      return;
    }
    this._handleStreamData(data);
    this._receivedBlocks++;
    this._pcmPort?.postMessage(this._receivedBlocks);
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

  _handleStart = (
    _: Electron.IpcMainEvent,
    streamingMode: "lowLatency" | "performance"
  ) => {
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

  _handleStreamStart = (
    _: Electron.IpcMainEvent,
    channels: number,
    frameSize: number,
    sampleRate: number
  ) => {
    this._encoder?.end();
    this._resetPendingData();
    // Each sample of each channel is a 16bit integer
    this._bytesPerMillisecond = (channels * 2 * sampleRate) / 1000;

    // Create a pipeline for converting raw PCM data into opus packets
    const encoder = new prism.opus.Encoder({
      channels: channels,
      frameSize: frameSize,
      rate: sampleRate,
    });
    this._encoder = encoder;

    // A packaged build that is missing the native module silently falls back to
    // the pure JS encoder, so make which one is in use visible
    if (!loggedEncoderType) {
      loggedEncoderType = true;
      console.log(`Using Opus module ${prism.opus.Encoder.type}`);
    }

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

    this._applyBitrate(encoder);
    this._applyErrorCorrection(encoder);

    // Setup any listener streams
    this.emit("streamStart", encoder);
  };

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
      this._droppedBlocks++;
    }
    this._reportDroppedBlocks();
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
      if (!encoder.write(data)) {
        this._waitForDrain(encoder);
        return;
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

  /**
   * Report the audio dropped so far, at most once every
   * `DROP_REPORT_INTERVAL` so that a sustained stall can't spam the console
   */
  _reportDroppedBlocks = () => {
    // Queuing a block without having to drop one is the queue doing its job,
    // reporting it would both be false and use up the interval below that the
    // first real drop should have been reported in
    if (this._droppedBlocks === 0) {
      return;
    }
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
  };

  _handleStreamEnd = () => {
    this._encoder?.end();
    this._encoder = undefined;
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
