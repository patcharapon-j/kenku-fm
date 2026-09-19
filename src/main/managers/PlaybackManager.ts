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
/**
 * Number of Opus packets the play stream may hold before the encoder is asked
 * to back off
 * Each packet is 20ms of audio, so the stream's own default of 16 would let
 * over a third of a second of audio queue up ahead of the voice connection,
 * which is latency that never comes back
 */
const MAX_QUEUED_PACKETS = 3;
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
  /**
   * The bitrate of each voice channel that is currently joined.
   * One encoder feeds every connection so the lowest of these is used, as
   * anything above a channel's own bitrate is discarded by Discord.
   */
  _channelBitrates: Map<string, number> = new Map();

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
    this.audioCaptureManager.on("encoderError", () => {
      this.window.webContents.send(
        "ERROR",
        "Audio encoding stopped unexpectedly. Restart the audio capture to try again.",
      );
    });
    this.audioCaptureManager.on("encoderInfo", (info) => {
      this.window.webContents.send("AUDIO_CAPTURE_ENCODER", info);
    });
    this.audioCaptureManager.on("levels", (levels) => {
      this.window.webContents.send("AUDIO_CAPTURE_LEVELS", levels);
    });
    this.audioCaptureManager.on("warning", (message) => {
      this.window.webContents.send("AUDIO_CAPTURE_WARNING", message);
    });
    this.discord.on("channelJoined", (channelId, bitrate) => {
      this._channelBitrates.set(channelId, bitrate);
      this._updateBitrate();
    });
    this.discord.on("channelLeft", (channelId) => {
      if (this._channelBitrates.delete(channelId)) {
        this._updateBitrate();
      }
    });
    this.discord.audioPlayer.on(
      AudioPlayerStatus.Playing,
      this._handlePlayerPlaying,
    );
    this.discord.audioPlayer.on(AudioPlayerStatus.Idle, this._handlePlayerIdle);
  }

  /**
   * Encode at the lowest bitrate of the channels that are currently joined, or
   * let the encoder use its own default when there are none left
   */
  _updateBitrate = () => {
    const bitrates = Array.from(this._channelBitrates.values());
    this.audioCaptureManager.setBitrate(
      bitrates.length > 0 ? Math.min(...bitrates) : undefined,
    );
  };

  _clearRecoveryTimeout = () => {
    if (this._recoveryTimeout) {
      clearTimeout(this._recoveryTimeout);
      this._recoveryTimeout = undefined;
    }
  };

  destroy() {
    this._clearRecoveryTimeout();
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
    // A recovery scheduled for an earlier stream must never run against this
    // one, which would discard the packets it has just buffered
    this._clearRecoveryTimeout();
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
    const playStream = new PassThrough({
      objectMode: true,
      highWaterMark: MAX_QUEUED_PACKETS,
    });
    this._stream.pipe(playStream);
    const resource = createAudioResource(playStream, {
      inputType: StreamType.Opus,
    });
    this.discord.audioPlayer.play(resource);
  };

  _stopPlayback = () => {
    this._clearRecoveryTimeout();
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
