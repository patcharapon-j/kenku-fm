const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const EventEmitter = require("node:events");
const ts = require("typescript");

function loadTs(file, overrides = {}, globals = {}) {
  const absolute = path.resolve(file);
  const dir = path.dirname(absolute);
  const code = ts.transpileModule(fs.readFileSync(absolute, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const moduleObj = { exports: {} };
  const sandbox = {
    module: moduleObj,
    exports: moduleObj.exports,
    require: (name) => {
      if (name in overrides) {
        return overrides[name];
      }
      if (name.startsWith(".")) {
        const resolved = path.resolve(dir, name);
        for (const candidate of [
          resolved,
          `${resolved}.ts`,
          `${resolved}.tsx`,
          `${resolved}.js`,
          path.join(resolved, "index.ts"),
        ]) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
              return loadTs(candidate, overrides, globals);
            }
            return require(candidate);
          }
        }
      }
      return require(name);
    },
    console,
    Buffer,
    URL,
    Float32Array,
    Int16Array,
    Uint8Array,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ...globals,
  };
  vm.runInNewContext(code, sandbox, { filename: absolute });
  return moduleObj.exports;
}

class FakeAudioElement {
  constructor() {
    this.src = "";
    this.srcObject = null;
    this.crossOrigin = null;
    this.preload = "";
    this.loop = false;
    this.volume = 1;
    this.muted = false;
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = 120;
    this.readyState = 4;
    this.sinkId = "";
    this.sinkHistory = [];
    this._listeners = new Map();
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set());
    }
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }

  dispatch(type) {
    for (const fn of this._listeners.get(type) ?? []) {
      fn();
    }
  }

  load() {}

  removeAttribute(name) {
    if (name === "src") {
      this.src = "";
    }
  }

  play() {
    this.paused = false;
    this.ended = false;
    this.dispatch("play");
    return Promise.resolve();
  }

  pause() {
    if (!this.paused) {
      this.paused = true;
      this.dispatch("pause");
    }
  }

  async setSinkId(id) {
    this.sinkId = id;
    this.sinkHistory.push(id);
  }
}

class FakeAudioParam {
  constructor(initial = 1) {
    this.value = initial;
    this.targets = [];
  }

  setTargetAtTime(target, startTime, timeConstant) {
    this.value = target;
    this.targets.push({ target, startTime, timeConstant });
  }
}

class FakeNode {
  constructor(type) {
    this.type = type;
    this.connections = [];
    this.disconnected = false;
  }

  connect(dest, outputIndex, inputIndex) {
    this.connections.push({ dest, outputIndex, inputIndex });
    return dest;
  }

  disconnect() {
    this.disconnected = true;
    this.connections = [];
  }
}

class FakeAudioContext {
  constructor(options = {}) {
    this.options = options;
    this.sampleRate = options.sampleRate ?? 48000;
    this.currentTime = 1;
    this.state = "running";
    this.closed = false;
    this.createdNodes = [];
    FakeAudioContext.instances.push(this);
  }

  createGain() {
    const node = new FakeNode("gain");
    node.gain = new FakeAudioParam(1);
    this.createdNodes.push(node);
    return node;
  }

  createAnalyser() {
    const node = new FakeNode("analyser");
    node.fftSize = 256;
    node.sampleValue = 0.42;
    node.getFloatTimeDomainData = (arr) => {
      arr.fill(node.sampleValue);
    };
    this.createdNodes.push(node);
    return node;
  }

  createMediaStreamDestination() {
    const node = new FakeNode("destination");
    node.stream = { id: `stream-${this.createdNodes.length}` };
    this.createdNodes.push(node);
    return node;
  }

  createMediaElementSource(element) {
    const node = new FakeNode("element-source");
    node.element = element;
    this.createdNodes.push(node);
    return node;
  }

  resume() {
    this.state = "running";
    return Promise.resolve();
  }

  close() {
    this.closed = true;
    return Promise.resolve();
  }
}
FakeAudioContext.instances = [];

test("PreviewManager authorizes only the registered player main frame and resolves local media URLs safely", () => {
  const ipcMain = new EventEmitter();
  const sentToPlayer = [];
  const captureCalls = [];
  const audioCaptureManager = new EventEmitter();
  audioCaptureManager.previewLoad = (cmd) => captureCalls.push(["load", cmd]);
  audioCaptureManager.previewPlay = () => captureCalls.push(["play"]);
  audioCaptureManager.previewPause = () => captureCalls.push(["pause"]);
  audioCaptureManager.previewStop = () => captureCalls.push(["stop"]);
  audioCaptureManager.previewSeek = (to) => captureCalls.push(["seek", to]);
  audioCaptureManager.previewSetVolume = (v) => captureCalls.push(["volume", v]);
  audioCaptureManager.previewSetMuted = (m) => captureCalls.push(["muted", m]);
  audioCaptureManager.previewSetDuck = (d) => captureCalls.push(["duck", d]);

  const playerMainFrame = { id: "main-frame" };
  const playerSubFrame = { id: "sub-frame" };
  const playerView = {
    id: 42,
    mainFrame: playerMainFrame,
    isDestroyed: () => false,
    send: (channel, payload) => sentToPlayer.push([channel, payload]),
  };
  const playerManager = {
    registeredViewId: 42,
    getView: () => playerView,
  };

  const { PreviewManager, resolvePreviewURL } = loadTs(
    "src/main/managers/PreviewManager.ts",
    {
      electron: { ipcMain },
      "../mediaProtocol": {
        getMediaURL: (filePath) =>
          `kenku-media://local/secret-token/${encodeURIComponent(filePath)}`,
      },
    },
  );

  assert.equal(
    resolvePreviewURL("file://%2Fmusic%2Fbattle%20theme.mp3"),
    "kenku-media://local/secret-token/%2Fmusic%2Fbattle%20theme.mp3",
  );
  assert.equal(
    resolvePreviewURL("https://example.com/audio.mp3"),
    "https://example.com/audio.mp3",
  );
  assert.equal(resolvePreviewURL("javascript:alert(1)"), null);
  assert.equal(resolvePreviewURL("data:audio/wav;base64,AAAA"), null);

  const manager = new PreviewManager(playerManager, audioCaptureManager);

  // Untrusted tab must be ignored
  const tabEvent = {
    sender: { id: 99, mainFrame: playerMainFrame },
    senderFrame: playerMainFrame,
  };
  ipcMain.emit("PLAYER_PREVIEW_LOAD", tabEvent, {
    url: "file://%2Fetc%2Fpasswd",
    volume: 1,
    muted: false,
    duckLiveMonitor: true,
    requestId: 1,
  });
  ipcMain.emit("PLAYER_PREVIEW_PLAY", tabEvent);
  assert.equal(captureCalls.length, 0);

  // Subframe inside player must also be ignored
  const subFrameEvent = { sender: playerView, senderFrame: playerSubFrame };
  ipcMain.emit("PLAYER_PREVIEW_LOAD", subFrameEvent, {
    url: "file://%2Fmusic%2Ftrack.flac",
    volume: 1,
    muted: false,
    duckLiveMonitor: true,
    requestId: 2,
  });
  assert.equal(captureCalls.length, 0);

  // Registered player main frame succeeds and resolves file:// -> kenku-media://
  const playerEvent = { sender: playerView, senderFrame: playerMainFrame };
  ipcMain.emit("PLAYER_PREVIEW_LOAD", playerEvent, {
    url: "file://%2Fmusic%2Ftavern.flac",
    volume: 0.75,
    muted: false,
    duckLiveMonitor: true,
    requestId: 3,
  });
  assert.equal(captureCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(captureCalls[0])), [
    "load",
    {
      url: "kenku-media://local/secret-token/%2Fmusic%2Ftavern.flac",
      volume: 0.75,
      muted: false,
      duckLiveMonitor: true,
      requestId: 3,
    },
  ]);

  // Unsupported scheme from player returns an error state and does not reach capture
  ipcMain.emit("PLAYER_PREVIEW_LOAD", playerEvent, {
    url: "javascript:void(0)",
    volume: 0.75,
    muted: false,
    duckLiveMonitor: true,
    requestId: 4,
  });
  assert.equal(captureCalls.length, 1);
  assert.equal(sentToPlayer.length, 1);
  assert.equal(sentToPlayer[0][0], "PLAYER_PREVIEW_STATE");
  assert.equal(sentToPlayer[0][1].requestId, 4);
  assert.ok(sentToPlayer[0][1].error);

  // Engine state from AudioCaptureManagerMain forwards to player view
  const engineState = {
    requestId: 3,
    loading: false,
    playing: true,
    progress: 12.5,
    duration: 180,
    ended: false,
    level: 0.5,
  };
  audioCaptureManager.emit("previewState", engineState);
  assert.deepEqual(sentToPlayer[1], ["PLAYER_PREVIEW_STATE", engineState]);

  manager.destroy();
  ipcMain.emit("PLAYER_PREVIEW_STOP", playerEvent);
  assert.equal(captureCalls.length, 1);
});

test("PreviewAudioEngine isolates local preview on its own AudioContext, follows monitor device, and handles remote fallback", async () => {
  FakeAudioContext.instances = [];
  const createdElements = [];
  const states = [];
  const playingChanges = [];

  const { PreviewAudioEngine } = loadTs(
    "src/preload/managers/PreviewAudioEngine.ts",
    {},
    {
      AudioContext: FakeAudioContext,
      HTMLMediaElement: { HAVE_NOTHING: 0 },
      DOMException: class FakeDOMException extends Error {},
      document: {
        createElement: (tag) => {
          assert.equal(tag, "audio");
          const el = new FakeAudioElement();
          createdElements.push(el);
          return el;
        },
      },
    },
  );

  const engine = new PreviewAudioEngine({
    onState: (s) => states.push(s),
    onPlayingChange: (p) => playingChanges.push(p),
  });

  // Choosing monitor device before first preview must persist onto output sink
  await engine.setMonitorDevice("gm-headphones");

  engine.load({
    url: "kenku-media://local/tok/%2Fmusic%2Fboss.flac",
    volume: 0.6,
    muted: false,
    duckLiveMonitor: true,
    requestId: 10,
  });

  assert.equal(FakeAudioContext.instances.length, 1);
  // First created element is the preview source, second is the graph sink output
  // (ensurePreviewGraph runs after source element is created)
  const sourceEl = createdElements[0];
  const outputEl = createdElements[1];
  assert.equal(sourceEl.crossOrigin, "anonymous");
  assert.equal(outputEl.muted, false);
  assert.equal(outputEl.sinkId, "gm-headphones");
  assert.deepEqual(playingChanges, [true]);

  const diag = engine.getDiagnostics();
  assert.equal(diag.routable, true);
  assert.equal(diag.playing, true);
  assert.equal(diag.sinkId, "gm-headphones");
  assert.equal(diag.outputMuted, false);
  assert.ok(diag.peakLevel > 0.4);

  // Switching monitor device updates sinkId immediately
  await engine.setMonitorDevice("usb-dac");
  assert.equal(outputEl.sinkId, "usb-dac");

  // Pending seek before metadata is held and applied on loadedmetadata
  sourceEl.readyState = 0;
  engine.seek(35);
  sourceEl.readyState = 4;
  sourceEl.dispatch("loadedmetadata");
  assert.equal(sourceEl.currentTime, 35);

  // Pausing and ending both notify onPlayingChange(false)
  engine.pause();
  assert.deepEqual(playingChanges, [true, false]);
  engine.play();
  assert.deepEqual(playingChanges, [true, false, true]);
  sourceEl.ended = true;
  sourceEl.paused = true;
  sourceEl.dispatch("ended");
  assert.deepEqual(playingChanges, [true, false, true, false]);
  assert.equal(sourceEl.currentTime, 0);

  // Loading a non-CORS remote URL falls back to direct element without crossOrigin
  engine.load({
    url: "https://example.com/ambience.mp3",
    volume: 0.5,
    muted: false,
    duckLiveMonitor: true,
    requestId: 11,
  });
  const remoteEl = createdElements[2];
  assert.equal(remoteEl.crossOrigin, null);
  assert.equal(remoteEl.volume, 0.5);
  assert.equal(remoteEl.sinkId, "usb-dac");
  assert.equal(engine.getDiagnostics().routable, false);

  engine.destroy();
  assert.equal(FakeAudioContext.instances[0].closed, true);
});

test("AudioCaptureManagerPreload ducks only the local monitor post-worklet and keeps preview audible when This Computer is unticked", async () => {
  FakeAudioContext.instances = [];
  const createdElements = [];
  const sentIpc = [];
  const ipcRenderer = {
    send: (channel, ...args) => sentIpc.push([channel, ...args]),
    once: () => {},
  };

  const { AudioCaptureManagerPreload } = loadTs(
    "src/preload/managers/AudioCaptureManagerPreload.ts",
    {
      electron: { ipcRenderer },
      "./PCMStream.worklet": "mock-worklet.js",
    },
    {
      AudioContext: FakeAudioContext,
      HTMLMediaElement: { HAVE_NOTHING: 0 },
      DOMException: class FakeDOMException extends Error {},
      document: {
        createElement: () => {
          const el = new FakeAudioElement();
          createdElements.push(el);
          return el;
        },
      },
    },
  );

  const capture = new AudioCaptureManagerPreload();
  // Wire minimal live capture graph matching `_setupLoopback`
  capture._audioContext = new FakeAudioContext();
  capture._pcmStreamNode = new FakeNode("pcm-worklet");
  await capture._setupLoopback();

  const liveOutputElement = capture._audioOutputElement;
  const monitorGainNode = capture._monitorGainNode;
  const duckGainNode = capture._monitorDuckGainNode;

  // Verify graph topology: _pcmStreamNode -> _monitorGainNode -> _monitorDuckGainNode -> mediaDestination
  // Nothing from preview ever connects into _pcmStreamNode.
  assert.equal(capture._pcmStreamNode.connections[0].dest, monitorGainNode);
  assert.equal(monitorGainNode.connections[0].dest, duckGainNode);
  assert.equal(duckGainNode.gain.value, 1);

  // Untick "This Computer" (loopback = false) and pick monitor device
  capture.setLoopback(false);
  await capture.setMonitorDevice("gm-headset");
  assert.equal(liveOutputElement.muted, true);
  assert.equal(liveOutputElement.sinkId, "gm-headset");

  // Start a preview: preview plays on its own unmuted sink on the same monitor device
  capture.previewLoad({
    url: "kenku-media://local/tok/%2Fmusic%2Fcheck.flac",
    volume: 0.9,
    muted: false,
    duckLiveMonitor: true,
    requestId: 1,
  });

  // Live monitor ducking engages (0.25), while live loopback remains muted
  assert.equal(duckGainNode.gain.value, 0.25);
  assert.equal(liveOutputElement.muted, true);
  // Preview output stays unmuted on the chosen monitor device
  const previewDiag = capture._previewEngine.getDiagnostics();
  assert.equal(previewDiag.playing, true);
  assert.equal(previewDiag.outputMuted, false);
  assert.equal(previewDiag.sinkId, "gm-headset");
  // Preview runs in a separate AudioContext from the live broadcast context
  assert.equal(FakeAudioContext.instances.length, 2);
  assert.notEqual(
    FakeAudioContext.instances[0],
    FakeAudioContext.instances[1],
  );

  // Turning off ducking restores live monitor gain to 1 while preview keeps playing
  capture.previewSetDuck(false);
  assert.equal(duckGainNode.gain.value, 1);
  assert.equal(capture._previewEngine.getDiagnostics().playing, true);

  // Re-enabling ducking ducks live monitor again, and stopping preview restores it to 1
  capture.previewSetDuck(true);
  assert.equal(duckGainNode.gain.value, 0.25);
  capture.previewStop();
  assert.equal(duckGainNode.gain.value, 1);

  capture._previewEngine.destroy();
});

test("previewSlice tracks active preview, drops stale requestIds, and clamps settings", () => {
  const {
    default: reducer,
    startPreview,
    syncPreviewEngine,
    clearPreview,
    setPreviewVolume,
    setPreviewMuted,
    setPreviewDuckLiveMonitor,
    updatePreviewItemMeta,
  } = loadTs("src/player/features/preview/previewSlice.ts");

  let state = reducer(undefined, { type: "@@INIT" });
  assert.equal(state.item, null);
  assert.equal(state.duckLiveMonitor, true);

  state = reducer(
    state,
    startPreview({
      requestId: 2,
      item: {
        id: "t1",
        kind: "track",
        title: "Tavern",
        parentId: "p1",
        parentTitle: "Town",
        url: "file://%2Ftavern.flac",
      },
    }),
  );
  assert.equal(state.item.title, "Tavern");
  assert.equal(state.loading, true);

  // Stale requestId=1 is ignored
  state = reducer(
    state,
    syncPreviewEngine({
      requestId: 1,
      loading: false,
      playing: true,
      progress: 40,
      duration: 100,
      ended: false,
      level: 0.5,
    }),
  );
  assert.equal(state.playing, false);
  assert.equal(state.progress, 0);

  // Matching requestId=2 updates state
  state = reducer(
    state,
    syncPreviewEngine({
      requestId: 2,
      loading: false,
      playing: true,
      progress: 18,
      duration: 90,
      ended: false,
      level: 0.6,
    }),
  );
  assert.equal(state.playing, true);
  assert.equal(state.progress, 18);
  assert.equal(state.duration, 90);

  state = reducer(
    state,
    updatePreviewItemMeta({ title: "Cozy Tavern", parentTitle: "Village" }),
  );
  assert.equal(state.item.title, "Cozy Tavern");
  assert.equal(state.item.parentTitle, "Village");

  state = reducer(state, setPreviewVolume(1.5));
  assert.equal(state.volume, 1);
  state = reducer(state, setPreviewVolume(-0.2));
  assert.equal(state.volume, 0);
  state = reducer(state, setPreviewMuted(true));
  assert.equal(state.muted, true);
  state = reducer(state, setPreviewDuckLiveMonitor(false));
  assert.equal(state.duckLiveMonitor, false);

  state = reducer(state, clearPreview());
  assert.equal(state.item, null);
  assert.equal(state.playing, false);
  // Persisted preferences survive closing the preview deck
  assert.equal(state.muted, true);
  assert.equal(state.duckLiveMonitor, false);
});
