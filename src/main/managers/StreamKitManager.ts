import { app, BrowserWindow, ipcMain } from "electron";
import Store from "electron-store";

import { StreamKitClient } from "../streamKit/StreamKitClient";
import { DEFAULT_STREAM_KIT_URL } from "../streamKit/protocol";
import { PlayerManager } from "./PlayerManager";
import {
  Campaign,
  Command,
  Library,
  NowPlaying,
  PlayerStatus,
  StreamKitState,
  VoiceRoomState,
} from "../../types/streamKit";

type SavedStreamKit = {
  url: string;
  token: string | null;
  campaign: Campaign | null;
  enabled: boolean;
};

const DEFAULT_SAVED: SavedStreamKit = {
  url: DEFAULT_STREAM_KIT_URL,
  token: null,
  campaign: null,
  enabled: true,
};

/**
 * Connects Kenku FM to the GLUniverse Stream Kit, alongside Discord rather
 * than in place of it.
 *
 * The socket to the Stream Kit lives here, in the main process, where the
 * pairing can be saved and the player can be reached. The Voice Room is
 * joined by the player itself, as that is where the music and effects can
 * still be told apart, so this hands it the credentials and passes on what
 * it reports.
 */
export class StreamKitManager {
  window: BrowserWindow;
  playerManager: PlayerManager;
  client: StreamKitClient;
  store = new Store<{ streamKit: SavedStreamKit }>({ name: "stream-kit" });

  /** The latest of each report from the player, sent again on every connect */
  _library: Library | null = null;
  _nowPlaying: NowPlaying | null = null;
  _playerStatus: PlayerStatus | null = null;
  /** Voice Room credentials from the Stream Kit, null until it has sent any */
  _voice: { url: string | null; token: string | null } | null = null;
  _voiceState: VoiceRoomState = { status: "off" };
  _discordChannels = new Set<string>();

  constructor(window: BrowserWindow, playerManager: PlayerManager) {
    this.window = window;
    this.playerManager = playerManager;
    this.client = new StreamKitClient({ appVersion: app.getVersion() });

    this.client.on("state", this._pushState);
    this.client.on("paired", (token, campaign) => {
      this._save({ token, campaign });
    });
    this.client.on("ready", (campaign) => {
      this._save({ campaign });
      this._sendLibrary();
      this._sendStatus();
      this._sendNowPlaying();
    });
    this.client.on("refused", () => {
      this._save({ token: null });
      this._voice = null;
      this._sendVoiceToPlayer();
    });
    this.client.on("voice", (url, token) => {
      this._voice = { url, token };
      this._sendVoiceToPlayer();
      this._pushState();
    });
    this.client.on("command", this._handleCommand);

    ipcMain.handle("STREAM_KIT_GET_STATE", this._handleGetState);
    ipcMain.on("STREAM_KIT_PAIR", this._handlePair);
    ipcMain.on("STREAM_KIT_UNPAIR", this._handleUnpair);
    ipcMain.on("STREAM_KIT_SET_ENABLED", this._handleSetEnabled);
    ipcMain.on("PLAYER_STREAM_KIT_READY", this._handlePlayerReady);
    ipcMain.on("PLAYER_REGISTER_VIEW", this._handleRegisterView);
    ipcMain.on("PLAYER_STREAM_KIT_LIBRARY", this._handleLibrary);
    ipcMain.on("PLAYER_STREAM_KIT_NOW_PLAYING", this._handleNowPlaying);
    ipcMain.on("PLAYER_STREAM_KIT_STATUS", this._handlePlayerStatus);
    ipcMain.on("PLAYER_STREAM_KIT_VOICE_STATE", this._handleVoiceState);
    ipcMain.on("PLAYER_STREAM_KIT_VOICE_PLEASE", this._handleVoicePlease);

    const saved = this._saved();
    if (saved.token) {
      this.client.connect(saved.url, saved.token);
    }
  }

  destroy() {
    ipcMain.removeHandler("STREAM_KIT_GET_STATE");
    ipcMain.off("STREAM_KIT_PAIR", this._handlePair);
    ipcMain.off("STREAM_KIT_UNPAIR", this._handleUnpair);
    ipcMain.off("STREAM_KIT_SET_ENABLED", this._handleSetEnabled);
    ipcMain.off("PLAYER_STREAM_KIT_READY", this._handlePlayerReady);
    ipcMain.off("PLAYER_REGISTER_VIEW", this._handleRegisterView);
    ipcMain.off("PLAYER_STREAM_KIT_LIBRARY", this._handleLibrary);
    ipcMain.off("PLAYER_STREAM_KIT_NOW_PLAYING", this._handleNowPlaying);
    ipcMain.off("PLAYER_STREAM_KIT_STATUS", this._handlePlayerStatus);
    ipcMain.off("PLAYER_STREAM_KIT_VOICE_STATE", this._handleVoiceState);
    ipcMain.off("PLAYER_STREAM_KIT_VOICE_PLEASE", this._handleVoicePlease);
    this.client.removeAllListeners();
    this.client.stop();
    // The player outlives a reload of the main window, and the session that
    // replaces this one will hand it the credentials again when it connects
    this._voice = null;
    this._sendVoiceToPlayer();
  }

  /** Follow the Discord voice channels joined, for the status's outputs */
  setDiscordChannel(channelId: string, joined: boolean) {
    const had = this._discordChannels.size > 0;
    if (joined) {
      this._discordChannels.add(channelId);
    } else {
      this._discordChannels.delete(channelId);
    }
    if (had !== this._discordChannels.size > 0) {
      this._sendStatus();
      this._pushState();
    }
  }

  getState(): StreamKitState {
    const saved = this._saved();
    return {
      url: saved.url,
      paired: Boolean(saved.token),
      enabled: saved.enabled,
      connection: this.client.state,
      campaign: saved.campaign,
      voiceAvailable: this._voice ? Boolean(this._voice.url) : null,
      voice: this._voiceState,
      discord: this._discordChannels.size > 0,
    };
  }

  _saved(): SavedStreamKit {
    return { ...DEFAULT_SAVED, ...this.store.get("streamKit") };
  }

  _save(changes: Partial<SavedStreamKit>) {
    this.store.set("streamKit", { ...this._saved(), ...changes });
    this._pushState();
  }

  _pushState = () => {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send("STREAM_KIT_STATE", this.getState());
    }
  };

  /** Credentials go to the player only while the output is turned on */
  _sendVoiceToPlayer() {
    const view = this.playerManager.getView();
    if (!view || view.isDestroyed()) {
      return;
    }
    const enabled = this._saved().enabled;
    const url = enabled ? (this._voice?.url ?? null) : null;
    const token = enabled ? (this._voice?.token ?? null) : null;
    view.send("PLAYER_STREAM_KIT_VOICE", url, token);
  }

  _sendLibrary() {
    if (this._library) {
      this.client.send({ type: "library", ...this._library });
    }
  }

  _sendNowPlaying() {
    if (this._nowPlaying) {
      this.client.send({ type: "now-playing", ...this._nowPlaying });
    }
  }

  _sendStatus() {
    if (this._playerStatus) {
      this.client.send({
        type: "status",
        ...this._playerStatus,
        outputs: {
          discord: this._discordChannels.size > 0,
          streamKit: this._saved().enabled,
        },
      });
    }
  }

  /**
   * Commands go to the player over the same channels as the HTTP remote's, so
   * the Stream Kit gets exactly the behaviour the Stream Deck does
   */
  _handleCommand = (command: Command) => {
    const view = this.playerManager.getView();
    if (!view || view.isDestroyed()) {
      return;
    }
    const isId = (value: unknown): value is string =>
      typeof value === "string" && value.length > 0;
    switch (command.kind) {
      case "play-playlist":
        if (isId(command.playlistId)) {
          view.send("PLAYER_REMOTE_PLAYLIST_PLAY", command.playlistId);
        }
        break;
      case "play-track":
        if (isId(command.playlistId) && isId(command.trackId)) {
          view.send(
            "PLAYER_REMOTE_PLAYLIST_PLAY_TRACK",
            command.playlistId,
            command.trackId,
          );
        }
        break;
      case "playback": {
        const channels = {
          play: "PLAYER_REMOTE_PLAYLIST_PLAYBACK_PLAY",
          pause: "PLAYER_REMOTE_PLAYLIST_PLAYBACK_PAUSE",
          next: "PLAYER_REMOTE_PLAYLIST_PLAYBACK_NEXT",
          previous: "PLAYER_REMOTE_PLAYLIST_PLAYBACK_PREVIOUS",
        } as const;
        const channel = channels[command.action];
        if (channel) {
          view.send(channel);
        }
        break;
      }
      case "music-volume":
        if (typeof command.volume === "number" && Number.isFinite(command.volume)) {
          view.send(
            "PLAYER_REMOTE_PLAYLIST_PLAYBACK_VOLUME",
            Math.max(Math.min(command.volume, 1), 0),
          );
        }
        break;
      case "play-sound":
        if (isId(command.soundId)) {
          view.send("PLAYER_REMOTE_SOUNDBOARD_PLAY", command.soundId);
        }
        break;
      case "stop-sounds":
        view.send("PLAYER_REMOTE_SOUNDBOARD_STOP_ALL");
        break;
      default:
        // A command this Kenku doesn't know yet
        break;
    }
  };

  _fromWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
    return event.sender === this.window.webContents;
  }

  _fromPlayer(event: Electron.IpcMainEvent) {
    return (
      event.sender.id === this.playerManager.registeredViewId &&
      event.senderFrame === event.sender.mainFrame
    );
  }

  _handleGetState = (event: Electron.IpcMainInvokeEvent) => {
    if (!this._fromWindow(event)) {
      throw new Error("Main window access required");
    }
    return this.getState();
  };

  _handlePair = (event: Electron.IpcMainEvent, url: string, code: string) => {
    if (!this._fromWindow(event) || typeof url !== "string" || typeof code !== "string") {
      return;
    }
    // Pairing again starts over: whatever was saved before is replaced by the
    // pairing's token, or by nothing if it doesn't go through
    this._voice = null;
    this._sendVoiceToPlayer();
    this._save({ url: url.trim(), token: null, campaign: null });
    this.client.pair(url, code);
  };

  _handleUnpair = (event: Electron.IpcMainEvent) => {
    if (!this._fromWindow(event)) {
      return;
    }
    this.client.stop();
    this._voice = null;
    this._sendVoiceToPlayer();
    this._save({ token: null, campaign: null });
  };

  _handleSetEnabled = (event: Electron.IpcMainEvent, enabled: boolean) => {
    if (!this._fromWindow(event)) {
      return;
    }
    this._save({ enabled: Boolean(enabled) });
    this._sendVoiceToPlayer();
    this._sendStatus();
  };

  /**
   * The player and the main window race to be first: the player can be up
   * and reporting before the main window has told this process which view it
   * is, and reports from a view that isn't known to be the player are
   * dropped. So whichever of the two arrives second has the player send
   * everything again, and hands it the Voice Room
   */
  _handlePlayerReady = (event: Electron.IpcMainEvent) => {
    if (this._fromPlayer(event)) {
      this._syncPlayer();
    }
  };

  _handleRegisterView = () => {
    // `PlayerManager` registered the view in its own handler, which ran first
    this._syncPlayer();
  };

  _syncPlayer() {
    const view = this.playerManager.getView();
    if (!view || view.isDestroyed()) {
      return;
    }
    view.send("PLAYER_STREAM_KIT_RESEND");
    this._sendVoiceToPlayer();
  }

  _handleLibrary = (event: Electron.IpcMainEvent, library: Library) => {
    if (this._fromPlayer(event)) {
      this._library = library;
      this._sendLibrary();
    }
  };

  _handleNowPlaying = (event: Electron.IpcMainEvent, nowPlaying: NowPlaying) => {
    if (this._fromPlayer(event)) {
      this._nowPlaying = nowPlaying;
      this._sendNowPlaying();
    }
  };

  _handlePlayerStatus = (event: Electron.IpcMainEvent, status: PlayerStatus) => {
    if (this._fromPlayer(event)) {
      this._playerStatus = status;
      this._sendStatus();
    }
  };

  _handleVoiceState = (event: Electron.IpcMainEvent, state: VoiceRoomState) => {
    if (this._fromPlayer(event)) {
      this._voiceState = state;
      this._pushState();
    }
  };

  _handleVoicePlease = (event: Electron.IpcMainEvent) => {
    if (this._fromPlayer(event)) {
      this.client.send({ type: "voice-please" });
    }
  };
}
