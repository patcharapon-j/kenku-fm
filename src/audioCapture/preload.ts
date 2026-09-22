import { ipcRenderer } from "electron";

import {
  AudioCaptureManagerPreload,
  StreamingMode,
} from "../preload/managers/AudioCaptureManagerPreload";

const audioCaptureManager = new AudioCaptureManagerPreload();

ipcRenderer.on(
  "AUDIO_CAPTURE_START_BROWSER_VIEW_STREAM",
  (_, viewId: number, mediaSourceId: string, isPlayer: boolean) => {
    audioCaptureManager.startBrowserViewStream(viewId, mediaSourceId, isPlayer);
  }
);

ipcRenderer.on(
  "AUDIO_CAPTURE_STOP_BROWSER_VIEW_STREAM",
  (_, viewId: number) => {
    audioCaptureManager.stopBrowserViewStream(viewId);
  }
);

// The handlers above wire each browser view up individually, this handles the
// case where they are all removed at once
ipcRenderer.on("AUDIO_CAPTURE_STOP_ALL_BROWSER_VIEW_STREAMS", () => {
  audioCaptureManager.stopAllBrowserViewStreams();
});

ipcRenderer.on(
  "AUDIO_CAPTURE_BROWSER_VIEW_MUTED",
  (_, viewId: number, muted: boolean) => {
    audioCaptureManager.setMuted(viewId, muted);
  }
);

ipcRenderer.on("AUDIO_CAPTURE_SET_LOOPBACK", (_, loopback: boolean) => {
  audioCaptureManager.setLoopback(loopback);
});

ipcRenderer.on(
  "AUDIO_CAPTURE_START_EXTERNAL_AUDIO_CAPTURE",
  (_, deviceId: string) => {
    audioCaptureManager.startExternalAudioCapture(deviceId);
  }
);

ipcRenderer.on(
  "AUDIO_CAPTURE_STOP_EXTERNAL_AUDIO_CAPTURE",
  (_, deviceId: string) => {
    audioCaptureManager.stopExternalAudioCapture(deviceId);
  }
);

ipcRenderer.on("AUDIO_CAPTURE_START", (_, streamingMode: StreamingMode) => {
  audioCaptureManager.start(streamingMode);
});

ipcRenderer.on("AUDIO_CAPTURE_SET_BITRATE", (_, bitrate?: number) => {
  audioCaptureManager.setBitrate(bitrate);
});

ipcRenderer.on(
  "AUDIO_CAPTURE_SET_VIEW_GAIN",
  (_, viewId: number, gain: number) => {
    audioCaptureManager.setViewGain(viewId, gain);
  }
);

ipcRenderer.on(
  "AUDIO_CAPTURE_SET_EXTERNAL_GAIN",
  (_, deviceId: string, gain: number) => {
    audioCaptureManager.setExternalGain(deviceId, gain);
  }
);

ipcRenderer.on("AUDIO_CAPTURE_SET_MONITOR_GAIN", (_, gain: number) => {
  audioCaptureManager.setMonitorGain(gain);
});

ipcRenderer.on("AUDIO_CAPTURE_SET_MONITOR_DEVICE", (_, deviceId: string) => {
  audioCaptureManager.setMonitorDevice(deviceId);
});

ipcRenderer.on("AUDIO_CAPTURE_SET_NORMALIZE", (_, enabled: boolean) => {
  audioCaptureManager.setNormalize(enabled);
});
