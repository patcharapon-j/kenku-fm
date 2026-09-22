import { normalizeAudio } from "../audioNormalization";
import { ipcMain, BrowserWindow, webContents } from "electron";
import Fastify, { FastifyInstance } from "fastify";
import { registerRemote } from "../remote";
import { getMediaURL } from "../mediaProtocol";

declare const PLAYER_WINDOW_WEBPACK_ENTRY: string;
declare const PLAYER_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

export class PlayerManager {
  registeredViewId?: number;
  fastify: FastifyInstance | null = null;
  address = "127.0.0.1";
  port = "3333";

  constructor() {
    ipcMain.handle("PLAYER_NORMALIZE_AUDIO", (event, source: string) => {
      if (event.sender.id !== this.registeredViewId || event.senderFrame !== event.sender.mainFrame) throw new Error("Player access required");
      return normalizeAudio(source);
    });
    ipcMain.on("PLAYER_GET_URL", this._handleGetURL);
    ipcMain.on("PLAYER_GET_PRELOAD_URL", this._handleGetPreloadURL);
    ipcMain.on("PLAYER_GET_MEDIA_URL", this._handleGetMediaURL);
    ipcMain.on("PLAYER_REGISTER_VIEW", this._handleRegisterView);
    ipcMain.on("PLAYER_START_REMOTE", this._handleStartRemote);
    ipcMain.on("PLAYER_STOP_REMOTE", this._handleStopRemote);
  }

  destroy() {
    ipcMain.removeHandler("PLAYER_NORMALIZE_AUDIO");
    ipcMain.off("PLAYER_GET_URL", this._handleGetURL);
    ipcMain.off("PLAYER_GET_PRELOAD_URL", this._handleGetPreloadURL);
    ipcMain.off("PLAYER_GET_MEDIA_URL", this._handleGetMediaURL);
    ipcMain.off("PLAYER_REGISTER_VIEW", this._handleRegisterView);
    ipcMain.off("PLAYER_START_REMOTE", this._handleStartRemote);
    ipcMain.off("PLAYER_STOP_REMOTE", this._handleStopRemote);
    this.stopRemote();
  }

  getView() {
    if (this.registeredViewId) {
      return webContents.fromId(this.registeredViewId);
    }
  }

  startRemote(address: string, port: string) {
    this.address = address;
    this.port = port;

    this.fastify = Fastify();

    registerRemote(this);

    this.fastify.listen(this.port, this.address, (err) => {
      const windows = BrowserWindow.getAllWindows();
      if (err) {
        for (const window of windows) {
          window.webContents.send("ERROR", err.message);
        }
        this.stopRemote();
      } else {
        for (const window of windows) {
          window.webContents.send("PLAYER_REMOTE_ENABLED", true);
        }
      }
    });
  }

  stopRemote() {
    if (this.fastify) {
      this.fastify.close();
      this.fastify = null;

      const windows = BrowserWindow.getAllWindows();
      for (const window of windows) {
        window.webContents.send("PLAYER_REMOTE_ENABLED", false);
      }
    }
  }

  getRemoteInfo() {
    return `Running: ${this.fastify !== null}\nAddress: ${
      this.address
    }\nPort: ${this.port}`;
  }

  _handleStartRemote = (
    _: Electron.IpcMainEvent,
    address: string,
    port: string
  ) => this.startRemote(address, port);

  _handleStopRemote = () => this.stopRemote();

  _handleGetURL = (event: Electron.IpcMainEvent) => {
    event.returnValue = PLAYER_WINDOW_WEBPACK_ENTRY;
  };

  _handleGetPreloadURL = (event: Electron.IpcMainEvent) => {
    event.returnValue = PLAYER_WINDOW_PRELOAD_WEBPACK_ENTRY;
  };

  /**
   * Turn a local file path into a URL the player can route through Web Audio
   * Only the player's preload can reach this, which is what keeps the scheme
   * from being a way for a page in a tab to read the disk
   */
  _handleGetMediaURL = (event: Electron.IpcMainEvent, filePath: string) => {
    event.returnValue = getMediaURL(filePath);
  };

  _handleRegisterView = (_: Electron.IpcMainEvent, viewId: number) => {
    this.registeredViewId = viewId;
  };
}
