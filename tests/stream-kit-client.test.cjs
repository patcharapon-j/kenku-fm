const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
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

const protocol = load("src/main/streamKit/protocol.ts");
const { StreamKitClient } = load("src/main/streamKit/StreamKitClient.ts", {
  "./protocol": protocol,
});

function once(emitter, event, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${event}`)),
      timeout,
    );
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

// Objects built inside the sandbox have its own prototypes, which deepEqual
// treats as different from this realm's
const plain = (value) => JSON.parse(JSON.stringify(value));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function client() {
  return new StreamKitClient({
    appVersion: "9.9.9",
    minBackoff: 20,
    maxBackoff: 80,
  });
}

test("socket address follows the Stream Kit's", () => {
  assert.equal(
    protocol.socketURL("https://stream.gluniverse.com"),
    "wss://stream.gluniverse.com/kenku",
  );
  assert.equal(
    protocol.socketURL(" https://stream.gluniverse.com/console/abc?x=1 "),
    "wss://stream.gluniverse.com/kenku",
  );
  assert.equal(
    protocol.socketURL("http://localhost:8787/"),
    "ws://localhost:8787/kenku",
  );
  assert.throws(() => protocol.socketURL("ftp://example.com"));
  assert.equal(protocol.normalizePairingCode(" abcd-efgh "), "ABCD-EFGH");
});

test("pairs with a code in any case, then says hello with the token it was given", async (t) => {
  const server = createMockStreamKit({
    voice: { url: "wss://voice.example", token: "jwt-1" },
  });
  await server.ready;
  const kenku = client();
  t.after(() => {
    kenku.stop();
    return server.close();
  });

  const greeting = server.waitFor("pair");
  const paired = once(kenku, "paired");
  const voice = once(kenku, "voice");
  kenku.pair(server.url, "abcd-efgh");

  const pair = await greeting;
  assert.equal(pair.code, "ABCD-EFGH");
  assert.deepEqual(pair.app, { version: "9.9.9" });
  const [token, campaign] = await paired;
  assert.equal(typeof token, "string");
  assert.deepEqual(plain(campaign), { id: "campaign-1", name: "Mock Campaign" });
  assert.deepEqual(plain(kenku.state), { status: "connected", campaign: plain(campaign) });
  assert.deepEqual(await voice, ["wss://voice.example", "jwt-1"]);

  // A dropped connection is picked up again with the token, not the spent code
  const hello = server.waitFor("hello");
  const ready = once(kenku, "ready");
  server.dropAll();
  assert.equal((await hello).token, token);
  await ready;
  assert.equal(kenku.state.status, "connected");
});

test("relays commands, ignores unknown messages and asks for the Voice Room again", async (t) => {
  const server = createMockStreamKit();
  server.addToken("saved-token");
  await server.ready;
  const kenku = client();
  t.after(() => {
    kenku.stop();
    return server.close();
  });

  const ready = once(kenku, "ready");
  const firstVoice = once(kenku, "voice");
  kenku.connect(server.url, "saved-token");
  await ready;
  assert.deepEqual(await firstVoice, [null, null]);

  const commands = [];
  kenku.on("command", (command) => commands.push(command));
  server.sendRaw({ type: "something-new", data: 1 });
  server.sendRaw({ type: "command", command: { kind: "stop-sounds" } });
  server.sendCommand({ kind: "playback", action: "next" });
  await delay(100);
  assert.deepEqual(plain(commands), [
    { kind: "stop-sounds" },
    { kind: "playback", action: "next" },
  ]);

  server.setVoice("wss://voice.example", "jwt-2");
  const voice = once(kenku, "voice");
  kenku.send({ type: "voice-please" });
  assert.deepEqual(await voice, ["wss://voice.example", "jwt-2"]);

  const library = server.waitFor("library");
  assert.equal(
    kenku.send({
      type: "library",
      playlists: [{ id: "p", title: "P", tracks: [{ id: "t", title: "T" }] }],
      soundboards: [],
    }),
    true,
  );
  assert.equal((await library).playlists[0].tracks[0].title, "T");
});

test("a refused token is forgotten and never retried", async (t) => {
  const server = createMockStreamKit();
  await server.ready;
  const kenku = client();
  t.after(() => {
    kenku.stop();
    return server.close();
  });

  const refused = once(kenku, "refused");
  kenku.connect(server.url, "unknown-token");
  const [reason] = await refused;
  assert.equal(reason, "This Kenku FM was unpaired from the Stream Kit");
  assert.deepEqual(plain(kenku.state), { status: "refused", reason });
  await delay(300);
  assert.equal(server.connections, 1);
  assert.equal(kenku.send({ type: "voice-please" }), false);
});

test("unpairing on the Stream Kit refuses a connected Kenku", async (t) => {
  const server = createMockStreamKit();
  server.addToken("saved-token");
  await server.ready;
  const kenku = client();
  t.after(() => {
    kenku.stop();
    return server.close();
  });

  const ready = once(kenku, "ready");
  kenku.connect(server.url, "saved-token");
  await ready;
  const refused = once(kenku, "refused");
  server.unpairAll("Unpaired by the Operator");
  assert.deepEqual(await refused, ["Unpaired by the Operator"]);
  await delay(200);
  assert.equal(server.connections, 1);
});

test("a wrong pairing code is refused", async (t) => {
  const server = createMockStreamKit();
  await server.ready;
  const kenku = client();
  t.after(() => {
    kenku.stop();
    return server.close();
  });

  const refused = once(kenku, "refused");
  kenku.pair(server.url, "WXYZ-0000");
  await refused;
  assert.equal(kenku.state.status, "refused");
});

test("keeps retrying with backoff while the Stream Kit is unreachable", async (t) => {
  const server = createMockStreamKit();
  server.addToken("saved-token");
  await server.ready;
  const port = server.port;
  await server.close();

  const kenku = client();
  t.after(() => kenku.stop());
  const states = [];
  kenku.on("state", (state) => states.push(state.status));
  kenku.connect(`http://localhost:${port}`, "saved-token");
  await delay(400);
  assert.equal(kenku.state.status, "connecting");
  assert.ok(states.length >= 3, `expected several attempts, saw ${states.length}`);

  // Pairing doesn't retry: the Operator is right there to press Pair again
  const failed = new StreamKitClient({ appVersion: "9.9.9" });
  const state = new Promise((resolve) =>
    failed.on("state", (s) => s.status === "failed" && resolve(s)),
  );
  failed.pair(`http://localhost:${port}`, "ABCD-EFGH");
  assert.equal((await state).status, "failed");
  failed.stop();
});

test("an invalid address fails without connecting", () => {
  const kenku = client();
  kenku.pair("not a url", "ABCD-EFGH");
  assert.equal(kenku.state.status, "failed");
});
