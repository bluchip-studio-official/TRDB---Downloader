// Persistence helpers:
//   - settings + history + active downloads  -> chrome.storage.local
//   - detected manifests (per tab, ephemeral) -> chrome.storage.session
//   - the chosen FileSystemDirectoryHandle     -> IndexedDB (not serialisable to chrome.storage)

import { STORAGE_KEYS, DEFAULT_SETTINGS, LIMITS, IDB } from '../shared/constants.js';

// ---- settings -------------------------------------------------------------

export async function getSettings() {
  const r = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(r[STORAGE_KEYS.SETTINGS] || {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
  return next;
}

// ---- history --------------------------------------------------------------

export async function getHistory() {
  const r = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  return r[STORAGE_KEYS.HISTORY] || [];
}

export async function addHistory(entry) {
  const list = await getHistory();
  list.unshift(entry);
  if (list.length > LIMITS.HISTORY_MAX) list.length = LIMITS.HISTORY_MAX;
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: list });
  return list;
}

export async function updateHistory(id, patch) {
  const list = await getHistory();
  const i = list.findIndex((e) => e.id === id);
  if (i >= 0) {
    list[i] = { ...list[i], ...patch };
    await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: list });
  }
  return list;
}

export async function removeHistory(id) {
  const list = (await getHistory()).filter((e) => e.id !== id);
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: list });
  return list;
}

export async function clearHistory() {
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: [] });
  return [];
}

// ---- active downloads (local mirror so a reopened panel can reseed) --------

export async function getActiveDownloads() {
  const r = await chrome.storage.local.get(STORAGE_KEYS.ACTIVE);
  return r[STORAGE_KEYS.ACTIVE] || {};
}

export async function setActiveDownload(entry) {
  const map = await getActiveDownloads();
  const prev = map[entry.id] || { startedAt: Date.now() };
  map[entry.id] = { ...prev, ...entry };
  await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE]: map });
  return map;
}

export async function clearActiveDownload(id) {
  const map = await getActiveDownloads();
  if (map[id]) { delete map[id]; await chrome.storage.local.set({ [STORAGE_KEYS.ACTIVE]: map }); }
  return map;
}

// ---- detections (session) -------------------------------------------------

const DET_KEY = 'detections';

export async function getDetections() {
  const r = await chrome.storage.session.get(DET_KEY);
  return r[DET_KEY] || {};
}

export async function addDetection(item) {
  const all = await getDetections();
  if (all[item.id]) return all; // already known
  all[item.id] = item;
  await chrome.storage.session.set({ [DET_KEY]: all });
  return all;
}

export async function clearTabDetections(tabId) {
  const all = await getDetections();
  let changed = false;
  for (const id of Object.keys(all)) {
    if (all[id].tabId === tabId) { delete all[id]; changed = true; }
  }
  if (changed) await chrome.storage.session.set({ [DET_KEY]: all });
  return all;
}

export async function removeDetection(id) {
  const all = await getDetections();
  if (all[id]) { delete all[id]; await chrome.storage.session.set({ [DET_KEY]: all }); }
  return all;
}

// ---- FileSystemDirectoryHandle (IndexedDB) --------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB.NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB.STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB.STORE, 'readwrite');
    tx.objectStore(IDB.STORE).put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB.STORE, 'readonly');
    const r = tx.objectStore(IDB.STORE).get(key);
    r.onsuccess = () => { db.close(); resolve(r.result); };
    r.onerror = () => { db.close(); reject(r.error); };
  });
}

export const saveDirHandle = (handle) => idbPut(IDB.DIR_HANDLE_KEY, handle);
export const loadDirHandle = () => idbGet(IDB.DIR_HANDLE_KEY);
export const clearDirHandle = () => idbPut(IDB.DIR_HANDLE_KEY, undefined);
