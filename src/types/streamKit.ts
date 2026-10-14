/**
 * Data shared by the main process, the player and the main window about the
 * Stream Kit output. The wire protocol itself is in `main/streamKit/protocol`
 */

export type Campaign = { id: string; name: string };

export type Repeat = "off" | "playlist" | "track";

export type Library = {
  playlists: {
    id: string;
    title: string;
    tracks: { id: string; title: string }[];
  }[];
  soundboards: {
    id: string;
    title: string;
    sounds: { id: string; title: string }[];
  }[];
};

export type NowPlaying = {
  playing: boolean;
  track: {
    id: string;
    title: string;
    playlistId: string | null;
    playlistTitle: string | null;
    durationMs: number | null;
    positionMs: number | null;
  } | null;
};

/** The part of the status the player knows, the main process adds the outputs */
export type PlayerStatus = {
  music: { volume: number; muted: boolean; shuffle: boolean; repeat: Repeat };
  sfx: { volume: number };
};

export type Status = PlayerStatus & {
  outputs: { discord: boolean; streamKit: boolean };
};

export type Command =
  | { kind: "play-playlist"; playlistId: string }
  | { kind: "play-track"; playlistId: string; trackId: string }
  | { kind: "playback"; action: "play" | "pause" | "next" | "previous" }
  | { kind: "music-volume"; volume: number }
  | { kind: "play-sound"; soundboardId: string; soundId: string }
  | { kind: "stop-sounds" };

/** Where the player's Voice Room publishing has got to */
export type VoiceRoomState =
  | { status: "off" }
  | { status: "connecting" }
  | { status: "publishing" }
  | { status: "reconnecting" }
  | { status: "error"; message: string };

/** Everything the main window shows about the Stream Kit */
export type StreamKitState = {
  url: string;
  /** Whether a token is saved, the token itself never leaves the main process */
  paired: boolean;
  /** Whether music and effects are published into the Voice Room */
  enabled: boolean;
  connection:
    | { status: "idle" }
    | { status: "connecting"; pairing: boolean }
    | { status: "connected"; campaign: Campaign }
    | { status: "refused"; reason: string }
    | { status: "failed"; reason: string };
  /** The Campaign last connected to, shown while reconnecting */
  campaign: Campaign | null;
  /** False when the Stream Kit has no Voice Room set up for the Campaign */
  voiceAvailable: boolean | null;
  voice: VoiceRoomState;
  discord: boolean;
};
