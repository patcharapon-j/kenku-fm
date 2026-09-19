import crypto from "crypto";
import fs from "fs";
import path from "path";
import { protocol } from "electron";
import { Readable } from "stream";

/**
 * Scheme that local media files are served over
 *
 * The player loaded tracks straight from `file://`, which is an opaque origin,
 * so wrapping one of those elements in Web Audio produced silence rather than
 * an error. Serving the same files from a scheme we control, with CORS
 * enabled, is what lets the player route playback through the audio graph and
 * fade it sample accurately.
 */
export const MEDIA_SCHEME = "kenku-media";

/**
 * Secret that a request has to carry to be served
 *
 * The scheme is registered on the session that the browser views share, so
 * without this any page a user opened in a tab could read any file on disk
 * through it. The token is only ever handed to the player's own preload, which
 * no third party page runs, and it is regenerated every launch.
 */
const token = crypto.randomBytes(24).toString("hex");

/** Content types for the formats the player accepts */
const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".mpeg": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".3gp": "audio/3gpp",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

/** Build the URL that serves a local file to the player */
export function getMediaURL(filePath: string): string {
  return `${MEDIA_SCHEME}://local/${token}/${encodeURIComponent(filePath)}`;
}

/**
 * Declare the scheme's privileges
 * This has to run before the app is ready, and only describes the scheme: a
 * session that has no handler for it still can't fetch anything
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // The whole point of the scheme: it is what makes the audio readable
        // by the Web Audio graph rather than silently opaque
        corsEnabled: true,
      },
    },
  ]);
}

/** Start serving local media files, which can only be done once the app is ready */
export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, handleRequest);
}

async function handleRequest(request: GlobalRequest): Promise<GlobalResponse> {
  let filePath: string;
  try {
    const url = new URL(request.url);
    // `encodeURIComponent` escapes the separators, so the path is a single
    // segment and splitting here can't be confused by a path that contains one
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) {
      return notFound();
    }
    const [requestToken, encodedPath] = segments;
    // A mismatch is a request that didn't come from the player, which has no
    // business reading files, so it is refused before the path is even looked at
    if (
      requestToken.length !== token.length ||
      !crypto.timingSafeEqual(
        Buffer.from(requestToken),
        Buffer.from(token)
      )
    ) {
      return new Response(null, { status: 403 });
    }
    filePath = decodeURIComponent(encodedPath);
  } catch {
    return notFound();
  }

  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) {
      return notFound();
    }
    return respondWithFile(request, filePath, stats.size);
  } catch {
    return notFound();
  }
}

/**
 * Serve the file, honouring a range request
 * Seeking in a track that hasn't been fully buffered is a range request, so
 * without this the player could only ever seek within what it had already read
 */
function respondWithFile(
  request: GlobalRequest,
  filePath: string,
  size: number
): GlobalResponse {
  const contentType =
    CONTENT_TYPES[path.extname(filePath).toLowerCase()] ??
    "application/octet-stream";
  const range = parseRange(request.headers.get("range"), size);

  if (!range) {
    return new Response(toWebStream(filePath, 0, size - 1) as never, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": `${size}`,
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const { start, end } = range;
  return new Response(toWebStream(filePath, start, end) as never, {
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Content-Length": `${end - start + 1}`,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** Read part of a file as the kind of stream a `Response` takes */
function toWebStream(filePath: string, start: number, end: number) {
  return Readable.toWeb(fs.createReadStream(filePath, { start, end }));
}

/**
 * Parse a `Range` header, or return nothing when there isn't one to honour
 * Only a single byte range is supported, which is all a media element asks for
 */
function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return undefined;
  }
  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;
  if (rawStart === "") {
    // A range with no start asks for that many bytes from the end of the file
    const length = Number(rawEnd);
    if (!rawEnd || Number.isNaN(length) || length <= 0) {
      return undefined;
    }
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    return undefined;
  }
  return { start, end: Math.min(end, size - 1) };
}

function notFound(): GlobalResponse {
  return new Response(null, { status: 404 });
}
