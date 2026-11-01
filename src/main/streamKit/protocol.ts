/**
 * Messages exchanged with the GLUniverse Stream Kit over its `/kenku` socket
 * Kenku sends exactly one greeting when the socket opens, either pairing with
 * a one time code or reconnecting with the token a pairing handed out
 */

import type {
  Campaign,
  Command,
  Library,
  NowPlaying,
  Status,
} from "../../types/streamKit";

export type { Campaign, Command, Library, NowPlaying, Status };

export type AppInfo = { version: string };

export type Greeting =
  | { type: "pair"; code: string; app: AppInfo }
  | { type: "hello"; token: string; app: AppInfo };

export type KenkuMessage =
  | Greeting
  | ({ type: "library" } & Library)
  | ({ type: "now-playing" } & NowPlaying)
  | ({ type: "status" } & Status)
  | { type: "voice-please" };

export type StreamKitMessage =
  | { type: "paired"; token: string; campaign: Campaign }
  | { type: "welcome"; campaign: Campaign }
  | { type: "refused"; reason: string }
  | { type: "voice"; url: string | null; token: string | null }
  | { type: "command"; command: Command };

/** Close code the Stream Kit refuses a greeting with */
export const REFUSED_CLOSE_CODE = 4401;

/** Default address of the Stream Kit, used until the Operator enters another */
export const DEFAULT_STREAM_KIT_URL = "https://stream.gluniverse.com";

/**
 * Turn the Stream Kit's web address into the address of its Kenku socket
 * The Operator copies the address they open the console at, so a path, query
 * or trailing slash on it is dropped rather than carried into the socket's
 */
export function socketURL(streamKitURL: string): string {
  const url = new URL(streamKitURL.trim());
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error("The Stream Kit address has to start with https://");
  }
  url.pathname = "/kenku";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Pairing codes are shown as `XXXX-XXXX` and accepted in any case */
export function normalizePairingCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Read a message off the socket, or nothing when it isn't one */
export function parseMessage(data: unknown): StreamKitMessage | null {
  try {
    // `ws` hands over a Buffer, an ArrayBuffer or, for a fragmented message,
    // the list of Buffers it arrived in
    const text =
      typeof data === "string"
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data).toString()
          : Buffer.from(data as ArrayBuffer).toString();
    const message = JSON.parse(text);
    if (message && typeof message === "object" && typeof message.type === "string") {
      return message as StreamKitMessage;
    }
  } catch {
    // Not JSON, which is as unknown as a message gets
  }
  return null;
}
