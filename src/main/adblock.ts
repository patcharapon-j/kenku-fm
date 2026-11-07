import { promises as fs } from "fs";
import path from "path";
import { app, ipcMain, net, Session } from "electron";
import {
  adsAndTrackingLists,
  ElectronBlocker,
} from "@ghostery/adblocker-electron";

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const PLAYER_WINDOW_WEBPACK_ENTRY: string;
declare const __non_webpack_require__: NodeRequire;

// Rebuild the engine from fresh lists once the cached one is this old
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a page is one of Kenku FM's own (the main window, the player, the
 * audio capture window) rather than a site opened in a browser tab. Generic
 * cosmetic rules such as hiding `.ad` would otherwise reach the app's own UI,
 * and the player's Stream Kit connection shouldn't be at the mercy of a tracker
 * list.
 */
function isAppPage(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  if (!url.startsWith("http:") && !url.startsWith("https:")) {
    return true;
  }
  // In development the app's pages are served from the webpack dev server
  try {
    const origin = new URL(url).origin;
    return (
      origin === new URL(MAIN_WINDOW_WEBPACK_ENTRY).origin ||
      origin === new URL(PLAYER_WINDOW_WEBPACK_ENTRY).origin
    );
  } catch {
    return false;
  }
}

function cachePath() {
  return path.join(app.getPath("userData"), "adblock-engine.bin");
}

async function readCachedBlocker(): Promise<
  { blocker: ElectronBlocker; stale: boolean } | undefined
> {
  try {
    const [stats, buffer] = await Promise.all([
      fs.stat(cachePath()),
      fs.readFile(cachePath()),
    ]);
    return {
      blocker: ElectronBlocker.deserialize(new Uint8Array(buffer)),
      stale: Date.now() - stats.mtimeMs > MAX_CACHE_AGE_MS,
    };
  } catch {
    // Nothing cached yet, or a cache from an older version of the engine
    return undefined;
  }
}

async function buildBlocker(): Promise<ElectronBlocker> {
  // Ghostery reads the body without checking the status, so an error page
  // would otherwise be parsed as an (empty) list and cached for a week
  const fetchList = async (url: string) => {
    const response = await net.fetch(url);
    if (!response.ok) {
      throw new Error(`${response.status} fetching ${url}`);
    }
    return response;
  };
  // uBlock Origin's own filter lists, alongside EasyList, EasyPrivacy and
  // Peter Lowe's list, which uBlock Origin also turns on by default
  const blocker = await ElectronBlocker.fromLists(
    fetchList,
    adsAndTrackingLists,
    { enableCompression: true }
  );
  await fs.writeFile(cachePath(), blocker.serialize());
  return blocker;
}

/**
 * Block ads and trackers in the browser tabs, with the same filter lists and
 * scriptlets uBlock Origin uses, run by Ghostery's adblocker engine since
 * Electron can't host the uBlock Origin extension itself.
 *
 * Listeners are wired here rather than with `enableBlockingInSession` so the
 * app's own pages are left alone. They're in place at once, so tabs restored
 * at startup get cosmetic filters. A cached engine is used straight away, even
 * an outdated one while fresh lists download; only on the very first launch do
 * requests pass until the lists load.
 */
export function enableAdblock(session: Session) {
  let blocker: ElectronBlocker | undefined;
  const loading = (async () => {
    const cached = await readCachedBlocker();
    if (cached) {
      blocker = cached.blocker;
      if (cached.stale) {
        buildBlocker()
          .then((fresh) => {
            blocker = fresh;
          })
          .catch((err) => {
            console.error("Unable to refresh the adblock filter lists:", err);
          });
      }
      return blocker;
    }
    blocker = await buildBlocker();
    return blocker;
  })().catch((err): undefined => {
    console.error("Adblock disabled, unable to load the filter lists:", err);
    return undefined;
  });

  session.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      if (!blocker || isAppPage(details.webContents?.getURL())) {
        callback({});
        return;
      }
      blocker.onBeforeRequest(details, callback);
    }
  );
  session.webRequest.onHeadersReceived(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      if (!blocker || isAppPage(details.webContents?.getURL())) {
        callback({});
        return;
      }
      blocker.onHeadersReceived(details, callback);
    }
  );

  // Cosmetic filters and scriptlets (what hides YouTube's ads, for instance)
  // are injected by a preload in every frame that asks the main process for
  // them. It's resolved at runtime as webpack can't hand out a file path
  session.registerPreloadScript({
    type: "frame",
    filePath: __non_webpack_require__.resolve(
      "@ghostery/adblocker-electron-preload"
    ),
  });
  ipcMain.handle(
    "@ghostery/adblocker/inject-cosmetic-filters",
    async (event, url: string, msg) => {
      if (isAppPage(event.sender.getURL())) {
        return;
      }
      const loaded = blocker ?? (await loading);
      return loaded?.onInjectCosmeticFilters(event, url, msg);
    }
  );
  ipcMain.handle(
    "@ghostery/adblocker/is-mutation-observer-enabled",
    async (event) => {
      const loaded = blocker ?? (await loading);
      return loaded ? loaded.onIsMutationObserverEnabled(event) : false;
    }
  );
}
