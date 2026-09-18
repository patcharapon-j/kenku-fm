import { BrowserWindow, ipcMain, webContents } from "electron";
import { TypedEmitter } from "tiny-typed-emitter";
import { Readable } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import prism from "prism-media";

declare const AUDIO_CAPTURE_WINDOW_WEBPACK_ENTRY: string;
declare const AUDIO_CAPTURE_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

interface AudioCaptureManagerEvents {
  streamStart: (stream: Readable) => void;
  streamEnd: () => void;
  encoderError: (error: Error) => void;
}

/** libopus `OPUS_SET_BITRATE_REQUEST`, applied directly to bypass prism's clamp */
const OPUS_SET_BITRATE = 4002;
/** The bitrate range libopus itself accepts, in bits per second */
const MIN_BITRATE = 500;
const MAX_BITRATE = 512000;
/** Expected packet loss used to size the inband forward error correction */
const EXPECTED_PACKET_LOSS = 0.05;

/** Only report which Opus module was loaded once per process */
let loggedEncoderType = false;

/**
 * Manager to capture audio from browser views and external audio devices
 * This class is to be run on the main thread
 * For the render thread counterpart see `AudioCaptureManagerPreload.ts`
 */
export class AudioCaptureManagerMain extends TypedEmitter<AudioCaptureManagerEvents> {
  _browserWindow: BrowserWindow;
  _encoder?: prism.opus.Encoder;
  _wss: WebSocketServer;
  /**
   * The bitrate to encode at, if one has been set
   * This is kept so that it can be reapplied to any encoder created after this
   * point as a new encoder is made each time the capture is restarted
   */
  _bitrate?: number;

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
    this._wss = new WebSocketServer({ port: 0 });

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
    ipcMain.handle(
      "AUDIO_CAPTURE_GET_WEBSOCKET_ADDRESS",
      this._handleGetWebsocketAddress
    );
    ipcMain.on(
      "AUDIO_CAPTURE_START_BROWSER_VIEW_STREAM",
      this._handleStartBrowserViewStream
    );
    ipcMain.on(
      "AUDIO_CAPTURE_STOP_BROWSER_VIEW_STREAM",
      this._handleStopBrowserViewStream
    );

    this._wss.on("connection", this._handleWebsocketConnection);
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
    ipcMain.removeHandler("AUDIO_CAPTURE_GET_WEBSOCKET_ADDRESS");
    ipcMain.off(
      "AUDIO_CAPTURE_START_BROWSER_VIEW_STREAM",
      this._handleStartBrowserViewStream
    );
    ipcMain.off(
      "AUDIO_CAPTURE_STOP_BROWSER_VIEW_STREAM",
      this._handleStopBrowserViewStream
    );
    this._browserWindow.webContents.close();
    (this._browserWindow.webContents as any).destroy();
    this._handleStreamEnd();
    this._wss.close();
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

  _handleWebsocketConnection = (ws: WebSocket) => {
    ws.on("message", this._handleStreamData);
  };

  _handleStart = (
    _: Electron.IpcMainEvent,
    streamingMode: "lowLatency" | "performance"
  ) => {
    this._browserWindow.webContents.send("AUDIO_CAPTURE_START", streamingMode);
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

  _handleStreamData = async (data: Buffer) => {
    this._encoder?.write(data);
  };

  _handleStreamEnd = () => {
    this._encoder?.end();
    this._encoder = undefined;
    this.emit("streamEnd");
  };

  _handleGetWebsocketAddress = async () => {
    return this._wss.address();
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
}
