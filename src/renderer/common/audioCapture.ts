/** Peak levels for the master capture mix */
export type CaptureLevels = {
  /** Linear peak, 1 is full scale */
  peakLeft: number;
  peakRight: number;
  clipped: boolean;
  /** Limiter gain reduction in dB, negative while the limiter is working */
  reduction: number;
  /** Loudness normalization gain in dB, 0 when it is off or idle */
  normalization: number;
};

export type CaptureEncoding = "opus-webcodecs" | "opus-native" | "opus-js";

export type CaptureEncoder = {
  encoding: CaptureEncoding;
  detail: string;
};

export const encodingLabels: Record<CaptureEncoding, string> = {
  "opus-webcodecs": "WebCodecs Opus",
  "opus-native": "Native Opus",
  "opus-js": "JavaScript Opus",
};

/** A source can be pushed above the mix as well as pulled under it, so unity sits mid travel */
export const UNITY_GAIN = 1;
export const MAX_GAIN = 2;

/** Quiet enough to read as silence without wasting most of the meter on inaudible detail */
export const METER_FLOOR_DB = -60;
/** Reduction past this point is a mix problem rather than the limiter doing its job */
/** Range the normalizer is allowed to move the mix by, which bounds its meter */
export const MAX_NORMALIZE_DB = 12;
export const MAX_REDUCTION_DB = 20;

export function peakToDb(peak: number): number {
  if (peak <= 0) {
    return METER_FLOOR_DB;
  }
  return 20 * Math.log10(peak);
}

/** Position of a dB value along the meter, clamped so peaks over full scale still read as full */
export function dbToMeterPercent(db: number): number {
  const percent = ((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100;
  return Math.min(Math.max(percent, 0), 100);
}
