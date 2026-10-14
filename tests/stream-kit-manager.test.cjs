const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const ts = require("typescript");

const { createMockStreamKit } = require("../scripts/stream-kit-mock-server.cjs");

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
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  return exports;
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Just enough of Electron for the manager: IPC, a window and a player view */
function fakeElectron() {
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (channel, fn) => handlers.set(channel, fn);
  ipcMain.removeHandler = (channel) => handlers.delete(channel);

  const windowSent = [];
  const windowContents = {
    send: (channel, ...args) => windowSent.push({ channel, args }),
  };
  const window = { webContents: windowContents, isDestroyed: () => false };

  const playerSent = [];
  const playerContents = { id: 7, mainFrame: {} };
  playerContents.send = (channel, ...args) =>
    playerSent.push({ channel, args: plain(args) });
  playerContents.isDestroyed = () => false;
  const playerManager = {
    registeredViewId: 7,
    getView: () => playerContents,
  };

  const saved = new Map();
  class Store {
    get(key) {
      return saved.get(key);
    }
    set(key, value) {
      saved.set(key, plain(value));
    }
  }

  return {
    electron: { app: { getVersion: () => "2.2.1" }, ipcMain },
    Store,
    saved,
    window,
    playerManager,
    windowSent,
    playerSent,
    fromWindow: { sender: windowContents },
    fromPlayer: { sender: playerContents, senderFrame: playerContents.mainFrame },
    invoke: (channel, event, ...args) => handlers.get(channel)(event, ...args),
  };
}

function loadManager(fake) {
  const protocol = load("src/main/streamKit/protocol.ts");
  const client = load("src/main/streamKit/StreamKitClient.ts", {
    "./protocol": protocol,
  });
  return load("src/main/managers/StreamKitManager.ts", {
    electron: fake.electron,
    "electron-store": { __esModule: true, default: fake.Store },
    "../streamKit/StreamKitClient": client,
    "../streamKit/protocol": protocol,
  }).StreamKitManager;
}

async function until(check, timeout = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) {
      throw new Error("Timed out");
    }
    await delay(10);
  }
}

test("pairs from the window, reports the player's state and relays commands to it", async (t) => {
  const server = createMockStreamKit({
    voice: { url: "wss://voice.example", token: "jwt-1" },
  });
  await server.ready;
  const fake = fakeElectron();
  const StreamKitManager = loadManager(fake);
  const manager = new StreamKitManager(fake.window, fake.playerManager);
  t.after(() => {
    manager.destroy();
    return server.close();
  });

  // Nothing is saved, so nothing connects until the Operator pairs
  const initial = plain(fake.invoke("STREAM_KIT_GET_STATE", fake.fromWindow));
  assert.equal(initial.paired, false);
  assert.equal(initial.url, "https://stream.gluniverse.com");
  assert.equal(initial.enabled, true);
  assert.throws(() => fake.invoke("STREAM_KIT_GET_STATE", { sender: {} }));

  // The player reports before anything is connected; it is held for later
  fake.electron.ipcMain.emit("PLAYER_STREAM_KIT_LIBRARY", fake.fromPlayer, {
    playlists: [{ id: "p1", title: "Tavern", tracks: [{ id: "t1", title: "Lute" }] }],
    soundboards: [{ id: "s1", title: "Combat", sounds: [{ id: "x1", title: "Sword" }] }],
  });
  fake.electron.ipcMain.emit("PLAYER_STREAM_KIT_STATUS", fake.fromPlayer, {
    music: { volume: 0.5, muted: false, shuffle: true, repeat: "playlist" },
    sfx: { volume: 1 },
  });
  // A view that isn't the player is ignored
  fake.electron.ipcMain.emit(
    "PLAYER_STREAM_KIT_NOW_PLAYING",
    { sender: { id: 99 }, senderFrame: {} },
    { playing: true, track: null },
  );

  const library = server.waitFor("library");
  const status = server.waitFor("status");
  fake.electron.ipcMain.emit("STREAM_KIT_PAIR", fake.fromWindow, server.url, "abcd-efgh");
  assert.equal((await library).playlists[0].tracks[0].title, "Lute");
  const sentStatus = await status;
  assert.deepEqual(sentStatus.outputs, { discord: false, streamKit: true });
  assert.equal(sentStatus.music.shuffle, true);

  await until(() => fake.saved.get("streamKit")?.token);
  const saved = fake.saved.get("streamKit");
  assert.equal(saved.url, server.url);
  assert.deepEqual(saved.campaign, { id: "campaign-1", name: "Mock Campaign" });

  // The Voice Room goes to the player
  await until(() => fake.playerSent.some((m) => m.channel === "PLAYER_STREAM_KIT_VOICE"));
  assert.deepEqual(
    fake.playerSent.filter((m) => m.channel === "PLAYER_STREAM_KIT_VOICE").pop().args,
    ["wss://voice.example", "jwt-1"],
  );
  const state = plain(manager.getState());
  assert.equal(state.paired, true);
  assert.equal(state.voiceAvailable, true);
  assert.equal(state.connection.status, "connected");

  // Commands arrive on the HTTP remote's channels
  fake.playerSent.length = 0;
  server.sendCommand({ kind: "play-playlist", playlistId: "p1" });
  server.sendCommand({ kind: "play-track", playlistId: "p1", trackId: "t1" });
  server.sendCommand({ kind: "playback", action: "pause" });
  server.sendCommand({ kind: "playback", action: "rewind" });
  server.sendCommand({ kind: "music-volume", volume: 3 });
  server.sendCommand({ kind: "play-sound", soundboardId: "s1", soundId: "x1" });
  server.sendCommand({ kind: "stop-sounds" });
  server.sendCommand({ kind: "self-destruct" });
  await until(() => fake.playerSent.length >= 6);
  await delay(50);
  assert.deepEqual(fake.playerSent, [
    { channel: "PLAYER_REMOTE_PLAYLIST_PLAY", args: ["p1"] },
    { channel: "PLAYER_REMOTE_PLAYLIST_PLAY_TRACK", args: ["p1", "t1"] },
    { channel: "PLAYER_REMOTE_PLAYLIST_PLAYBACK_PAUSE", args: [] },
    { channel: "PLAYER_REMOTE_PLAYLIST_PLAYBACK_VOLUME", args: [1] },
    { channel: "PLAYER_REMOTE_SOUNDBOARD_PLAY", args: ["x1"] },
    { channel: "PLAYER_REMOTE_SOUNDBOARD_STOP_ALL", args: [] },
  ]);

  // Discord joining and the output being turned off both show in the status
  const discordStatus = server.waitFor("status", (m) => m.outputs.discord);
  manager.setDiscordChannel("channel-1", true);
  assert.equal((await discordStatus).outputs.streamKit, true);
  const offStatus = server.waitFor("status", (m) => !m.outputs.streamKit);
  fake.playerSent.length = 0;
  fake.electron.ipcMain.emit("STREAM_KIT_SET_ENABLED", fake.fromWindow, false);
  await offStatus;
  assert.deepEqual(fake.playerSent, [
    { channel: "PLAYER_STREAM_KIT_VOICE", args: [null, null] },
  ]);

  // The player asking for the Voice Room again is passed on
  const please = server.waitFor("voice-please");
  fake.electron.ipcMain.emit("PLAYER_STREAM_KIT_VOICE_PLEASE", fake.fromPlayer);
  await please;

  // What's playing is forwarded as it comes
  const nowPlaying = server.waitFor("now-playing");
  fake.electron.ipcMain.emit("PLAYER_STREAM_KIT_NOW_PLAYING", fake.fromPlayer, {
    playing: true,
    track: {
      id: "t1",
      title: "Lute",
      playlistId: "p1",
      playlistTitle: "Tavern",
      durationMs: 120000,
      positionMs: 5000,
    },
  });
  assert.equal((await nowPlaying).track.playlistTitle, "Tavern");
});

test("reconnects with the saved token on start, and forgets it when refused", async (t) => {
  const server = createMockStreamKit();
  server.addToken("saved-token");
  await server.ready;
  const fake = fakeElectron();
  fake.saved.set("streamKit", {
    url: server.url,
    token: "saved-token",
    campaign: { id: "campaign-1", name: "Mock Campaign" },
    enabled: true,
  });
  const StreamKitManager = loadManager(fake);
  const hello = server.waitFor("hello");
  const manager = new StreamKitManager(fake.window, fake.playerManager);
  t.after(() => {
    manager.destroy();
    return server.close();
  });

  assert.equal((await hello).token, "saved-token");
  await until(() => manager.getState().connection.status === "connected");
  // The Stream Kit has no Voice Room for this Campaign
  await until(() => manager.getState().voiceAvailable === false);

  server.unpairAll("Unpaired on the Stream Kit");
  await until(() => manager.getState().connection.status === "refused");
  assert.equal(fake.saved.get("streamKit").token, null);
  const state = plain(manager.getState());
  assert.equal(state.paired, false);
  assert.equal(state.connection.reason, "Unpaired on the Stream Kit");
  // The window was kept up to date as it went
  assert.ok(fake.windowSent.some((m) => m.channel === "STREAM_KIT_STATE"));
});

test("unpairing from the window disconnects and forgets the pairing", async (t) => {
  const server = createMockStreamKit();
  server.addToken("saved-token");
  await server.ready;
  const fake = fakeElectron();
  fake.saved.set("streamKit", {
    url: server.url,
    token: "saved-token",
    campaign: null,
    enabled: true,
  });
  const StreamKitManager = loadManager(fake);
  const manager = new StreamKitManager(fake.window, fake.playerManager);
  t.after(() => {
    manager.destroy();
    return server.close();
  });
  await until(() => server.connected === 1);

  fake.electron.ipcMain.emit("STREAM_KIT_UNPAIR", fake.fromWindow);
  await until(() => server.connected === 0);
  assert.equal(fake.saved.get("streamKit").token, null);
  assert.equal(manager.getState().connection.status, "idle");
  await delay(100);
  assert.equal(server.connections, 1);
});
