// Shared constants: message types, settings defaults, limits.
// Imported by every context (service worker, offscreen, side panel) and the Node tests.

export const MSG = {
  // service worker <-> side panel
  GET_DETECTIONS: 'get-detections',
  DETECTIONS_UPDATED: 'detections-updated',
  CLEAR_DETECTION: 'clear-detection',
  // side panel -> service worker -> offscreen
  START_DOWNLOAD: 'start-download',
  CANCEL_DOWNLOAD: 'cancel-download',
  // offscreen -> broadcast (side panel listens)
  DOWNLOAD_PROGRESS: 'download-progress',
  DOWNLOAD_DONE: 'download-done',
  DOWNLOAD_ERROR: 'download-error',
  // offscreen -> service worker: run an op in a context with full chrome.*
  // access (offscreen documents can't use chrome.storage / chrome.notifications).
  SW_CALL: 'sw-call',
  // internal routing flag for offscreen-targeted messages
  TO_OFFSCREEN: 'to-offscreen',
};

// Message targets so each context ignores messages not addressed to it.
export const TARGET = {
  SW: 'sw',
  PANEL: 'panel',
  OFFSCREEN: 'offscreen',
};

// Streaming protocol of a detected manifest. Picks the parser and engine path.
export const STREAM_KIND = {
  DASH: 'dash',  // MPEG-DASH (.mpd)
  HLS: 'hls',    // HTTP Live Streaming (.m3u8)
  FILE: 'file',  // a direct, self-contained progressive media file (e.g. .mp4)
};

// Response Content-Types that identify an HLS playlist when the URL has no .m3u8
// extension (e.g. a query-string manifest endpoint).
export const HLS_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
];

// A direct progressive media file is one complete file the browser plays as-is
// (a `<video src>` / direct URL), not an adaptive manifest. We download it
// verbatim — no parsing, transmux, or remux. Detected by URL extension and, for
// extension-less endpoints, by response Content-Type.
export const FILE_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm', '.mkv'];
export const FILE_CONTENT_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
];
// webRequest resource types that represent a direct file fetch. MSE players
// pull DASH/HLS segments via 'xmlhttprequest', so restricting file detection to
// these types keeps adaptive-stream segments out of the direct-file list.
export const FILE_RESOURCE_TYPES = ['media', 'main_frame', 'sub_frame', 'object'];

export const STORAGE_KEYS = {
  SETTINGS: 'settings',
  HISTORY: 'history',
  ACTIVE: 'activeDownloads',
};

export const DEFAULT_SETTINGS = {
  saveMode: 'fsaccess',          // 'fsaccess' | 'downloads'
  saveFolderName: '',            // display name of the chosen directory (handle lives in IndexedDB)
  connections: 5,                // parallel segment connections (1..16)
  retries: 3,                    // per-segment retry attempts
  filenameTemplate: '{title}_{height}p',
  autoDetect: true,              // observe network for .mpd
  hideDrm: false,                // hide DRM-protected streams from the detected list
  notifyOnComplete: true,        // chrome.notifications on finish
};

export const LIMITS = {
  MIN_CONNECTIONS: 1,
  MAX_CONNECTIONS: 16,
  HISTORY_MAX: 200,
  PROGRESS_THROTTLE_MS: 250,
  // For SegmentBase / single-file downloads, split into ranges only above this size.
  RANGE_SPLIT_MIN_BYTES: 4 * 1024 * 1024,
};

export const IDB = {
  NAME: 'dash-downloader',
  STORE: 'handles',
  DIR_HANDLE_KEY: 'saveDir',
};
