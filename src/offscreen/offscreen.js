// Offscreen engine host: receives download jobs from the side panel (via the
// service worker), then fetches + parses the manifest, downloads the chosen
// representations in parallel, muxes to MP4, and streams the result to disk.
// Progress / completion / errors are broadcast to the side panel and mirrored
// in chrome.storage.local for resilience.

import { MSG, TARGET, LIMITS, STREAM_KIND } from '../shared/constants.js';
import { listen, send } from '../core/messaging.js';
import { parseMpd } from '../core/mpd-parser.js';
import { parseHls, resolveHlsRendition } from '../core/hls-parser.js';
import { downloadTrack } from '../core/download-engine.js';
import { transmuxTsToMp4, transmuxTsToWriter, detectContainer } from '../core/transmux.js';
import { muxToMp4 } from '../core/muxer.js';
import { createWriter } from '../core/file-writer.js';
import { loadDirHandle } from '../core/storage.js';

// Offscreen documents lack chrome.storage / chrome.notifications; run those in
// the service worker. (loadDirHandle uses IndexedDB, which works here.)
async function swCall(op, ...args) {
  const resp = await send({ target: TARGET.SW, type: MSG.SW_CALL, op, args });
  if (!resp) throw new Error('No response from service worker for ' + op);
  if (resp.error) throw new Error(resp.error);
  return resp.result;
}

const jobs = new Map(); // id -> { controller }

listen(TARGET.OFFSCREEN, (msg) => {
  if (msg.type === MSG.START_DOWNLOAD) { startJob(msg.job); return { accepted: true }; }
  if (msg.type === MSG.CANCEL_DOWNLOAD) {
    const j = jobs.get(msg.id);
    if (j) j.controller.abort();
    return { ok: true };
  }
  return undefined;
});

async function startJob(job) {
  if (jobs.has(job.id)) return;
  const controller = new AbortController();
  jobs.set(job.id, { controller });
  const t0 = Date.now();
  let writer = null;

  try {
    await setActive(job, { status: 'starting', phase: 'starting', percent: 0 });
    const settings = await swCall('getSettings');
    const dirHandle = await loadDirHandle();
    const filename = sanitizeName(job.filename, job.kind === STREAM_KIND.FILE ? job.ext : '.mp4');
    let totalOut = 0;

    if (job.kind === STREAM_KIND.FILE) {
      // ---- direct progressive file (e.g. .mp4): download the bytes and write
      // them to disk verbatim. No manifest parse, no transmux, no remux. ----
      writer = await createWriter({ saveMode: settings.saveMode, dirHandle, filename });
      totalOut = await downloadDirectFile(job, { settings, controller, t0, writer });
    } else {
      const { model, video, audio } = await loadStream(job, controller.signal);
      if (!video) throw new Error('Selected video quality not found in manifest');
      if (video.drm) throw new Error('Stream is DRM-protected and cannot be downloaded');

      // ---- progress accounting (downloads run concurrently) ----
      let vDone = 0; let vTotal = 0; let vBytes = 0;
      let aDone = 0; let aTotal = 0; let aBytes = 0;
      let lastEmit = 0;
      const emitDownload = (force) => {
        const now = Date.now();
        if (!force && now - lastEmit < LIMITS.PROGRESS_THROTTLE_MS) return;
        lastEmit = now;
        const total = (vTotal + aTotal) || 1;
        const done = vDone + aDone;
        const percent = Math.min(92, Math.round((done / total) * 92));
        progress(job.id, { phase: 'downloading', percent, bytes: vBytes + aBytes, done, total, elapsedMs: now - t0 });
      };
      const opts = (which) => ({
        connections: settings.connections,
        retries: settings.retries,
        signal: controller.signal,
        onProgress: (p) => {
          if (which === 'v') { vDone = p.done; vTotal = p.total; vBytes = p.bytes; }
          else { aDone = p.done; aTotal = p.total; aBytes = p.bytes; }
          emitDownload(false);
        },
      });

      const [vBufs, aBufs] = await Promise.all([
        downloadTrack(video, opts('v')),
        audio ? downloadTrack(audio, opts('a')) : Promise.resolve(null),
      ]);
      emitDownload(true);
      const downloadedBytes = vBytes + aBytes;

      // ---- transmux + mux, streamed straight to disk ----
      // mp4box only understands MP4/fMP4, so MPEG-TS segments are transmuxed first.
      // Everything is written in chunks rather than building the whole file in one
      // ArrayBuffer, which would fail ("Array buffer allocation failed") on long
      // videos. The container is decided by probing the bytes (hint is a fallback).
      await setActive(job, { status: 'transmuxing', phase: 'transmuxing', percent: 93 });
      writer = await createWriter({ saveMode: settings.saveMode, dirHandle, filename });

      let lastSavePct = 93;
      const writeChunk = async (chunk) => {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        await writer.write(chunk);
        totalOut += chunk.byteLength;
        // The final size of streamed output isn't known up front, so advance the
        // bar 94..99 against the downloaded byte count as an approximation.
        const pct = Math.min(99, 94 + Math.round((totalOut / (downloadedBytes || totalOut || 1)) * 5));
        if (pct !== lastSavePct) { lastSavePct = pct; progress(job.id, { phase: 'saving', percent: pct, bytes: downloadedBytes }); }
      };

      if (job.kind === STREAM_KIND.HLS && !audio) {
        // Single-stream HLS (audio muxed in, or already fMP4): write the fragmented
        // MP4 straight to disk, never holding the whole file in memory.
        progress(job.id, { phase: 'transmuxing', percent: 93, bytes: downloadedBytes });
        await writeHlsSingleStream(vBufs, video.container, writeChunk);
      } else {
        // DASH, or HLS with a separate audio track: transmux (if TS) then mux to a
        // progressive MP4 via mp4box, which yields chunks we stream out.
        progress(job.id, { phase: 'transmuxing', percent: 93, bytes: downloadedBytes });
        const vMp4 = await ensureMp4(vBufs, video.container); // frees raw TS internally
        const aMp4 = aBufs ? await ensureMp4(aBufs, audio.container) : null;
        await setActive(job, { status: 'muxing', phase: 'muxing', percent: 94 });
        progress(job.id, { phase: 'muxing', percent: 94, bytes: downloadedBytes });
        const { chunks } = muxToMp4({ video: vMp4, audio: aMp4, durationSec: model.durationSec });
        for (const c of chunks) await writeChunk(c);
      }
    }

    const result = await writer.close();

    const entry = {
      id: job.id, kind: job.kind, title: job.title, filename, quality: job.qualityLabel,
      manifestUrl: job.manifestUrl, pageUrl: job.pageUrl || '', ext: job.ext || null,
      videoRepId: job.videoRepId, audioRepId: job.audioRepId || null,
      sizeBytes: totalOut, backend: result.backend, status: 'completed', date: Date.now(),
      // For revealing the file later: chrome.downloads.show needs the id;
      // File System Access folders can only be named, not opened, so keep the name.
      downloadId: result.downloadId, folderName: settings.saveFolderName || '',
    };
    await swCall('addHistory', entry);
    await clearActive(job.id);
    progress(job.id, { phase: 'done', percent: 100, bytes: totalOut });
    send({ target: TARGET.PANEL, type: MSG.DOWNLOAD_DONE, id: job.id, entry });
    notify(settings, 'Download complete', job.title + (job.qualityLabel ? ' (' + job.qualityLabel + ')' : ''));
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    if (writer) { try { await writer.abort(); } catch { /* best effort: remove the partial file */ } }
    await clearActive(job.id);
    const entry = {
      id: job.id, kind: job.kind, title: job.title,
      filename: sanitizeName(job.filename || '', job.kind === STREAM_KIND.FILE ? job.ext : '.mp4'),
      quality: job.qualityLabel,
      manifestUrl: job.manifestUrl, pageUrl: job.pageUrl || '', ext: job.ext || null,
      videoRepId: job.videoRepId, audioRepId: job.audioRepId || null,
      status: aborted ? 'canceled' : 'failed',
      error: aborted ? undefined : String((err && err.message) || err),
      date: Date.now(),
    };
    await swCall('addHistory', entry);
    send({ target: TARGET.PANEL, type: MSG.DOWNLOAD_ERROR, id: job.id, aborted, error: entry.error || 'Canceled', entry });
  } finally {
    jobs.delete(job.id);
  }
}

// ---- stream loading (DASH or HLS) -----------------------------------------

// Fetch + parse the manifest and resolve the selected video/audio renditions.
// DASH parses synchronously; HLS additionally fetches the chosen media
// playlists to fill in their segment lists and AES-128 keys.
async function loadStream(job, signal) {
  const text = await (await fetch(job.manifestUrl, { signal, credentials: 'include' })).text();

  if (job.kind === STREAM_KIND.HLS) {
    const model = await parseHls(text, job.manifestUrl, { fetchImpl: fetch });
    const video = model.videos.find((v) => v.id === job.videoRepId) || model.videos[0];
    const audio = job.audioRepId ? (model.audios.find((a) => a.id === job.audioRepId) || null) : null;
    if (video) await resolveHlsRendition(video, { fetchImpl: fetch });
    if (audio) await resolveHlsRendition(audio, { fetchImpl: fetch });
    return { model, video, audio };
  }

  const model = parseMpd(text, job.manifestUrl);
  const video = model.videos.find((v) => v.id === job.videoRepId) || model.videos[0];
  const audio = job.audioRepId ? (model.audios.find((a) => a.id === job.audioRepId) || null) : null;
  return { model, video, audio };
}

// ---- direct file download -------------------------------------------------

// Download one self-contained file (e.g. an .mp4) and write it to disk
// unchanged. When the server honours range requests and the file is large it's
// fetched in parallel byte ranges (the engine's single-file path) for speed;
// otherwise it streams through a single connection so even huge files never sit
// whole in memory. Returns the number of bytes written.
async function downloadDirectFile(job, { settings, controller, t0, writer }) {
  const signal = controller.signal;
  const url = job.manifestUrl; // the file's URL (reuses the job's source-URL field)
  const { size, rangeSupported } = await probeFile(url, signal);
  const canSplit = rangeSupported && size >= LIMITS.RANGE_SPLIT_MIN_BYTES && settings.connections > 1;

  let lastEmit = 0;
  const emit = (phase, bytes, percent) => {
    const now = Date.now();
    if (phase === 'downloading' && percent < 96 && now - lastEmit < LIMITS.PROGRESS_THROTTLE_MS) return;
    lastEmit = now;
    progress(job.id, { phase, percent, bytes, total: size || undefined, elapsedMs: now - t0 });
  };

  if (canSplit) {
    // Parallel byte-range download via the shared engine, then write the ordered
    // parts to disk. (As with the manifest path, the file passes through memory.)
    const rep = { download: { single: true, init: null, segments: [{ url }] } };
    const parts = await downloadTrack(rep, {
      connections: settings.connections,
      retries: settings.retries,
      signal,
      onProgress: (p) => emit('downloading', p.bytes, Math.min(96, Math.round((p.done / (p.total || 1)) * 96))),
    });
    await setActive(job, { status: 'saving', phase: 'saving', percent: 97 });
    let written = 0;
    for (let i = 0; i < parts.length; i++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const chunk = parts[i] instanceof Uint8Array ? parts[i] : new Uint8Array(parts[i]);
      parts[i] = null; // release each part once written
      await writer.write(chunk);
      written += chunk.byteLength;
      emit('saving', written, Math.min(99, 97 + Math.round(((i + 1) / parts.length) * 2)));
    }
    return written;
  }

  // Single-connection streaming download straight to disk.
  return streamFileToWriter(url, { signal }, writer, (bytes) => {
    const percent = size
      ? Math.min(99, Math.round((bytes / size) * 99))
      : Math.min(95, Math.round((bytes / (bytes + 8 * 1024 * 1024)) * 100)); // unknown size: asymptotic
    emit('downloading', bytes, percent);
  });
}

// Stream a URL's response body to the writer chunk-by-chunk (low memory). No
// mid-stream resume: a network drop fails the job and the user can retry it.
async function streamFileToWriter(url, { signal }, writer, onBytes) {
  const res = await fetch(url, { signal, credentials: 'include' });
  if (!res.ok && res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
  let written = 0;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    for (;;) {
      if (signal.aborted) { try { await reader.cancel(); } catch { /* ignore */ } throw new DOMException('Aborted', 'AbortError'); }
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      await writer.write(chunk);
      written += chunk.byteLength;
      onBytes(written);
    }
  } else {
    // No streaming body: fall back to a single buffered read.
    const buf = new Uint8Array(await res.arrayBuffer());
    await writer.write(buf);
    written = buf.byteLength;
    onBytes(written);
  }
  return written;
}

// Probe a file's total size and whether the server honours range requests.
async function probeFile(url, signal) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal, credentials: 'include' });
    const cr = r.headers.get('Content-Range');
    if (r.body && r.body.cancel) { try { await r.body.cancel(); } catch { /* ignore */ } }
    if (r.status === 206 && cr && cr.includes('/')) {
      const total = parseInt(cr.split('/')[1], 10);
      if (Number.isFinite(total)) return { size: total, rangeSupported: true };
    }
    const cl = r.headers.get('Content-Length');
    return { size: cl ? parseInt(cl, 10) : 0, rangeSupported: false };
  } catch {
    return { size: 0, rangeSupported: false };
  }
}

// Ensure a track's downloaded buffers are MP4/fMP4: transmux MPEG-TS to fMP4,
// pass MP4 through unchanged. The leading bytes decide; the hint is a fallback.
async function ensureMp4(buffers, containerHint) {
  if (!buffers || !buffers.length) return buffers;
  let container = detectContainer(buffers[0]);
  if (container === 'unknown') container = containerHint;
  if (container === 'ts') {
    const out = await transmuxTsToMp4(buffers);
    buffers.length = 0; // raw TS no longer needed once transmuxed
    return [out];
  }
  return buffers; // already MP4: these buffers ARE the mux input, keep them
}

// Write a single-stream HLS rendition (no separate audio) to disk as a fragmented
// MP4: transmux TS on the fly, or write fMP4 fragments (init + media) as-is. Each
// chunk is written and released, so the whole file is never held in memory.
async function writeHlsSingleStream(buffers, containerHint, writeChunk) {
  let container = detectContainer(buffers[0]);
  if (container === 'unknown') container = containerHint;
  if (container === 'ts') { await transmuxTsToWriter(buffers, writeChunk); return; }
  for (let i = 0; i < buffers.length; i++) {
    const b = buffers[i];
    await writeChunk(b instanceof Uint8Array ? b : new Uint8Array(b));
    buffers[i] = null; // release each fragment once written
  }
}

// ---- helpers --------------------------------------------------------------

function progress(id, data) {
  send({ target: TARGET.PANEL, type: MSG.DOWNLOAD_PROGRESS, id, ...data });
}

async function setActive(job, patch) {
  await swCall('setActiveDownload', {
    id: job.id, title: job.title, quality: job.qualityLabel,
    manifestUrl: job.manifestUrl, ...patch,
  });
}

async function clearActive(id) {
  await swCall('clearActiveDownload', id);
}

function notify(settings, title, message) {
  if (!settings.notifyOnComplete) return;
  swCall('notify', title, message).catch(() => { /* notifications optional */ });
}

function sanitizeName(name, ext = '.mp4') {
  const e = /^\.[a-z0-9]+$/i.test(ext || '') ? ext.toLowerCase() : '.mp4';
  let s = (name || 'video').replace(/[\\/:*?"<>|]/g, '_'); // illegal filename chars
  s = Array.from(s).filter((ch) => ch.charCodeAt(0) >= 32).join(''); // strip control chars
  s = s.replace(/\s+/g, ' ').trim();
  if (s.toLowerCase().endsWith(e)) s = s.slice(0, -e.length).trim(); // don't double the extension
  if (!s) s = 'video';
  return s.slice(0, 180) + e; // cap the base name, then append the extension
}
