// Side panel controller: renders the Detected / Downloads / History / Settings
// views, parses manifests to show quality options, and dispatches download jobs
// to the engine (via the service worker). UI only -- no downloading/muxing here.

import { MSG, TARGET, LIMITS, STREAM_KIND } from '../shared/constants.js';
import { listen } from '../core/messaging.js';
import { parseMpd } from '../core/mpd-parser.js';
import { parseHls } from '../core/hls-parser.js';
import {
  getSettings, setSettings, getHistory, removeHistory, clearHistory,
  getDetections, removeDetection, saveDirHandle, loadDirHandle,
} from '../core/storage.js';

const $ = (id) => document.getElementById(id);
const els = {
  detectedList: $('detected-list'), detectedEmpty: $('detected-empty'), countDetected: $('count-detected'),
  downloadsList: $('downloads-list'), downloadsEmpty: $('downloads-empty'), countDownloads: $('count-downloads'),
  historyList: $('history-list'), historyEmpty: $('history-empty'), historyCount: $('history-count'),
  historyClear: $('history-clear'),
  navSettings: $('nav-settings'), settingsBack: $('settings-back'),
  chooseFolder: $('choose-folder'), folderName: $('folder-name'), useDownloads: $('use-downloads'), fsHint: $('fs-hint'),
  connections: $('connections'), connectionsVal: $('connections-val'), retries: $('retries'),
  filenameTemplate: $('filename-template'), autoDetect: $('auto-detect'), hideDrm: $('hide-drm'),
  notifyComplete: $('notify-complete'), toast: $('toast'),
  tpl: $('tpl-detected-card'),
};

let settings;
const parsedCache = new Map();   // detectionId -> model | { error }
const fileSizeCache = new Map(); // file URL -> probed size in bytes (avoids re-probing per render)
const active = new Map();         // jobId -> { ...state, prevBytes, prevTs, speed }
const childPlaylists = new Set(); // HLS media-playlist URLs owned by a parsed master (hidden)
let lastTab = 'detected';
let dirHandle = null;             // cached FS-access handle (kept in memory so
                                  // requesting permission stays within a gesture)

init();

async function init() {
  settings = await getSettings();
  dirHandle = await loadDirHandle().catch(() => null); // preload so the click path has no IDB await
  applySettingsToUI();
  setupTabs();
  setupSettings();
  setupMessages();
  setupStorageSync();

  // Seed active downloads from storage (survives panel reopen).
  const r = await chrome.storage.local.get('activeDownloads');
  for (const [id, st] of Object.entries(r.activeDownloads || {})) active.set(id, st);

  await Promise.all([renderDetected(), renderHistory()]);
  renderDownloads();
}

/* ----------------------------- navigation ----------------------------- */

function setupTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => showView(tab.dataset.tab));
  });
  els.navSettings.addEventListener('click', () => showView('settings'));
  els.settingsBack.addEventListener('click', () => showView(lastTab));
}

function showView(name) {
  if (name !== 'settings') lastTab = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('is-active'));
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
  $('view-' + name).classList.add('is-active');
  const tab = document.querySelector('.tab[data-tab="' + name + '"]');
  if (tab) tab.classList.add('is-active');
}

/* ----------------------------- detected ------------------------------- */

async function renderDetected() {
  const all = await getDetections();
  let items = Object.values(all).sort((a, b) => b.ts - a.ts);
  els.detectedList.innerHTML = '';

  // Tabs that already have an adaptive (DASH/HLS) stream. A direct file in such a
  // tab is almost always a redundant progressive copy of that stream, so hide it
  // behind the stream's card -- same idea as hiding HLS child playlists.
  const tabsWithStream = new Set();
  for (const item of items) {
    if (item.kind === STREAM_KIND.DASH || item.kind === STREAM_KIND.HLS) tabsWithStream.add(item.tabId);
  }

  // Hide HLS media playlists that belong to a master we've already parsed, the
  // redundant direct files above, and apply the hide-DRM filter using whatever
  // we've already parsed.
  const visible = [];
  for (const item of items) {
    if (childPlaylists.has(item.url)) continue;
    if (item.kind === STREAM_KIND.FILE && tabsWithStream.has(item.tabId)) continue;
    const cached = parsedCache.get(item.id);
    if (settings.hideDrm && cached && !cached.error && cached.isDRM) continue;
    visible.push(item);
  }

  for (const item of visible) els.detectedList.appendChild(buildCard(item));
  els.detectedEmpty.hidden = visible.length > 0;
  setBadge(els.countDetected, visible.length);
}

function buildCard(item) {
  const node = els.tpl.content.firstElementChild.cloneNode(true);
  const favicon = node.querySelector('.favicon');
  if (item.favIconUrl) favicon.src = item.favIconUrl; else favicon.style.visibility = 'hidden';
  node.querySelector('.domain').textContent = hostOf(item.pageUrl || item.url);
  const titleInput = node.querySelector('.title-input');
  titleInput.value = item.title || 'video';

  node.querySelector('.dismiss').addEventListener('click', async () => {
    await removeDetection(item.id);
    parsedCache.delete(item.id);
    renderDetected();
  });

  const status = node.querySelector('.card-status');

  // A direct file (e.g. .mp4) has no manifest to parse: render its card directly.
  if (item.kind === STREAM_KIND.FILE) {
    populateFileCard(node, item, status);
    return node;
  }

  const cached = parsedCache.get(item.id);
  if (cached && !cached.error) populateCard(node, item, cached);
  else if (cached && cached.error) showCardError(status, cached.error);
  else {
    status.innerHTML = '<span class="spinner"></span> Reading manifest&hellip;';
    const childCountBefore = childPlaylists.size;
    fetchAndParse(item).then((model) => {
      parsedCache.set(item.id, model);
      const drmHidden = settings.hideDrm && model.isDRM;
      // If an HLS master just revealed child playlists, or this card must be
      // DRM-hidden, re-render to apply the suppression / hide-DRM filters.
      if (drmHidden || childPlaylists.size > childCountBefore) { renderDetected(); return; }
      populateCard(node, item, model);
    }).catch((e) => {
      parsedCache.set(item.id, { error: e.message || String(e) });
      showCardError(status, e.message || String(e));
    });
  }

  return node;
}

async function fetchAndParse(item) {
  const res = await fetch(item.url, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching manifest');
  const text = await res.text();
  if (item.kind === STREAM_KIND.HLS) {
    const model = await parseHls(text, item.url, { fetchImpl: fetch });
    registerChildPlaylists(model, item.url);
    return model;
  }
  return parseMpd(text, item.url);
}

// Record the media-playlist URLs a master owns so their own detections (which
// the player also requests) are hidden behind the single master card.
function registerChildPlaylists(model, masterUrl) {
  let added = false;
  for (const rep of [...model.videos, ...model.audios]) {
    if (rep.playlistUrl && rep.playlistUrl !== masterUrl && !childPlaylists.has(rep.playlistUrl)) {
      childPlaylists.add(rep.playlistUrl);
      added = true;
    }
  }
  return added;
}

function showCardError(status, msg) {
  status.classList.add('error');
  status.textContent = 'Could not read manifest: ' + msg;
}

function populateCard(node, item, model) {
  const status = node.querySelector('.card-status');
  const controls = node.querySelector('.card-controls');
  const qualitySel = node.querySelector('.quality-select');
  const audioRow = node.querySelector('.audio-row');
  const audioSel = node.querySelector('.audio-select');
  const sizeEst = node.querySelector('.size-est');
  const dlBtn = node.querySelector('.download-btn');
  const titleInput = node.querySelector('.title-input');

  if (!model.videos.length) {
    showCardError(status, 'no downloadable video track found');
    return;
  }

  const kind = item.kind === STREAM_KIND.HLS ? 'hls' : 'dash';
  const tags = [`<span class="tag ${kind}">${kind.toUpperCase()}</span>`];
  if (model.isDRM) tags.push('<span class="tag drm">DRM</span>');
  if (model.isDynamic) tags.push('<span class="tag live">Live</span>');
  status.classList.remove('error');
  status.innerHTML = tags.join('');
  status.hidden = false;

  for (const v of model.videos) {
    const opt = document.createElement('option');
    opt.value = v.id;
    const bits = [v.height ? `${v.height}p` : fmtMbps(v.bandwidth)];
    if (v.height) bits.push(fmtMbps(v.bandwidth));
    if (shortCodec(v.codecs)) bits.push(shortCodec(v.codecs));
    opt.textContent = bits.join(' · ');
    qualitySel.appendChild(opt);
  }

  if (model.audios.length) {
    audioRow.hidden = false;
    for (const a of model.audios) {
      const opt = document.createElement('option');
      opt.value = a.id;
      const label = a.name || a.lang || 'audio';
      opt.textContent = a.bandwidth ? `${label} · ${fmtKbps(a.bandwidth)}` : label;
      audioSel.appendChild(opt);
    }
    // With a single track there is nothing to choose; show it so the user can
    // see audio is included, but don't present it as a selectable option.
    audioSel.disabled = model.audios.length === 1;
  }

  const updateSize = () => {
    const v = model.videos.find((x) => x.id === qualitySel.value) || model.videos[0];
    const a = pickAudio(model, audioRow, audioSel);
    const bw = (v.bandwidth || 0) + (a ? a.bandwidth || 0 : 0);
    sizeEst.textContent = bw && model.durationSec ? '~' + fmtBytes((bw * model.durationSec) / 8) : '';
  };
  qualitySel.addEventListener('change', updateSize);
  audioSel.addEventListener('change', updateSize);
  updateSize();

  const blocked = model.isDRM || model.isDynamic;
  dlBtn.disabled = blocked;
  if (model.isDRM) dlBtn.title = 'DRM-protected streams cannot be downloaded';
  else if (model.isDynamic) dlBtn.title = 'Live streams are not supported';

  dlBtn.addEventListener('click', () => startDownload({
    item, model, qualitySel, audioRow, audioSel, titleInput, dlBtn,
  }));

  controls.hidden = false;
}

function pickAudio(model, audioRow, audioSel) {
  if (!model.audios.length) return null;
  if (!audioRow.hidden && audioSel.value) return model.audios.find((a) => a.id === audioSel.value) || model.audios[0];
  return model.audios[0];
}

// Render a direct-file card: a container badge, the (best-effort) size, and a
// Download button. There are no qualities or audio tracks to choose, so those
// controls stay hidden.
function populateFileCard(node, item, status) {
  const controls = node.querySelector('.card-controls');
  const qualityLabel = node.querySelector('.quality-select').closest('.select-label');
  const audioRow = node.querySelector('.audio-row');
  const sizeEst = node.querySelector('.size-est');
  const dlBtn = node.querySelector('.download-btn');
  const titleInput = node.querySelector('.title-input');

  const ext = fileExt(item.url);
  status.classList.remove('error');
  status.innerHTML = `<span class="tag file">${escapeHtml((ext.slice(1) || 'file').toUpperCase())}</span>`;
  status.hidden = false;
  if (qualityLabel) qualityLabel.hidden = true;
  audioRow.hidden = true;
  controls.hidden = false;

  // The file's basename is usually a better default name than the page title.
  const base = baseNameFromUrl(item.url);
  if (base) titleInput.value = base;

  dlBtn.addEventListener('click', () => startFileDownload({ item, titleInput, dlBtn, ext }));

  const cachedSize = fileSizeCache.get(item.url);
  if (cachedSize != null) {
    if (cachedSize) sizeEst.textContent = '~' + fmtBytes(cachedSize);
  } else {
    probeFileSize(item.url)
      .then((size) => { fileSizeCache.set(item.url, size); if (size) sizeEst.textContent = '~' + fmtBytes(size); })
      .catch(() => { /* size is best-effort */ });
  }
}

async function startFileDownload({ item, titleInput, dlBtn, ext }) {
  const title = (titleInput.value || '').trim() || item.title || 'video';

  dlBtn.disabled = true;
  const ready = await ensureSaveDestination();
  if (!ready) { dlBtn.disabled = false; return; }

  const job = {
    id: crypto.randomUUID(),
    kind: STREAM_KIND.FILE,
    manifestUrl: item.url,        // the file URL; the engine downloads it directly
    pageUrl: item.pageUrl || '',
    title,
    ext,
    qualityLabel: '',
    filename: title,              // the engine sanitizes it and appends the extension
  };

  active.set(job.id, { id: job.id, title, quality: '', phase: 'starting', percent: 0, bytes: 0, startedAt: Date.now() });
  renderDownloads();
  showView('downloads');

  const resp = await chrome.runtime.sendMessage({ target: TARGET.SW, type: MSG.START_DOWNLOAD, job });
  if (resp && resp.error) {
    active.delete(job.id);
    renderDownloads();
    toast(resp.error, true);
  }
  dlBtn.disabled = false;
}

async function startDownload({ item, model, qualitySel, audioRow, audioSel, titleInput, dlBtn }) {
  const video = model.videos.find((v) => v.id === qualitySel.value) || model.videos[0];
  const audio = pickAudio(model, audioRow, audioSel);
  const title = (titleInput.value || '').trim() || item.title || 'video';
  const qualityLabel = (video.height ? video.height + 'p' : 'video');

  dlBtn.disabled = true;
  const ready = await ensureSaveDestination();
  if (!ready) { dlBtn.disabled = false; return; }

  const job = {
    id: crypto.randomUUID(),
    kind: item.kind || STREAM_KIND.DASH,
    manifestUrl: item.url,
    pageUrl: item.pageUrl || '',
    title,
    videoRepId: video.id,
    audioRepId: audio ? audio.id : null,
    qualityLabel,
    filename: buildFilename(settings.filenameTemplate, { title, video, qualityLabel }),
  };

  active.set(job.id, { id: job.id, title, quality: qualityLabel, phase: 'starting', percent: 0, bytes: 0, startedAt: Date.now() });
  renderDownloads();
  showView('downloads');

  const resp = await chrome.runtime.sendMessage({ target: TARGET.SW, type: MSG.START_DOWNLOAD, job });
  if (resp && resp.error) {
    active.delete(job.id);
    renderDownloads();
    toast(resp.error, true);
  }
  dlBtn.disabled = false;
}

/* ------------------------- save destination --------------------------- */

async function ensureSaveDestination() {
  if (settings.saveMode === 'downloads') return true;
  // The handle is cached in memory (preloaded at init / set on pick) so the only
  // awaits before requestPermission are query/request themselves -- an
  // IndexedDB await here would drop the click's user activation and the
  // permission prompt would be rejected.
  if (!dirHandle) dirHandle = await loadDirHandle().catch(() => null);
  if (!dirHandle) return !!(await pickFolder());
  const opts = { mode: 'readwrite' };
  if ((await dirHandle.queryPermission(opts)) === 'granted') return true;
  if (dirHandle.requestPermission && (await dirHandle.requestPermission(opts)) === 'granted') return true;
  return !!(await pickFolder());
}

async function pickFolder() {
  if (!window.showDirectoryPicker) {
    settings = await setSettings({ saveMode: 'downloads' });
    updateFolderUI();
    toast('Folder picker unavailable; using Downloads folder.', true);
    return null;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'dash-downloads' });
    dirHandle = handle;
    await saveDirHandle(handle);
    settings = await setSettings({ saveFolderName: handle.name, saveMode: 'fsaccess' });
    updateFolderUI();
    return handle;
  } catch (e) {
    if (e && e.name === 'AbortError') return null;
    toast('Could not open folder: ' + (e.message || e), true);
    return null;
  }
}

/* ----------------------------- downloads ------------------------------ */

function renderDownloads() {
  const items = [...active.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  els.downloadsList.innerHTML = '';
  for (const st of items) els.downloadsList.appendChild(buildDownloadRow(st));
  els.downloadsEmpty.hidden = items.length > 0;
  setBadge(els.countDownloads, items.length);
}

function buildDownloadRow(st) {
  const el = document.createElement('div');
  el.className = 'dl';
  const indeterminate = st.phase === 'muxing' || st.phase === 'transmuxing' || st.phase === 'starting';
  const sub = [];
  sub.push(phaseLabel(st.phase));
  if (st.bytes) sub.push(fmtBytes(st.bytes));
  if (st.speed) sub.push(fmtBytes(st.speed) + '/s');
  if (st.phase === 'downloading' && st.percent > 2 && st.eta) sub.push('ETA ' + fmtDuration(st.eta));

  el.innerHTML = `
    <div class="dl-head">
      <div class="dl-main">
        <div class="dl-title ellipsis">${escapeHtml(st.title)}</div>
        <div class="dl-sub">${sub.map((s) => `<span>${escapeHtml(s)}</span>`).join('')}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <strong>${st.phase === 'done' ? '100' : st.percent || 0}%</strong>
        <button class="icon-btn cancel" title="Cancel" aria-label="Cancel">&#10005;</button>
      </div>
    </div>
    <div class="progress"><div class="progress-bar ${indeterminate ? 'indeterminate' : ''}" style="width:${st.percent || 0}%"></div></div>`;

  el.querySelector('.cancel').addEventListener('click', () => {
    chrome.runtime.sendMessage({ target: TARGET.SW, type: MSG.CANCEL_DOWNLOAD, id: st.id });
  });
  return el;
}

function setupMessages() {
  listen(TARGET.PANEL, (msg) => {
    if (msg.type === MSG.DOWNLOAD_PROGRESS) {
      const st = active.get(msg.id) || { id: msg.id, title: msg.title || 'Download', startedAt: Date.now() };
      const now = Date.now();
      if (st.prevTs && msg.bytes != null) {
        const dt = (now - st.prevTs) / 1000;
        if (dt > 0.2) { st.speed = Math.max(0, (msg.bytes - (st.prevBytes || 0)) / dt); st.prevBytes = msg.bytes; st.prevTs = now; }
      } else { st.prevBytes = msg.bytes || 0; st.prevTs = now; }
      st.phase = msg.phase; st.percent = msg.percent; st.bytes = msg.bytes != null ? msg.bytes : st.bytes;
      if (msg.percent > 2 && msg.elapsedMs) st.eta = (msg.elapsedMs / 1000) * (100 - msg.percent) / msg.percent;
      active.set(msg.id, st);
      renderDownloads();
    } else if (msg.type === MSG.DOWNLOAD_DONE) {
      active.delete(msg.id);
      renderDownloads();
      renderHistory();
      toast('Saved ' + (msg.entry && msg.entry.filename ? msg.entry.filename : 'download'));
    } else if (msg.type === MSG.DOWNLOAD_ERROR) {
      active.delete(msg.id);
      renderDownloads();
      renderHistory();
      toast(msg.aborted ? 'Download canceled' : ('Download failed: ' + msg.error), !msg.aborted);
    }
  });
}

/* ------------------------------ history ------------------------------- */

async function renderHistory() {
  const list = await getHistory();
  els.historyList.innerHTML = '';
  for (const e of list) els.historyList.appendChild(buildHistoryRow(e));
  els.historyEmpty.hidden = list.length > 0;
  els.historyCount.textContent = list.length ? `${list.length} item${list.length === 1 ? '' : 's'}` : '';
  els.historyClear.style.visibility = list.length ? 'visible' : 'hidden';
}

function buildHistoryRow(e) {
  const el = document.createElement('div');
  el.className = 'hist';
  const meta = [];
  if (e.quality) meta.push(e.quality);
  if (e.sizeBytes) meta.push(fmtBytes(e.sizeBytes));
  meta.push(fmtDate(e.date));
  if (e.status === 'failed' && e.error) meta.push(e.error);
  if (e.status === 'completed' && e.backend === 'downloads') meta.push('Downloads');

  // Only completed downloads have a file on disk to reveal.
  const openBtn = e.status === 'completed'
    ? '<button class="icon-btn open-folder" title="Open folder location" aria-label="Open folder location">&#128193;</button>'
    : '';

  el.innerHTML = `
    <span class="status-dot ${e.status}" title="${e.status}"></span>
    <div class="hist-main">
      <div class="hist-title ellipsis">${escapeHtml(e.title || e.filename || 'Download')}</div>
      <div class="hist-meta ellipsis">${escapeHtml(meta.join(' · '))}</div>
    </div>
    ${openBtn}
    <button class="icon-btn redo" title="Download again" aria-label="Download again">&#8635;</button>
    <button class="icon-btn del" title="Remove" aria-label="Remove">&#128465;</button>`;

  const openEl = el.querySelector('.open-folder');
  if (openEl) openEl.addEventListener('click', () => openLocation(e));
  el.querySelector('.redo').addEventListener('click', () => redownload(e));
  el.querySelector('.del').addEventListener('click', async () => { await removeHistory(e.id); renderHistory(); });
  return el;
}

// Reveal a finished download in the OS file manager. Files saved via
// chrome.downloads can be shown directly; folders chosen through the File System
// Access API can't be opened by the browser, so we just name the folder.
function openLocation(e) {
  if (e.downloadId != null && chrome.downloads && chrome.downloads.show) {
    chrome.downloads.search({ id: e.downloadId }, (items) => {
      if (items && items.length && items[0].exists !== false) chrome.downloads.show(e.downloadId);
      else chrome.downloads.showDefaultFolder();
    });
    return;
  }
  if (e.backend === 'downloads' && chrome.downloads && chrome.downloads.showDefaultFolder) {
    chrome.downloads.showDefaultFolder();
    return;
  }
  const name = e.folderName || settings.saveFolderName;
  toast(name
    ? `Saved in folder "${name}". Your browser can't open it for you — open it from your file manager.`
    : "Your browser can't open this folder for you — open it from your file manager.", true);
}

async function redownload(e) {
  const isFile = e.kind === STREAM_KIND.FILE;
  if (!e.manifestUrl || (!isFile && !e.videoRepId)) { toast('Cannot re-download: missing stream info', true); return; }
  const ready = await ensureSaveDestination();
  if (!ready) return;
  const job = {
    id: crypto.randomUUID(),
    kind: e.kind || STREAM_KIND.DASH,
    manifestUrl: e.manifestUrl, pageUrl: e.pageUrl || '', title: e.title,
    videoRepId: e.videoRepId, audioRepId: e.audioRepId || null,
    ext: e.ext || undefined, qualityLabel: e.quality, filename: e.filename,
  };
  active.set(job.id, { id: job.id, title: e.title, quality: e.quality, phase: 'starting', percent: 0, bytes: 0, startedAt: Date.now() });
  renderDownloads();
  showView('downloads');
  const resp = await chrome.runtime.sendMessage({ target: TARGET.SW, type: MSG.START_DOWNLOAD, job });
  if (resp && resp.error) { active.delete(job.id); renderDownloads(); toast(resp.error, true); }
}

/* ------------------------------ settings ------------------------------ */

function applySettingsToUI() {
  els.connections.value = settings.connections;
  els.connectionsVal.textContent = settings.connections;
  els.retries.value = settings.retries;
  els.filenameTemplate.value = settings.filenameTemplate;
  els.autoDetect.checked = settings.autoDetect;
  els.hideDrm.checked = settings.hideDrm;
  els.notifyComplete.checked = settings.notifyOnComplete;
  updateFolderUI();
}

function updateFolderUI() {
  const isDownloads = settings.saveMode === 'downloads';
  els.useDownloads.checked = isDownloads;
  els.chooseFolder.disabled = isDownloads;
  els.folderName.textContent = isDownloads
    ? 'Browser Downloads folder'
    : (settings.saveFolderName ? settings.saveFolderName : 'No folder chosen yet');
  els.fsHint.textContent = isDownloads
    ? "Saved to your browser's Downloads folder."
    : 'Files stream straight to the folder you pick (handles large videos with low memory).';
}

function setupSettings() {
  els.chooseFolder.addEventListener('click', () => pickFolder());
  els.useDownloads.addEventListener('change', async () => {
    settings = await setSettings({ saveMode: els.useDownloads.checked ? 'downloads' : 'fsaccess' });
    updateFolderUI();
  });
  els.connections.addEventListener('input', () => { els.connectionsVal.textContent = els.connections.value; });
  els.connections.addEventListener('change', async () => {
    settings = await setSettings({ connections: clamp(+els.connections.value, LIMITS.MIN_CONNECTIONS, LIMITS.MAX_CONNECTIONS) });
  });
  els.retries.addEventListener('change', async () => {
    settings = await setSettings({ retries: clamp(+els.retries.value, 0, 10) });
  });
  els.filenameTemplate.addEventListener('change', async () => {
    settings = await setSettings({ filenameTemplate: els.filenameTemplate.value.trim() || '{title}_{height}p' });
  });
  els.autoDetect.addEventListener('change', async () => { settings = await setSettings({ autoDetect: els.autoDetect.checked }); });
  els.hideDrm.addEventListener('change', async () => { settings = await setSettings({ hideDrm: els.hideDrm.checked }); renderDetected(); });
  els.notifyComplete.addEventListener('change', async () => { settings = await setSettings({ notifyOnComplete: els.notifyComplete.checked }); });
  els.historyClear.addEventListener('click', async () => { await clearHistory(); renderHistory(); });
}

/* --------------------------- storage sync ----------------------------- */

function setupStorageSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.detections) renderDetected();
    if (area === 'local' && changes.history) renderHistory();
    if (area === 'local' && changes.settings && changes.settings.newValue) {
      settings = { ...settings, ...changes.settings.newValue };
    }
  });
}

/* ------------------------------ helpers ------------------------------- */

function buildFilename(tpl, { title, video, qualityLabel }) {
  return (tpl || '{title}_{height}p')
    .replace(/\{title\}/g, title)
    .replace(/\{height\}/g, video.height || '')
    .replace(/\{width\}/g, video.width || '')
    .replace(/\{bandwidth\}/g, Math.round((video.bandwidth || 0) / 1000) + 'k')
    .replace(/\{quality\}/g, qualityLabel);
}

function phaseLabel(phase) {
  return { starting: 'Starting', downloading: 'Downloading', transmuxing: 'Converting segments', muxing: 'Combining tracks', saving: 'Saving', done: 'Done' }[phase] || phase || '';
}

function shortCodec(c) {
  if (!c) return '';
  // HLS variant CODECS lists both audio + video (e.g. "mp4a.40.2,avc1.4d401f");
  // pick the video codec for the quality label.
  const parts = c.split(',').map((s) => s.trim()).filter(Boolean);
  const v = parts.find((p) => /^(avc|hvc|hev|av01|vp0?9|dvh)/i.test(p)) || parts[0] || '';
  if (v.startsWith('avc')) return 'H.264';
  if (v.startsWith('hvc') || v.startsWith('hev') || v.startsWith('dvh')) return 'H.265';
  if (v.startsWith('av01')) return 'AV1';
  if (v.startsWith('vp09') || v.startsWith('vp9')) return 'VP9';
  return v.split('.')[0];
}

// Lowercased file extension (incl. the dot) from a URL's path, defaulting to .mp4.
function fileExt(url) {
  try {
    const m = /\.[a-z0-9]+$/i.exec(new URL(url).pathname);
    return m ? m[0].toLowerCase() : '.mp4';
  } catch { return '.mp4'; }
}

// Decoded last path segment with its extension stripped (a default file name).
function baseNameFromUrl(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(seg).replace(/\.[a-z0-9]+$/i, '').trim();
  } catch { return ''; }
}

// Best-effort total size of a direct file (Content-Range, else Content-Length).
async function probeFileSize(url) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include' });
    const cr = r.headers.get('Content-Range');
    if (r.body && r.body.cancel) { try { await r.body.cancel(); } catch { /* ignore */ } }
    if (cr && cr.includes('/')) { const n = parseInt(cr.split('/')[1], 10); if (Number.isFinite(n)) return n; }
    const cl = r.headers.get('Content-Length');
    return cl ? parseInt(cl, 10) : 0;
  } catch { return 0; }
}

function hostOf(url) { try { return new URL(url).hostname; } catch { return url || ''; } }
function fmtMbps(bw) { return (bw / 1e6).toFixed(bw < 1e7 ? 1 : 0) + ' Mbps'; }
function fmtKbps(bw) { return Math.round(bw / 1e3) + ' kbps'; }
function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}
function fmtDuration(s) {
  s = Math.round(s);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n || lo)); }
function setBadge(el, n) { if (n > 0) { el.textContent = n; el.hidden = false; } else { el.hidden = true; } }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg, isError) {
  els.toast.textContent = msg;
  els.toast.classList.toggle('error', !!isError);
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3000);
}
