import WebSocket from "ws";
import { TypedEmitter } from "tiny-typed-emitter";

import {
  Campaign,
  Command,
  KenkuMessage,
  normalizePairingCode,
  parseMessage,
  REFUSED_CLOSE_CODE,
  socketURL,
} from "./protocol";

export type ClientState =
  /** Nothing to connect with, or stopped on purpose */
  | { status: "idle" }
  | { status: "connecting"; pairing: boolean }
  | { status: "connected"; campaign: Campaign }
  /** The Stream Kit turned the greeting down, which is never retried */
  | { status: "refused"; reason: string }
  /** A pairing that never got an answer, which is left for the Operator to retry */
  | { status: "failed"; reason: string };

export interface StreamKitClientEvents {
  state: (state: ClientState) => void;
  /** A pairing went through, and this token is what reconnects from now on */
  paired: (token: string, campaign: Campaign) => void;
  /** The token is no good any more and has to be forgotten */
  refused: (reason: string) => void;
  /** The greeting was accepted and messages can be sent */
  ready: (campaign: Campaign) => void;
  voice: (url: string | null, token: string | null) => void;
  command: (command: Command) => void;
}

export type StreamKitClientOptions = {
  appVersion: string;
  /** First reconnect delay in ms, doubled on each failure */
  minBackoff?: number;
  /** Longest reconnect delay in ms */
  maxBackoff?: number;
  /**
   * How often in ms the socket is pinged, and so how long a connection that
   * has silently gone away can go unnoticed before it is replaced
   */
  pingInterval?: number;
  /** How long in ms the opening handshake may take */
  handshakeTimeout?: number;
};

/**
 * The Stream Kit side of Kenku: one socket to `<Stream Kit>/kenku`, greeted
 * once with a pairing code or a saved token, then kept open for as long as
 * Kenku is paired.
 *
 * This holds no Electron state so it can be run against a mock Stream Kit in
 * plain Node, see `tests/stream-kit-client.test.cjs`.
 */
export class StreamKitClient extends TypedEmitter<StreamKitClientEvents> {
  state: ClientState = { status: "idle" };

  private _options: Required<StreamKitClientOptions>;
  private _socket: WebSocket | null = null;
  private _url = "";
  private _token: string | null = null;
  private _code: string | null = null;
  /** Whether the greeting has been answered on the current socket */
  private _ready = false;
  /** Reason the current socket was refused with, once it has been */
  private _refusal: string | null = null;
  private _backoff: number;
  private _reconnectTimeout: NodeJS.Timeout | null = null;
  private _pingInterval: NodeJS.Timeout | null = null;
  private _alive = true;

  constructor(options: StreamKitClientOptions) {
    super();
    this._options = {
      minBackoff: 1000,
      maxBackoff: 30000,
      pingInterval: 30000,
      handshakeTimeout: 10000,
      ...options,
    };
    this._backoff = this._options.minBackoff;
  }

  /** Pair with the code the Operator copied off the Stream Kit console */
  pair(streamKitURL: string, code: string): void {
    this._start(streamKitURL, null, normalizePairingCode(code));
  }

  /** Reconnect with the token an earlier pairing handed out */
  connect(streamKitURL: string, token: string): void {
    this._start(streamKitURL, token, null);
  }

  /** Close the socket and stop reconnecting */
  stop(): void {
    this._teardown();
    this._token = null;
    this._code = null;
    this._setState({ status: "idle" });
  }

  /** Send a message once the greeting has been accepted, dropping it before */
  send(message: KenkuMessage): boolean {
    if (!this._ready || this._socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this._socket.send(JSON.stringify(message));
    return true;
  }

  get ready(): boolean {
    return this._ready;
  }

  private _start(
    streamKitURL: string,
    token: string | null,
    code: string | null,
  ): void {
    this._teardown();
    this._token = token;
    this._code = code;
    this._backoff = this._options.minBackoff;
    try {
      this._url = socketURL(streamKitURL);
    } catch (error) {
      this._setState({
        status: "failed",
        reason:
          error instanceof Error && error.message.startsWith("The Stream Kit")
            ? error.message
            : "That isn't a valid Stream Kit address",
      });
      return;
    }
    this._open();
  }

  private _open(): void {
    const pairing = this._code !== null;
    this._setState({ status: "connecting", pairing });
    this._ready = false;
    this._refusal = null;
    this._alive = true;

    const socket = new WebSocket(this._url, {
      handshakeTimeout: this._options.handshakeTimeout,
    });
    this._socket = socket;

    socket.on("open", () => {
      const app = { version: this._options.appVersion };
      socket.send(
        JSON.stringify(
          this._code !== null
            ? { type: "pair", code: this._code, app }
            : { type: "hello", token: this._token, app },
        ),
      );
      this._startPing(socket);
    });
    socket.on("pong", () => {
      this._alive = true;
    });
    socket.on("message", (data) => {
      if (this._socket === socket) {
        this._handleMessage(data);
      }
    });
    socket.on("error", () => {
      // Always followed by `close`, which is where the outcome is decided
    });
    socket.on("close", (code, reason) => {
      if (this._socket !== socket) {
        return;
      }
      this._handleClose(code, reason.toString());
    });
  }

  private _handleMessage(data: WebSocket.RawData): void {
    const message = parseMessage(data);
    if (!message) {
      return;
    }
    switch (message.type) {
      case "paired": {
        if (this._code === null || typeof message.token !== "string") {
          return;
        }
        // The code is spent, so any reconnect from here on says hello
        this._code = null;
        this._token = message.token;
        this._accept(message.campaign);
        this.emit("paired", message.token, message.campaign);
        this.emit("ready", message.campaign);
        break;
      }
      case "welcome":
        this._accept(message.campaign);
        this.emit("ready", message.campaign);
        break;
      case "refused":
        this._refusal =
          typeof message.reason === "string" && message.reason
            ? message.reason
            : "Refused by the Stream Kit";
        break;
      case "voice":
        if (this._ready) {
          this.emit("voice", message.url ?? null, message.token ?? null);
        }
        break;
      case "command":
        if (this._ready && message.command && typeof message.command === "object") {
          this.emit("command", message.command);
        }
        break;
      default:
        // Unknown message types are ignored so the Stream Kit can grow its side
        // of the protocol without breaking an older Kenku
        break;
    }
  }

  private _accept(campaign: Campaign): void {
    this._ready = true;
    this._backoff = this._options.minBackoff;
    this._setState({ status: "connected", campaign });
  }

  private _handleClose(code: number, reason: string): void {
    const wasPairing = this._code !== null;
    this._stopPing();
    this._socket = null;
    this._ready = false;

    if (this._refusal !== null || code === REFUSED_CLOSE_CODE) {
      const refusal = this._refusal || reason || "Refused by the Stream Kit";
      this._token = null;
      this._code = null;
      this._setState({ status: "refused", reason: refusal });
      this.emit("refused", refusal);
      return;
    }

    if (wasPairing) {
      // A one time code isn't sent again behind the Operator's back: if it
      // never arrived they can press Pair again, and if it did, it is spent
      this._code = null;
      this._setState({
        status: "failed",
        reason: "Couldn't reach the Stream Kit to pair. Check the address and try again.",
      });
      return;
    }

    if (this._token === null) {
      this._setState({ status: "idle" });
      return;
    }

    const delay = this._backoff;
    this._backoff = Math.min(this._backoff * 2, this._options.maxBackoff);
    this._setState({ status: "connecting", pairing: false });
    this._reconnectTimeout = setTimeout(() => {
      this._reconnectTimeout = null;
      this._open();
    }, delay);
  }

  /**
   * A connection can die without either side being told, a sleeping laptop or
   * a dropped Wi-Fi link, so one that stops answering pings is closed and the
   * usual reconnect takes over
   */
  private _startPing(socket: WebSocket): void {
    this._stopPing();
    this._pingInterval = setInterval(() => {
      if (!this._alive) {
        socket.terminate();
        return;
      }
      this._alive = false;
      try {
        socket.ping();
      } catch {
        // Already closing, which `close` deals with
      }
    }, this._options.pingInterval);
  }

  private _stopPing(): void {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  private _teardown(): void {
    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;
    }
    this._stopPing();
    const socket = this._socket;
    this._socket = null;
    this._ready = false;
    if (socket) {
      socket.removeAllListeners("message");
      // Errors on a socket being dropped are of no interest, but an emitter
      // with no error listener throws them
      socket.on("error", () => undefined);
      if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      } else {
        socket.close(1000);
      }
    }
  }

  private _setState(state: ClientState): void {
    this.state = state;
    this.emit("state", state);
  }
}
