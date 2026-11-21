import { ipcMain } from "electron";

import { getMediaURL } from "../mediaProtocol";
import { PreviewEngineState, PreviewLoadCommand } from "../../types/preview";
import { AudioCaptureManagerMain } from "./AudioCaptureManagerMain";
import { PlayerManager } from "./PlayerManager";

/**
 * Resolve a stored library URL for the hidden Audio Capture window.
 *
 * Local `file://` URLs are converted to the per-launch `kenku-media://`
 * capability URL here in the main process so the secret token stays off
 * untrusted web views. Remote `http(s)://` URLs pass through unchanged; any
 * other scheme is refused.
 */
export function resolvePreviewURL(url: string): string | null {
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }
  if (url.startsWith("file://")) {
    try {
      const filePath = decodeURIComponent(url.slice("file://".length));
      if (!filePath) {
        return null;
      }
      return getMediaURL(filePath);
    } catch {
      return null;
    }
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return url;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Bridges GM-only preview commands between the Player view and the hidden Audio
 * Capture window.
 *
 * Every command is checked against the registered player view's main frame so
 * arbitrary web pages loaded in browser tabs can neither trigger preview
 * playback nor resolve local file paths through `kenku-media://`.
 */
export class PreviewManager {
  private playerManager: PlayerManager;
  private audioCaptureManager: AudioCaptureManagerMain;

  constructor(
    playerManager: PlayerManager,
    audioCaptureManager: AudioCaptureManagerMain,
  ) {
    this.playerManager = playerManager;
    this.audioCaptureManager = audioCaptureManager;

    this.audioCaptureManager.on("previewState", this._handlePreviewState);

    ipcMain.on("PLAYER_PREVIEW_LOAD", this._handleLoad);
    ipcMain.on("PLAYER_PREVIEW_PLAY", this._handlePlay);
    ipcMain.on("PLAYER_PREVIEW_PAUSE", this._handlePause);
    ipcMain.on("PLAYER_PREVIEW_STOP", this._handleStop);
    ipcMain.on("PLAYER_PREVIEW_SEEK", this._handleSeek);
    ipcMain.on("PLAYER_PREVIEW_SET_VOLUME", this._handleSetVolume);
    ipcMain.on("PLAYER_PREVIEW_SET_MUTED", this._handleSetMuted);
    ipcMain.on("PLAYER_PREVIEW_SET_DUCK", this._handleSetDuck);
  }

  destroy(): void {
    this.audioCaptureManager.off("previewState", this._handlePreviewState);

    ipcMain.off("PLAYER_PREVIEW_LOAD", this._handleLoad);
    ipcMain.off("PLAYER_PREVIEW_PLAY", this._handlePlay);
    ipcMain.off("PLAYER_PREVIEW_PAUSE", this._handlePause);
    ipcMain.off("PLAYER_PREVIEW_STOP", this._handleStop);
    ipcMain.off("PLAYER_PREVIEW_SEEK", this._handleSeek);
    ipcMain.off("PLAYER_PREVIEW_SET_VOLUME", this._handleSetVolume);
    ipcMain.off("PLAYER_PREVIEW_SET_MUTED", this._handleSetMuted);
    ipcMain.off("PLAYER_PREVIEW_SET_DUCK", this._handleSetDuck);
  }

  private _isFromPlayer(event: Electron.IpcMainEvent): boolean {
    return (
      this.playerManager.registeredViewId !== undefined &&
      event.sender.id === this.playerManager.registeredViewId &&
      event.senderFrame === event.sender.mainFrame
    );
  }

  private _handleLoad = (
    event: Electron.IpcMainEvent,
    command: PreviewLoadCommand,
  ) => {
    if (!this._isFromPlayer(event)) {
      return;
    }
    const resolvedUrl = resolvePreviewURL(command?.url);
    if (!resolvedUrl) {
      this._handlePreviewState({
        requestId: command?.requestId ?? 0,
        loading: false,
        playing: false,
        progress: 0,
        duration: 0,
        ended: false,
        level: 0,
        error: "Unsupported preview audio source",
      });
      return;
    }
    this.audioCaptureManager.previewLoad({
      url: resolvedUrl,
      volume: command.volume,
      muted: command.muted,
      duckLiveMonitor: command.duckLiveMonitor,
      requestId: command.requestId,
    });
  };

  private _handlePlay = (event: Electron.IpcMainEvent) => {
    if (!this._isFromPlayer(event)) {
      return;
    }
    this.audioCaptureManager.previewPlay();
  };

  private _handlePause = (event: Electron.IpcMainEvent) => {
    if (!this._isFromPlayer(event)) {
      return;
    }
    this.audioCaptureManager.previewPause();
  };

  private _handleStop = (event: Electron.IpcMainEvent) => {
    if (!this._isFromPlayer(event)) {
      return;
    }
    this.audioCaptureManager.previewStop();
  };

  private _handleSeek = (event: Electron.IpcMainEvent, to: number) => {
    if (!this._isFromPlayer(event)) {
      return;
    }
    if (typeof to === "number" && Number.isFinite(to)) {
      this.audioCaptureManager.previewSeek(to);
    }
  };

  private _handleSetVolume = (event: Electron.IpcMainEvent, volume: number) => {
    if (!this._isFromPlayer(event)) {
      return;
    }
    if (typeof volume === "number" && Number.isFinite(volume)) {
      this.audioCaptureManager.previewSetVolume(volume);
    }
  };

  private _handleSetMuted = (event: Electron.IpcMainEvent, muted: boolean) => {
    if (!this._isFromPlayer(event)) {
      return;
    }
    this.audioCaptureManager.previewSetMuted(Boolean(muted));
  };

  private _handleSetDuck = (event: Electron.IpcMainEvent, enabled: boolean) => {
    if (!this._isFromPlayer(event)) {
      return;
    }
    this.audioCaptureManager.previewSetDuck(Boolean(enabled));
  };

  private _handlePreviewState = (state: PreviewEngineState) => {
    const view = this.playerManager.getView();
    if (!view || view.isDestroyed()) {
      return;
    }
    view.send("PLAYER_PREVIEW_STATE", state);
  };
}
