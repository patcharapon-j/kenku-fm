import { BrowserWindow } from "electron";
import { BrowserViewManagerMain } from "./BrowserViewManagerMain";
import { PlaybackManager } from "./PlaybackManager";
import { PlayerManager } from "./PlayerManager";
import { PreviewManager } from "./PreviewManager";
import { StreamKitManager } from "./StreamKitManager";
import { WindowManager } from "./WindowManager";

export class SessionManager {
  private playbackManager: PlaybackManager;
  private playerManager: PlayerManager;
  private previewManager: PreviewManager;
  private viewManager: BrowserViewManagerMain;
  private windowManager: WindowManager;
  private streamKitManager: StreamKitManager;

  constructor(window: BrowserWindow) {
    this.playbackManager = new PlaybackManager(window);
    this.viewManager = new BrowserViewManagerMain(window);
    this.windowManager = new WindowManager(window);
    this.playerManager = new PlayerManager();
    this.previewManager = new PreviewManager(
      this.playerManager,
      this.playbackManager.audioCaptureManager
    );
    this.streamKitManager = new StreamKitManager(window, this.playerManager);
    // The Stream Kit is told whether Discord is going out as well
    this.playbackManager.discord.on("channelJoined", (channelId) => {
      this.streamKitManager.setDiscordChannel(channelId, true);
    });
    this.playbackManager.discord.on("channelLeft", (channelId) => {
      this.streamKitManager.setDiscordChannel(channelId, false);
    });
  }

  destroy() {
    this.streamKitManager.destroy();
    this.previewManager.destroy();
    this.playbackManager.destroy();
    this.viewManager.destroy();
    this.windowManager.destroy();
    this.playerManager.destroy();
  }
}
