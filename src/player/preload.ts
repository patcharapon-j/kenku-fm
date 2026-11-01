import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  PlaylistPlaybackReply,
  PlaylistsReply,
  SoundboardPlaybackReply,
  SoundboardsReply,
} from "../types/player";
import {
  Library,
  NowPlaying,
  PlayerStatus,
  VoiceRoomState,
} from "../types/streamKit";

type Channel =
  | "PLAYER_REMOTE_PLAYLIST_GET_ALL_REQUEST"
  | "PLAYER_REMOTE_PLAYLIST_PLAY"
  | "PLAYER_REMOTE_PLAYLIST_PLAYBACK_REQUEST"
  | "PLAYER_REMOTE_PLAYLIST_PLAYBACK_PLAY"
  | "PLAYER_REMOTE_PLAYLIST_PLAYBACK_PAUSE"
  | "PLAYER_REMOTE_PLAYLIST_PLAYBACK_MUTE"
  | "PLAYER_REMOTE_PLAYLIST_PLAYBACK_VOLUME"
  | "PLAYER_REMOTE_PLAYLIST_PLAYBACK_SEEK"
  | "PLAYER_REMOTE_PLAYLIST_PLAYBACK_NEXT"
  | "PLAYER_REMOTE_PLAYLIST_PLAYBACK_PREVIOUS"
  | "PLAYER_REMOTE_PLAYLIST_PLAYBACK_REPEAT"
  | "PLAYER_REMOTE_PLAYLIST_PLAYBACK_SHUFFLE"
  | "PLAYER_REMOTE_SOUNDBOARD_GET_ALL_REQUEST"
  | "PLAYER_REMOTE_SOUNDBOARD_PLAY"
  | "PLAYER_REMOTE_SOUNDBOARD_STOP"
  | "PLAYER_REMOTE_SOUNDBOARD_PLAYBACK_REQUEST"
  | "PLAYER_REMOTE_PLAYLIST_PLAY_TRACK"
  | "PLAYER_REMOTE_SOUNDBOARD_STOP_ALL"
  | "PLAYER_STREAM_KIT_VOICE"
  | "PLAYER_STREAM_KIT_RESEND";

const validChannels: Channel[] = [
  "PLAYER_REMOTE_PLAYLIST_GET_ALL_REQUEST",
  "PLAYER_REMOTE_PLAYLIST_PLAY",
  "PLAYER_REMOTE_PLAYLIST_PLAYBACK_REQUEST",
  "PLAYER_REMOTE_PLAYLIST_PLAYBACK_PLAY",
  "PLAYER_REMOTE_PLAYLIST_PLAYBACK_PAUSE",
  "PLAYER_REMOTE_PLAYLIST_PLAYBACK_MUTE",
  "PLAYER_REMOTE_PLAYLIST_PLAYBACK_VOLUME",
  "PLAYER_REMOTE_PLAYLIST_PLAYBACK_SEEK",
  "PLAYER_REMOTE_PLAYLIST_PLAYBACK_NEXT",
  "PLAYER_REMOTE_PLAYLIST_PLAYBACK_PREVIOUS",
  "PLAYER_REMOTE_PLAYLIST_PLAYBACK_REPEAT",
  "PLAYER_REMOTE_PLAYLIST_PLAYBACK_SHUFFLE",
  "PLAYER_REMOTE_SOUNDBOARD_GET_ALL_REQUEST",
  "PLAYER_REMOTE_SOUNDBOARD_PLAY",
  "PLAYER_REMOTE_SOUNDBOARD_STOP",
  "PLAYER_REMOTE_SOUNDBOARD_PLAYBACK_REQUEST",
  "PLAYER_REMOTE_PLAYLIST_PLAY_TRACK",
  "PLAYER_REMOTE_SOUNDBOARD_STOP_ALL",
  "PLAYER_STREAM_KIT_VOICE",
  "PLAYER_STREAM_KIT_RESEND",
];

const api = {
  normalizeAudio: (source: string): Promise<{ source: string; url: string; gainDb: number; version: number }> => ipcRenderer.invoke("PLAYER_NORMALIZE_AUDIO", source),
  /** How many files the app processes at once, so progress can be reported honestly */
  normalizationConcurrency: (): Promise<number> => ipcRenderer.invoke("PLAYER_NORMALIZE_CONCURRENCY"),
  on: (channel: Channel, callback: (...args: any[]) => any) => {
    if (validChannels.includes(channel)) {
      const newCallback = (_: any, ...args: any[]) => callback(args);
      ipcRenderer.on(channel, newCallback);
    }
  },
  removeAllListeners: (channel: Channel) => {
    if (validChannels.includes(channel)) {
      ipcRenderer.removeAllListeners(channel);
    }
  },
  playlistPlaybackReply: (playback: PlaylistPlaybackReply) => {
    ipcRenderer.send("PLAYER_REMOTE_PLAYLIST_PLAYBACK_REPLY", playback);
  },
  soundboardPlaybackReply: (playback: SoundboardPlaybackReply) => {
    ipcRenderer.send("PLAYER_REMOTE_SOUNDBOARD_PLAYBACK_REPLY", playback);
  },
  playlistGetAllReply: (playlists: PlaylistsReply) => {
    ipcRenderer.send("PLAYER_REMOTE_PLAYLIST_GET_ALL_REPLY", playlists);
  },
  soundboardGetAllReply: (soundboards: SoundboardsReply) => {
    ipcRenderer.send("PLAYER_REMOTE_SOUNDBOARD_GET_ALL_REPLY", soundboards);
  },
  /** Tell the main process the player is up, so it sends the Voice Room again */
  streamKitReady: () => {
    ipcRenderer.send("PLAYER_STREAM_KIT_READY");
  },
  streamKitLibrary: (library: Library) => {
    ipcRenderer.send("PLAYER_STREAM_KIT_LIBRARY", library);
  },
  streamKitNowPlaying: (nowPlaying: NowPlaying) => {
    ipcRenderer.send("PLAYER_STREAM_KIT_NOW_PLAYING", nowPlaying);
  },
  streamKitStatus: (status: PlayerStatus) => {
    ipcRenderer.send("PLAYER_STREAM_KIT_STATUS", status);
  },
  streamKitVoiceState: (state: VoiceRoomState) => {
    ipcRenderer.send("PLAYER_STREAM_KIT_VOICE_STATE", state);
  },
  /** Ask the Stream Kit for fresh Voice Room credentials */
  streamKitVoicePlease: () => {
    ipcRenderer.send("PLAYER_STREAM_KIT_VOICE_PLEASE");
  },
  getPathForFile: (file: File) => {
    return webUtils.getPathForFile(file);
  },
  /**
   * Convert a stored track URL into the one to actually play
   * A `file://` URL is an opaque origin, so an element loaded from one can't be
   * routed through Web Audio. The same file served over the app's own scheme
   * can be, which is what lets playback be faded sample accurately. Anything
   * that isn't a local file is left alone: a remote URL may not send the CORS
   * headers that routing needs, and the failure mode there is silence
   */
  toMediaURL: (url: string): string => {
    if (!url.startsWith("file://")) {
      return url;
    }
    const filePath = decodeURIComponent(url.slice("file://".length));
    return ipcRenderer.sendSync("PLAYER_GET_MEDIA_URL", filePath) as string;
  } 
};

declare global {
  interface Window {
    player: typeof api;
  }
}

contextBridge.exposeInMainWorld("player", api);
