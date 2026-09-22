import { app } from "electron";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";

export interface Normalization {
  source: string;
  url: string;
  gainDb: number;
  version: number;
}
const VERSION = 1;
const inFlight = new Map<string, Promise<Normalization>>();

/**
 * How many files are measured and encoded at once.
 *
 * ffmpeg is close to single threaded for this work, so importing a folder or
 * levelling a whole library is bound by how many processes run side by side.
 * Half the cores keeps the rest for playback and the interface, and the cap
 * stops a large machine from spawning more processes than the disk can feed.
 */
function defaultConcurrency(): number {
  const cores = os.cpus()?.length || 2;
  return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

export const normalizationConcurrency = defaultConcurrency();

let active = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (active < normalizationConcurrency) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  // Hand the slot straight to the next job so the count stays accurate
  const next = waiting.shift();
  if (next) next();
  else active--;
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath)
      return reject(new Error("Audio processor unavailable on this platform"));
    const child = spawn(
      ffmpegPath.replace("app.asar/", "app.asar.unpacked/"),
      ["-nostdin", "-hide_banner", "-nostats", ...args],
      { windowsHide: true },
    );
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-32768);
    });
    child.stdout.resume();
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(stderr)
        : reject(
            new Error(
              "Unable to process audio. Check that the file is readable and contains supported audio.",
            ),
          ),
    );
  });
}

/** One fixed gain for the entire file. A true-peak ceiling takes priority over the loudness target. */
export function normalizationGain(lufs: number, peak: number): number {
  if (!Number.isFinite(lufs) || !Number.isFinite(peak)) return 0;
  return Math.min(-16 - lufs, -1 - peak, 24);
}

export function normalizeAudio(source: string): Promise<Normalization> {
  if (typeof source !== "string" || !source.startsWith("file://"))
    return Promise.reject(new Error("Only local audio files can be processed"));
  const existing = inFlight.get(source);
  if (existing) return existing;
  const job = (async () => {
    await acquire();
    try {
      // Stored URLs use encodeFilePath, including Windows drive letters.
      const input = decodeURIComponent(source.slice(7));
      const stat = await fs.promises.stat(input);
      if (!stat.isFile()) throw new Error("Select an audio file");
      const key = crypto
        .createHash("sha256")
        .update(JSON.stringify([input, stat.size, stat.mtimeMs, VERSION]))
        .digest("hex");
      const directory = path.join(app.getPath("userData"), "normalized-audio");
      await fs.promises.mkdir(directory, { recursive: true });
      const output = path.join(directory, `${key}.flac`);
      const metadata = `${output}.json`;
      try {
        const cached = JSON.parse(
          await fs.promises.readFile(metadata, "utf8"),
        ) as Normalization;
        await fs.promises.access(output);
        return cached;
      } catch {
        /* Missing or interrupted cache entry: rebuild it. */
      }
      const report = await run([
        "-i",
        input,
        "-map",
        "0:a:0",
        "-af",
        "apad=pad_dur=0.4,loudnorm=I=-16:TP=-1:print_format=json",
        "-f",
        "null",
        "-",
      ]);
      const match = report.match(/\{\s*"input_i"[\s\S]*?\}/);
      if (!match) throw new Error("Unable to measure audio loudness");
      const measured = JSON.parse(match[0]);
      const gainDb = normalizationGain(
        Number(measured.input_i),
        Number(measured.input_tp),
      );
      // Unique per job. The same file can be queued under two URL spellings,
      // which the in flight map won't match but the cache key will, and in
      // parallel a shared temporary would let one encode overwrite the other.
      const suffix = crypto.randomBytes(6).toString("hex");
      const temporary = `${output}.${suffix}.tmp.flac`;
      try {
        await run([
          "-y",
          "-i",
          input,
          "-map",
          "0:a:0",
          "-vn",
          "-af",
          `volume=${gainDb}dB`,
          "-c:a",
          "flac",
          "-sample_fmt",
          "s32",
          temporary,
        ]);
        await fs.promises.rename(temporary, output);
        const result = {
          source,
          url: `file://${encodeURIComponent(output)}`,
          gainDb,
          version: VERSION,
        };
        await fs.promises.writeFile(metadata, JSON.stringify(result));
        return result;
      } finally {
        await fs.promises.unlink(temporary).catch(() => {});
      }
    } finally {
      release();
    }
  })();
  inFlight.set(source, job);
  void job.finally(() => inFlight.delete(source)).catch(() => {});
  return job;
}
