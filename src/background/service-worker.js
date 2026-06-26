// MV3 service worker:
//   - opens the side panel on toolbar-icon click
//   - observes network requests for DASH manifests (.mpd / application/dash+xml)
//   - records detected streams per tab in chrome.storage.session
//   - owns the offscreen document and routes download control messages to it
//
// No DOM APIs here (the service worker has no DOMParser); manifest parsing and
// the download engine live in the side panel / offscreen document.

import {
  MSG, TARGET, STREAM_KIND,
  HLS_CONTENT_TYPES, FILE_CONTENT_TYPES, FILE_EXTENSIONS, FILE_RESOURCE_TYPES,
} from '../shared/constants.js';
import {
  addDetection, clearTabDetections,
  getSettings, addHistory, setActiveDownload, clearActiveDownload,
} from '../core/storage.js';

// Cached setting so the synchronous webRequest listener can gate detection.
let autoDetect = true;
chrome.storage.local.get('settings').then((r) => {
  if (r.settings && typeof r.settings.autoDetect === 'boolean') autoDetect = r.settings.autoDetect;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings && changes.settings.newValue) {
    autoDetect = changes.settings.newValue.autoDetect !== false;
  }
});

// Open the side panel when the toolbar icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---- detection ------------------------------------------------------------

// Classify a URL by extension -> stream kind, or null if none match.
function kindFromUrl(url) {
  let path;
  try { path = new URL(url).pathname.toLowerCase(); } catch { return null; }
  if (path.endsWith('.mpd')) return STREAM_KIND.DASH;
  if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return STREAM_KIND.HLS;
  if (FILE_EXTENSIONS.some((e) => path.endsWith(e))) return STREAM_KIND.FILE;
  return null;
}

// Classify by response Content-Type (covers extension-less endpoints).
function kindFromContentType(value) {
  const ct = (value || '').toLowerCase();
  if (/application\/dash\+xml/.test(ct)) return STREAM_KIND.DASH;
  if (HLS_CONTENT_TYPES.some((t) => ct.includes(t))) return STREAM_KIND.HLS;
  if (FILE_CONTENT_TYPES.some((t) => ct.includes(t))) return STREAM_KIND.FILE;
  return null;
}

// A `.mp4`/`video/mp4` byte stream is only a direct download when it's the page
// playing a whole file (a media element or a direct navigation) -- not when an
// MSE player is pulling DASH/HLS fragments over XHR. Filter by resource type.
function fileKindAllowed(kind, type) {
  return kind !== STREAM_KIND.FILE || FILE_RESOURCE_TYPES.includes(type);
}

// Media URLs whose path identifies the file, so a rotating query string (a
// cache-buster / signed token) doesn't make the same file look like a new one.
const MEDIA_PATH_EXTENSIONS = ['.mpd', '.m3u8', '.m3u', ...FILE_EXTENSIONS];

// A stable dedup key for a URL, so one logical file collapses to a single card.
// When the path names a media file we key on just its last two segments (parent
// dir + filename) -- host, path-prefix, query and fragment are dropped. That's
// because CDNs serve one file through several rotating URLs (e.g. archive.org's
// `archive.org/download/<id>/<file>.mp4` and `ia<n>.us.archive.org/<d>/items/<id>/<file>.mp4`
// both end in `<id>/<file>.mp4`), and each range request may add a fresh token.
// Two genuinely different files differ in filename (or parent dir), so they keep
// distinct keys. URLs routed through a query (e.g. `get_video?id=123`, no media
// extension) keep their query, since it selects the resource.
function dedupKey(url) {
  try {
    const u = new URL(url);
    if (MEDIA_PATH_EXTENSIONS.some((e) => u.pathname.toLowerCase().endsWith(e))) {
      const segs = u.pathname.split('/').filter(Boolean).map((s) => {
        try { return decodeURIComponent(s); } catch { return s; } // normalise %20 etc.
      });
      return 'media:' + segs.slice(-2).join('/').toLowerCase();
    }
    u.hash = '';
    return u.href;
  } catch { return url; }
}

// Dedup keys already recorded this session, so a progressive file's many range
// requests (and re-requests of a manifest) don't re-run tabs.get or resurrect a
// card the user dismissed. Reset when the tab navigates/closes. In-memory only:
// if the service worker restarts it repopulates from the next request, and
// addDetection still dedupes against what's in session storage by the same key.
const recorded = new Set();

function forgetTab(tabId) {
  const prefix = tabId + ':';
  for (const id of recorded) if (id.startsWith(prefix)) recorded.delete(id);
}

async function record(url, tabId, kind) {
  if (!autoDetect || tabId == null || tabId < 0) return;
  const id = `${tabId}:${dedupKey(url)}`;
  if (recorded.has(id)) return;
  recorded.add(id);
  let title = '';
  let favIconUrl = '';
  let pageUrl = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    title = tab.title || '';
    favIconUrl = tab.favIconUrl || '';
    pageUrl = tab.url || '';
  } catch { /* tab may be gone */ }
  await addDetection({
    id,
    tabId, url, kind, title, favIconUrl, pageUrl,
    ts: Date.now(),
  });
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    const kind = kindFromUrl(d.url);
    if (kind && fileKindAllowed(kind, d.type)) record(d.url, d.tabId, kind);
  },
  { urls: ['<all_urls>'] },
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (kindFromUrl(d.url)) return; // already handled by the URL listener
    const ct = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type');
    const kind = ct && kindFromContentType(ct.value);
    if (kind && fileKindAllowed(kind, d.type)) record(d.url, d.tabId, kind);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

// Clear a tab's detections when it navigates away or closes.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) { clearTabDetections(tabId); forgetTab(tabId); }
});
chrome.tabs.onRemoved.addListener((tabId) => { clearTabDetections(tabId); forgetTab(tabId); });

// ---- offscreen document ---------------------------------------------------

let offscreenReady = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['BLOBS', 'DOM_PARSER'],
      justification: 'Download and remux DASH media segments in the background.',
    }).catch((e) => {
      // If it already exists due to a race, that's fine.
      if (!String(e).includes('Only a single offscreen')) throw e;
    }).finally(() => { offscreenReady = null; });
  }
  await offscreenReady;
}

// The offscreen document's message listener may not be registered the instant
// createDocument() resolves, so retry until the engine acknowledges (accepted).
async function forwardToOffscreen(message) {
  for (let i = 0; i < 40; i++) {
    const resp = await chrome.runtime.sendMessage(message).catch(() => undefined);
    if (resp && resp.accepted) return resp;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Download engine did not start');
}

// ---- chrome.* proxy for the offscreen document ----------------------------
// Offscreen documents can't use chrome.storage / chrome.notifications, so they
// ask the service worker (which can) to run these on their behalf.

function createNotification(title, message) {
  if (!chrome.notifications) return;
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
  });
}

const SW_OPS = {
  getSettings, addHistory, setActiveDownload, clearActiveDownload,
  notify: createNotification,
};

// ---- message routing (side panel -> offscreen) ----------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== TARGET.SW) return false;

  if (msg.type === MSG.SW_CALL) {
    const fn = SW_OPS[msg.op];
    if (!fn) { sendResponse({ error: 'unknown op: ' + msg.op }); return true; }
    Promise.resolve(fn(...(msg.args || [])))
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === MSG.START_DOWNLOAD) {
    ensureOffscreen()
      .then(() => forwardToOffscreen({ ...msg, target: TARGET.OFFSCREEN }))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ error: String(e && e.message || e) }));
    return true;
  }

  if (msg.type === MSG.CANCEL_DOWNLOAD) {
    chrome.runtime.sendMessage({ ...msg, target: TARGET.OFFSCREEN }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
