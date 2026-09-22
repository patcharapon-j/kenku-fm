const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");
const ffmpeg = require("ffmpeg-static");

function load(file, overrides = {}) {
  const absolute = path.resolve(file);
  const code = ts.transpileModule(fs.readFileSync(absolute, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: (name) => overrides[name] ?? require(name),
    console,
    Buffer,
    setTimeout,
    clearTimeout,
  });
  return exports;
}
const { filterLibrary, cleanTags } = load(
  "src/player/features/library/libraryFilter.ts",
);
test("search combines words and tags, sorts without mutating saved order, tolerates legacy items", () => {
  const input = [
    { title: "Rain storm", tags: ["Weather", "Night"] },
    { title: "Battle", tags: ["combat"] },
    { title: "Rain cave" },
  ];
  assert.equal(filterLibrary(input, "RAIN night", "", "manual").length, 1);
  assert.equal(
    filterLibrary(input, "", "weather", "manual")[0].title,
    "Rain storm",
  );
  assert.equal(filterLibrary(input, "missing", "", "title").length, 0);
  assert.equal(filterLibrary(input, "", "", "title")[0].title, "Battle");
  assert.equal(input[0].title, "Rain storm");
  assert.equal(
    cleanTags([" Rain ", "rain", "", "NIGHT"]).join(","),
    "rain,night",
  );
});

test("whole-file normalization preserves dynamics, matches levels, caches, and rejects missing files", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "kenku-normalization-"),
  );
  const { normalizeAudio, normalizationGain } = load(
    "src/main/audioNormalization.ts",
    { electron: { app: { getPath: () => directory } } },
  );
  const url = (file) => `file://${encodeURIComponent(file)}`;
  try {
    assert.equal(normalizationGain(-30, -2), 1);
    assert.equal(normalizationGain(-10, -1), -6);
    assert.equal(normalizationGain(-Infinity, -Infinity), 0);
    const first = path.join(directory, "quiet # track.wav");
    const second = path.join(directory, "louder.wav");
    for (const [file, level] of [
      [first, 0.04],
      [second, 0.16],
    ]) {
      execFileSync(ffmpeg, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `aevalsrc=${level}*sin(2*PI*440*t)*if(lt(t\\,1)\\,0.5\\,1):s=48000:d=2`,
        "-c:a",
        "pcm_f32le",
        file,
      ]);
    }
    const a = await normalizeAudio(url(first));
    const b = await normalizeAudio(url(second));
    assert.ok(Math.abs(a.gainDb - b.gainDb - 12.04) < 0.1);
    const decode = (file) => {
      const buffer = execFileSync(ffmpeg, [
        "-v",
        "error",
        "-i",
        file,
        "-f",
        "f32le",
        "-ac",
        "1",
        "-",
      ]);
      return new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength / 4,
      );
    };
    const original = decode(first),
      processed = decode(decodeURIComponent(a.url.slice(7)));
    assert.equal(processed.length, original.length);
    const gain = 10 ** (a.gainDb / 20);
    for (let i = 0; i < original.length; i += 101)
      assert.ok(
        Math.abs(processed[i] - original[i] * gain) < 0.00001,
        "Every sample uses the same gain",
      );
    assert.equal((await normalizeAudio(url(first))).url, a.url);
    assert.ok(fs.existsSync(first));
    const silent = path.join(directory, "silent.wav");
    execFileSync(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      "0.1",
      silent,
    ]);
    assert.equal((await normalizeAudio(url(silent))).gainDb, 0);
    await assert.rejects(
      normalizeAudio(url(path.join(directory, "missing.wav"))),
    );
    await assert.rejects(normalizeAudio("https://example.com/audio.mp3"));
    assert.equal(
      (await normalizeAudio(url(second))).url,
      b.url,
      "Failure does not poison the queue",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("live leveling changes browser audio but bypasses player input", () => {
  let Processor;
  const context = {
    sampleRate: 48000,
    Float32Array,
    Math,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage() {} };
      }
    },
    registerProcessor: (_, value) => {
      Processor = value;
    },
  };
  vm.runInNewContext(
    fs.readFileSync("src/preload/managers/PCMStream.worklet.js", "utf8"),
    context,
  );
  const processor = new Processor({
    processorOptions: {
      framesPerBlock: 960,
      lookahead: 1,
      releaseSamples: 10,
      ceiling: 0.98,
      normalize: {
        enabled: true,
        targetLufs: -16,
        maxGainDb: 12,
        minGainDb: -12,
        upDbPerSecond: 1,
        downDbPerSecond: 1,
      },
    },
  });
  processor._normalizer.process = () => 2;
  const seen = [];
  processor._limiter.process = (left, right) => seen.push([left, right]);
  processor.process(
    [
      [Float32Array.of(0.1), Float32Array.of(0.2)],
      [Float32Array.of(0.3), Float32Array.of(0.4)],
    ],
    [[new Float32Array(1), new Float32Array(1)]],
  );
  assert.ok(Math.abs(seen[0][0] - 0.5) < 0.000001);
  assert.ok(Math.abs(seen[0][1] - 0.8) < 0.000001);
  processor.process(
    [[], [Float32Array.of(0.3)]],
    [[new Float32Array(1), new Float32Array(1)]],
  );
  assert.ok(Math.abs(seen[1][0] - 0.3) < 0.000001);
  assert.ok(Math.abs(seen[1][1] - 0.3) < 0.000001);
});
