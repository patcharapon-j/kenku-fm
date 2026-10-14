#!/usr/bin/env node
/**
 * A stand-in for the GLUniverse Stream Kit's side of the Kenku protocol
 *
 * Run it on its own to pair a real Kenku FM with it and drive Kenku from the
 * terminal:
 *
 *   node scripts/stream-kit-mock-server.cjs [--port 8787] [--code ABCD-EFGH]
 *     [--voice-url wss://your.livekit.cloud --voice-token <jwt>]
 *
 * then set Kenku's Stream Kit address to http://localhost:8787 and pair with
 * the printed code. Type `help` for the commands it can send. Everything Kenku
 * sends is printed as it arrives.
 *
 * The tests in `tests/stream-kit-client.test.cjs` use `createMockStreamKit`.
 */
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const readline = require("node:readline");
const { WebSocketServer } = require("ws");

const REFUSED_CLOSE_CODE = 4401;

function createMockStreamKit({
  port = 0,
  code = "ABCD-EFGH",
  campaign = { id: "campaign-1", name: "Mock Campaign" },
  voice = { url: null, token: null },
} = {}) {
  const events = new EventEmitter();
  const tokens = new Set();
  /** Sockets whose greeting has been accepted */
  const kenkus = new Set();
  /** Every message received, in order, as `{ message, socket }` */
  const received = [];
  let pairingCode = code.toUpperCase();
  let currentVoice = voice;
  let connections = 0;

  const wss = new WebSocketServer({ port, path: "/kenku" });

  function send(socket, message) {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function refuse(socket, reason) {
    send(socket, { type: "refused", reason });
    socket.close(REFUSED_CLOSE_CODE, reason);
  }

  function sendVoice(socket) {
    send(socket, { type: "voice", ...currentVoice });
  }

  wss.on("connection", (socket) => {
    connections += 1;
    let greeted = false;
    events.emit("connection", socket);

    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      received.push({ message, socket });
      events.emit("message", message, socket);

      if (!greeted) {
        greeted = true;
        if (message.type === "pair") {
          if (
            pairingCode !== null &&
            typeof message.code === "string" &&
            message.code.toUpperCase() === pairingCode
          ) {
            // A code is good for one pairing only
            pairingCode = null;
            const token = crypto.randomBytes(16).toString("hex");
            tokens.add(token);
            kenkus.add(socket);
            send(socket, { type: "paired", token, campaign });
            sendVoice(socket);
          } else {
            refuse(socket, "That pairing code isn't valid any more");
          }
        } else if (message.type === "hello") {
          if (tokens.has(message.token)) {
            kenkus.add(socket);
            send(socket, { type: "welcome", campaign });
            sendVoice(socket);
          } else {
            refuse(socket, "This Kenku FM was unpaired from the Stream Kit");
          }
        } else {
          refuse(socket, "Expected a greeting");
        }
        return;
      }

      if (message.type === "voice-please") {
        sendVoice(socket);
      }
    });

    socket.on("close", () => {
      kenkus.delete(socket);
      events.emit("close", socket);
    });
  });

  const ready = new Promise((resolve) => wss.on("listening", resolve));

  return {
    events,
    received,
    ready,
    get port() {
      return wss.address().port;
    },
    get url() {
      return `http://localhost:${wss.address().port}`;
    },
    get connections() {
      return connections;
    },
    get connected() {
      return kenkus.size;
    },
    /** Issue a new one time pairing code */
    newCode(next) {
      pairingCode = next.toUpperCase();
    },
    /** Add a token as if an earlier pairing had handed it out */
    addToken(token) {
      tokens.add(token);
    },
    sendCommand(command) {
      for (const socket of kenkus) {
        send(socket, { type: "command", command });
      }
    },
    sendRaw(message) {
      for (const socket of kenkus) {
        send(socket, message);
      }
    },
    setVoice(url, token) {
      currentVoice = { url, token };
      for (const socket of kenkus) {
        sendVoice(socket);
      }
    },
    /** Forget every token and refuse every connected Kenku */
    unpairAll(reason = "This Kenku FM was unpaired from the Stream Kit") {
      tokens.clear();
      for (const socket of kenkus) {
        refuse(socket, reason);
      }
    },
    /** Cut every connection without a word, as a network failure would */
    dropAll() {
      for (const socket of wss.clients) {
        socket.terminate();
      }
    },
    /** Resolve with the next message of `type` that matches `predicate` */
    waitFor(type, predicate = () => true, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          events.off("message", handler);
          reject(new Error(`Timed out waiting for "${type}"`));
        }, timeout);
        function handler(message) {
          if (message.type === type && predicate(message)) {
            clearTimeout(timer);
            events.off("message", handler);
            resolve(message);
          }
        }
        events.on("message", handler);
      });
    },
    close() {
      for (const socket of wss.clients) {
        socket.terminate();
      }
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

module.exports = { createMockStreamKit, REFUSED_CLOSE_CODE };

const HELP = `Commands:
  playlist <playlistId>             play a playlist
  track <playlistId> <trackId>      play a track from a playlist
  play | pause | next | previous    playlist transport
  volume <0-1>                      music volume
  sound <soundboardId> <soundId>    play a soundboard sound
  stop-sounds                       stop every sound
  voice <url> <token> | voice none  hand Kenku a Voice Room, or take it away
  code <XXXX-XXXX>                  issue a new pairing code
  unpair                            refuse every connected Kenku (close 4401)
  drop                              cut every connection (Kenku reconnects)
  library                           print the last library Kenku sent
  quit`;

function runCLI() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const code = option("code", "ABCD-EFGH");
  const server = createMockStreamKit({
    port: Number(option("port", "8787")),
    code,
    voice: {
      url: option("voice-url", null),
      token: option("voice-token", null),
    },
  });
  let library = null;

  server.ready.then(() => {
    console.log(`Mock Stream Kit at ${server.url} (socket ws://localhost:${server.port}/kenku)`);
    console.log(`Pairing code: ${code}`);
    console.log('Type "help" for commands.');
  });
  server.events.on("connection", () => console.log("< Kenku connected"));
  server.events.on("close", () => console.log("< Kenku disconnected"));
  server.events.on("message", (message) => {
    if (message.type === "library") {
      library = message;
      console.log(
        `< library: ${message.playlists.length} playlists, ${message.soundboards.length} soundboards`,
      );
    } else {
      console.log("<", JSON.stringify(message));
    }
  });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const [name, ...rest] = line.trim().split(/\s+/);
    switch (name) {
      case "help":
        console.log(HELP);
        break;
      case "playlist":
        server.sendCommand({ kind: "play-playlist", playlistId: rest[0] });
        break;
      case "track":
        server.sendCommand({ kind: "play-track", playlistId: rest[0], trackId: rest[1] });
        break;
      case "play":
      case "pause":
      case "next":
      case "previous":
        server.sendCommand({ kind: "playback", action: name });
        break;
      case "volume":
        server.sendCommand({ kind: "music-volume", volume: Number(rest[0]) });
        break;
      case "sound":
        server.sendCommand({ kind: "play-sound", soundboardId: rest[0], soundId: rest[1] });
        break;
      case "stop-sounds":
        server.sendCommand({ kind: "stop-sounds" });
        break;
      case "voice":
        if (rest[0] === "none") {
          server.setVoice(null, null);
        } else {
          server.setVoice(rest[0], rest[1]);
        }
        break;
      case "code":
        server.newCode(rest[0]);
        console.log(`Pairing code: ${rest[0].toUpperCase()}`);
        break;
      case "unpair":
        server.unpairAll();
        break;
      case "drop":
        server.dropAll();
        break;
      case "library":
        console.log(JSON.stringify(library, null, 2));
        break;
      case "quit":
        server.close().then(() => process.exit(0));
        break;
      case "":
        break;
      default:
        console.log(`Unknown command "${name}". Type "help".`);
    }
  });
}

if (require.main === module) {
  runCLI();
}
