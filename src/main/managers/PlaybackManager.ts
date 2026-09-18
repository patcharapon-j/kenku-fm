import {
  AudioPlayerStatus,
  createAudioResource,
  StreamType,
} from "@discordjs/voice";
import { BrowserWindow } from "electron";
import { PassThrough, Readable } from "stream";
import { DiscordBroadcast } from "../broadcast/DiscordBroadcast";
import { AudioCaptureManagerMain } from "./AudioCaptureManagerMain";

/** Maximum number of times to recreate the audio resource before giving up */
const MAX_RECOVERY_ATTEMPTS = 5;
/** Delay in ms before recreating the audio resource after playback stopped */
const RECOVERY_DELAY = 1000;

export class PlaybackManager {
  window: BrowserWindow;
  discord: DiscordBroadcast;
  audioCaptureManager: AudioCaptureManagerMain;
  /** The opus stream that is currently being encoded, if any */
  _stream?: Readable;
  /** Number of times playback has been recovered since it last started playing */
  _recoveryAttempts = 0;
  /** Timer for the next recovery attempt, if one is scheduled */
  _recoveryTimeout?: NodeJS.Timeout;

  constructor(window: BrowserWindow) {
    this.window = window;
    this.discord = new DiscordBroadcast(window);
    this.audioCaptureManager = new AudioCaptureManagerMain();
    this.audioCaptureManager.on("streamStart", (stream) => {
      this._stream = stream;
      this._recoveryAttempts = 0;
      this._play();
    });
    this.audioCaptureManager.on("streamEnd", () => {
      this._stopPlayback();
    });
    this.discord.on("channelJoined", (_channelId, bitrate) => {
      this.audioCaptureManager.setBitrate(bitrate);
    });
    this.discord.audioPlayer.on(
      AudioPlayerStatus.Playing,
      this._handlePlayerPlaying,
    );
    this.discord.audioPlayer.on(AudioPlayerStatus.Idle, this._handlePlayerIdle);
  }

  destroy() {
    if (this._recoveryTimeout) {
      clearTimeout(this._recoveryTimeout);
      this._recoveryTimeout = undefined;
    }
    this.discord.audioPlayer.off(
      AudioPlayerStatus.Playing,
      this._handlePlayerPlaying,
    );
    this.discord.audioPlayer.off(
      AudioPlayerStatus.Idle,
      this._handlePlayerIdle,
    );
    this.discord.destroy();
    this.audioCaptureManager.destroy();
  }

  /**
   * Create a new audio resource from the current opus stream and play it
   * The stream is piped into a pass through stream as the audio player destroys
   * the stream it was given when playback stops or errors, which would
   * otherwise destroy the encoder along with it
   */
  _play = () => {
    if (!this._stream) {
      return;
    }
    // Drop any audio that was buffered while there was nothing playing it so
    // that recovering playback doesn't add latency to the stream
    this._stream.unpipe();
    let packet = this._stream.read();
    while (packet !== null) {
      packet = this._stream.read();
    }
    // The encoder emits one opus packet per read so the pass through stream
    // must be in object mode to keep the packets intact
    const playStream = new PassThrough({ objectMode: true });
    this._stream.pipe(playStream);
    const resource = createAudioResource(playStream, {
      inputType: StreamType.Opus,
    });
    this.discord.audioPlayer.play(resource);
  };

  _stopPlayback = () => {
    if (this._recoveryTimeout) {
      clearTimeout(this._recoveryTimeout);
      this._recoveryTimeout = undefined;
    }
    this._stream?.unpipe();
    this._stream = undefined;
    this.discord.audioPlayer.stop();
  };

  _handlePlayerPlaying = () => {
    this._recoveryAttempts = 0;
  };

  /**
   * The player goes idle when the resource errors or ends
   * If the capture is still running then recreate the resource so that playback
   * isn't dead until the user restarts the capture
   */
  _handlePlayerIdle = () => {
    if (!this._stream || this._stream.destroyed || this._stream.readableEnded) {
      return;
    }
    if (this._recoveryTimeout) {
      return;
    }
    if (this._recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      this.window.webContents.send(
        "ERROR",
        "Unable to resume audio playback. Restart the audio capture to try again.",
      );
      return;
    }
    this._recoveryAttempts += 1;
    this._recoveryTimeout = setTimeout(() => {
      this._recoveryTimeout = undefined;
      this._play();
    }, RECOVERY_DELAY);
  };
}
