/**
 * Scheme the main process serves local files over, with CORS headers and a
 * per launch capability token in the path.
 * Local files have to be played back over it rather than over `file://`
 * because a media element can only be routed into Web Audio when its response
 * is CORS approved: `createMediaElementSource` on a cross origin element that
 * isn't produces silence rather than an error, and `file://` is an opaque
 * origin relative to the player page so it can never be approved.
 */
const MEDIA_SCHEME = "kenku-media://";

/**
 * Map a stored track URL to the URL it should be played back from.
 * Playlists and soundboards persist `file://` URLs written by `encodeFilePath`
 * so the conversion happens on the way to playback rather than by rewriting
 * what's in the store. The URL is built by the preload because it carries a
 * token that only the player is given, so a page in a browser view tab can't
 * use the scheme to read files off disk.
 */
export function toPlaybackURL(url: string): string {
  let mediaURL: string | undefined;
  try {
    mediaURL = window.player?.toMediaURL(url);
  } catch {
    // The main process couldn't hand back a URL, so fall through to the stored
    // one: it won't be routable, but it plays back as it did before the scheme
    mediaURL = undefined;
  }
  return typeof mediaURL === "string" && mediaURL.length > 0 ? mediaURL : url;
}

/**
 * Whether a playback URL is safe to route through Web Audio.
 * Only the media scheme is, because only it is known to answer with
 * `Access-Control-Allow-Origin`. An arbitrary remote URL may or may not, and
 * the failure mode of guessing wrong is a track that plays back silently.
 */
export function isWebAudioRoutable(url: string): boolean {
  return url.startsWith(MEDIA_SCHEME);
}

/** Use a processed copy only while it still belongs to this source. */
export function normalizedSource(item: { url: string; normalization?: { source: string; url: string; version: number } }): string {
  return item.normalization?.version === 1 && item.normalization.source === item.url ? item.normalization.url : item.url;
}
