export type PreviewItemKind = "track" | "sound";

export interface PreviewItem {
  id: string;
  kind: PreviewItemKind;
  title: string;
  /** Parent playlist or soundboard id, used when promoting a preview to live */
  parentId: string;
  parentTitle: string;
  /** Stored or normalized media URL; local file:// URLs are resolved in main */
  url: string;
}

export interface PreviewLoadCommand {
  url: string;
  volume: number;
  muted: boolean;
  duckLiveMonitor: boolean;
  /** Monotonic id so stale events from a superseded preview are ignored */
  requestId: number;
}

export interface PreviewEngineState {
  requestId: number;
  loading: boolean;
  playing: boolean;
  /** Current playback position in seconds */
  progress: number;
  /** Total duration in seconds */
  duration: number;
  ended: boolean;
  /** Instantaneous peak level (0..1) on the local preview bus, when routable */
  level: number;
  error?: string;
}
