import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import { PreviewEngineState, PreviewItem } from "../../../types/preview";

export interface PreviewState {
  /** Currently loaded preview item, or null when the preview deck is closed */
  item: PreviewItem | null;
  /** Monotonic request id so stale engine events from an earlier preview are ignored */
  requestId: number;
  loading: boolean;
  playing: boolean;
  /** Current playback position in seconds */
  progress: number;
  /** Total duration in seconds */
  duration: number;
  ended: boolean;
  /** Instantaneous preview output peak (0..1) */
  level: number;
  /** Independent preview volume (0..1), persisted across restarts */
  volume: number;
  /** Independent preview mute, persisted across restarts */
  muted: boolean;
  /** Whether to duck the live local monitor while preview plays, persisted */
  duckLiveMonitor: boolean;
}

const initialState: PreviewState = {
  item: null,
  requestId: 0,
  loading: false,
  playing: false,
  progress: 0,
  duration: 0,
  ended: false,
  level: 0,
  volume: 0.85,
  muted: false,
  duckLiveMonitor: true,
};

export const previewSlice = createSlice({
  name: "preview",
  initialState,
  reducers: {
    startPreview: (
      state,
      action: PayloadAction<{ item: PreviewItem; requestId: number }>,
    ) => {
      state.item = action.payload.item;
      state.requestId = action.payload.requestId;
      state.loading = true;
      state.playing = false;
      state.progress = 0;
      state.duration = 0;
      state.ended = false;
      state.level = 0;
    },
    syncPreviewEngine: (state, action: PayloadAction<PreviewEngineState>) => {
      const update = action.payload;
      if (!state.item || update.requestId !== state.requestId) {
        return;
      }
      state.loading = update.loading;
      state.playing = update.playing;
      state.progress = update.progress;
      state.duration = update.duration;
      state.ended = update.ended;
      state.level = update.level;
    },
    updatePreviewItemMeta: (
      state,
      action: PayloadAction<{ title: string; parentTitle: string }>,
    ) => {
      if (!state.item) {
        return;
      }
      state.item.title = action.payload.title;
      state.item.parentTitle = action.payload.parentTitle;
    },
    clearPreview: (state) => {
      state.item = null;
      state.loading = false;
      state.playing = false;
      state.progress = 0;
      state.duration = 0;
      state.ended = false;
      state.level = 0;
    },
    setPreviewVolume: (state, action: PayloadAction<number>) => {
      const value = action.payload;
      state.volume = Number.isFinite(value)
        ? Math.min(Math.max(value, 0), 1)
        : 0.85;
    },
    setPreviewMuted: (state, action: PayloadAction<boolean>) => {
      state.muted = action.payload;
    },
    setPreviewDuckLiveMonitor: (state, action: PayloadAction<boolean>) => {
      state.duckLiveMonitor = action.payload;
    },
  },
});

export const {
  startPreview,
  syncPreviewEngine,
  updatePreviewItemMeta,
  clearPreview,
  setPreviewVolume,
  setPreviewMuted,
  setPreviewDuckLiveMonitor,
} = previewSlice.actions;

export default previewSlice.reducer;
