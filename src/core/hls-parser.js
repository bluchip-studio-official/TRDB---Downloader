// HLS (m3u8) parser. Emits the SAME model shape as mpd-parser.js so the rest of
// the pipeline (download engine, muxer, UI) is reused unchanged:
//
// parseHls(text, manifestUrl, { fetchImpl, headers }) -> {
//   kind: 'hls', isDynamic, isDRM, durationSec,
//   videos: Representation[],   // best-first
//   audios: Representation[],   // best-first
// }
//
// Representation = {
//   id,                                  // the media-playlist URL (stable, unique)
//   type: 'video'|'audio', codecs, bandwidth, lang, name,
//   width, height, channels,
//   container: 'ts'|'mp4'|'unknown',     // hint; the engine confirms by probing bytes
//   playlistUrl,                         // media playlist to resolve at download time
//   drm, durationSec, isDynamic,
//   download: { single, init, segments:[{ url, range?, key? }] } | null,  // null => lazy
//   approxBytes, segmentCount,
// }
//
// Segment key (AES-128 only): { method:'AES-128', keyUri, iv: Uint8Array(16) }.
//
// Parsing is async because a master playlist references media playlists that must
// be fetched. To keep the Detected card fast, parseHls fetches only ONE media
// playlist (the smallest video variant) to learn duration / live / DRM / container;
// the chosen rendition's full segment list is filled lazily by resolveHlsRendition.

const VIDEO_CODEC_RE = /^(avc|hvc|hev|av01|vp0?9|dvh|vvc)/i;

// Known DRM KEYFORMAT identifiers -> these playlists are not downloadable.
const DRM_KEYFORMATS = [
  'com.apple.streamingkeydelivery',                 // FairPlay
  'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',  // Widevine
  'com.widevine',
  'com.microsoft.playready',                        // PlayReady
  'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95',  // PlayReady
];

export async function parseHls(text, manifestUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const headers = opts.headers || {};
  if (!isPlaylist(text)) throw new Error('Not an HLS playlist (no #EXTM3U)');

  const lines = splitLines(text);

  // A media playlist (segments, no variants) -> single self-contained rendition.
  if (!lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const media = parseMediaPlaylist(text, manifestUrl);
    const rep = mediaToRep(media, manifestUrl, { type: 'video', id: manifestUrl, playlistUrl: manifestUrl });
    return {
      kind: 'hls',
      isDynamic: media.isDynamic,
      isDRM: media.drm,
      durationSec: media.durationSec,
      videos: [rep],
      audios: [],
    };
  }

  // Master playlist.
  const { videos, audios, sessionDrm } = parseMaster(lines, manifestUrl);
  let isDRM = sessionDrm;
  let isDynamic = false;
  let durationSec = 0;

  // Resolve the cheapest video variant once for duration / live / DRM / container.
  const probe = videos.length ? videos[videos.length - 1] : audios[0];
  if (probe && fetchImpl) {
    try {
      const media = await fetchMedia(probe.playlistUrl, { fetchImpl, headers });
      fillRepFromMedia(probe, media);
      durationSec = media.durationSec;
      isDynamic = media.isDynamic;
      if (media.drm) isDRM = true;
      // Apply the probed container hint to peers that share the same extension.
      for (const r of [...videos, ...audios]) if (r.container === 'unknown') r.container = probe.container;
    } catch { /* leave duration/flags at defaults; download will re-resolve */ }
  }

  // Mark DRM on every rep once known so the UI can block/hide consistently.
  if (isDRM) for (const r of [...videos, ...audios]) r.drm = true;

  for (const r of [...videos, ...audios]) {
    r.durationSec = durationSec;
    r.approxBytes = r.bandwidth && durationSec ? Math.round((r.bandwidth * durationSec) / 8) : 0;
  }

  videos.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  audios.sort((a, b) => (b.bandwidth - a.bandwidth));

  return { kind: 'hls', isDynamic, isDRM, durationSec, videos, audios };
}

// Fetch + parse the rendition's media playlist and fill its download descriptor.
// No-op when already resolved (media-only playlists, or the probed variant).
export async function resolveHlsRendition(rep, opts = {}) {
  if (rep.download) return rep;
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const media = await fetchMedia(rep.playlistUrl, { fetchImpl, headers: opts.headers || {} });
  fillRepFromMedia(rep, media);
  return rep;
}

// ---- master playlist ------------------------------------------------------

function parseMaster(lines, baseUrl) {
  const videos = [];
  const audios = [];
  const audioMedia = []; // { groupId, lang, name, channels, playlistUrl }
  const audioGroups = new Set();
  let sessionDrm = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-SESSION-KEY')) {
      const k = parseKeyTag(attrsOf(line), baseUrl);
      if (k && k.drm) sessionDrm = true;
    } else if (line.startsWith('#EXT-X-MEDIA')) {
      const a = attrsOf(line);
      if ((a.TYPE || '').toUpperCase() === 'AUDIO' && a.URI) {
        audioMedia.push({
          groupId: a['GROUP-ID'] || '',
          lang: a.LANGUAGE || a.NAME || '',
          name: a.NAME || a.LANGUAGE || 'audio',
          channels: int(a.CHANNELS) || 0,
          playlistUrl: abs(baseUrl, a.URI),
        });
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF')) {
      const a = attrsOf(line);
      const uri = nextUri(lines, i);
      if (!uri) continue;
      const [w, h] = resolution(a.RESOLUTION);
      const codecs = a.CODECS || '';
      if (isAudioOnlyVariant(w, h, codecs)) continue; // surfaced via EXT-X-MEDIA instead
      const playlistUrl = abs(baseUrl, uri);
      if (videos.some((v) => v.playlistUrl === playlistUrl)) continue;
      if (a.AUDIO) audioGroups.add(a.AUDIO);
      videos.push(newRep({
        type: 'video',
        id: playlistUrl,
        playlistUrl,
        bandwidth: int(a['AVERAGE-BANDWIDTH']) || int(a.BANDWIDTH) || 0,
        codecs,
        width: w,
        height: h,
        container: containerHint(uri),
      }));
    }
  }

  // Only expose audio renditions actually referenced by a video variant's group
  // (renditions with no group, or in-band audio, would otherwise double up).
  for (const m of audioMedia) {
    if (audioGroups.size && !audioGroups.has(m.groupId)) continue;
    if (audios.some((x) => x.playlistUrl === m.playlistUrl)) continue;
    audios.push(newRep({
      type: 'audio',
      id: m.playlistUrl,
      playlistUrl: m.playlistUrl,
      bandwidth: 0,
      lang: m.lang,
      name: m.name,
      channels: m.channels,
      container: containerHint(m.playlistUrl),
    }));
  }

  return { videos, audios, sessionDrm };
}

function isAudioOnlyVariant(w, h, codecs) {
  if (w || h) return false;
  if (!codecs) return false; // unknown -> assume video so it stays selectable
  const list = codecs.split(',').map((c) => c.trim());
  return list.length > 0 && !list.some((c) => VIDEO_CODEC_RE.test(c));
}

// ---- media playlist -------------------------------------------------------

function parseMediaPlaylist(text, baseUrl) {
  const lines = splitLines(text);
  const segments = [];
  let init = null;
  let key = null;       // current EXT-X-KEY in effect (null = clear)
  let drm = false;
  let mediaSeq = 0;
  let hasEndList = false;
  let playlistType = '';
  let pendingDur = 0;
  let pendingRange = null;     // { length, offset|null }
  let durationSec = 0;
  const lastEnd = new Map();   // url -> next default byte offset (EXT-X-BYTERANGE)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
      mediaSeq = int(line.split(':')[1]);
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE')) {
      playlistType = (line.split(':')[1] || '').trim().toUpperCase();
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      hasEndList = true;
    } else if (line.startsWith('#EXT-X-MAP')) {
      const a = attrsOf(line);
      init = { url: abs(baseUrl, a.URI || '') };
      const r = byteRange(a.BYTERANGE, lastEnd, init.url);
      if (r) init.range = r;
    } else if (line.startsWith('#EXT-X-KEY')) {
      const k = parseKeyTag(attrsOf(line), baseUrl);
      if (!k || k.method === 'NONE') key = null;
      else { key = k; if (k.drm) drm = true; }
    } else if (line.startsWith('#EXT-X-BYTERANGE')) {
      pendingRange = line.split(':')[1] || '';
    } else if (line.startsWith('#EXTINF')) {
      pendingDur = parseFloat((line.split(':')[1] || '0').split(',')[0]) || 0;
    } else if (line && !line.startsWith('#')) {
      const url = abs(baseUrl, line);
      const seq = mediaSeq + segments.length;
      const seg = { url };
      const r = byteRange(pendingRange, lastEnd, url);
      if (r) seg.range = r;
      if (key && key.method === 'AES-128') {
        seg.key = { method: 'AES-128', keyUri: key.keyUri, iv: key.iv || seqToIv(seq) };
        if (init && !init.key) init.key = { method: 'AES-128', keyUri: key.keyUri, iv: key.iv || seqToIv(seq) };
      }
      segments.push(seg);
      durationSec += pendingDur;
      pendingDur = 0;
      pendingRange = null;
    }
  }

  const isDynamic = !hasEndList && playlistType !== 'VOD';
  const container = init ? 'mp4' : containerHint(segments.length ? segments[0].url : '');
  return { segments, init, drm, isDynamic, durationSec, container };
}

function mediaToRep(media, baseUrl, base) {
  const rep = newRep({ ...base, container: media.container });
  fillRepFromMedia(rep, media);
  rep.durationSec = media.durationSec;
  rep.approxBytes = 0;
  return rep;
}

function fillRepFromMedia(rep, media) {
  rep.download = { single: false, init: media.init, segments: media.segments };
  rep.container = media.container;
  rep.drm = rep.drm || media.drm;
  rep.isDynamic = media.isDynamic;
  rep.durationSec = media.durationSec || rep.durationSec;
  rep.segmentCount = media.segments.length + (media.init ? 1 : 0);
}

async function fetchMedia(url, { fetchImpl, headers }) {
  if (!fetchImpl) throw new Error('No fetch available to resolve HLS media playlist');
  const res = await fetchImpl(url, { headers, credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching media playlist');
  return parseMediaPlaylist(await res.text(), url);
}

// ---- EXT-X-KEY ------------------------------------------------------------

function parseKeyTag(a, baseUrl) {
  const method = (a.METHOD || 'NONE').toUpperCase();
  if (method === 'NONE') return { method: 'NONE' };
  const keyformat = (a.KEYFORMAT || 'identity').toLowerCase();
  const isDrmFormat = DRM_KEYFORMATS.some((f) => keyformat.includes(f.toLowerCase()));
  // AES-128 with the default "identity" key format is clear-key (downloadable).
  // SAMPLE-AES (and any explicit DRM key format) we treat as DRM.
  const drm = method.startsWith('SAMPLE-AES') || isDrmFormat;
  return {
    method,
    keyUri: a.URI ? abs(baseUrl, a.URI) : '',
    iv: a.IV ? hexToBytes(a.IV) : null,
    keyformat,
    drm,
  };
}

// ---- small helpers --------------------------------------------------------

function newRep(o) {
  return {
    id: o.id, type: o.type, codecs: o.codecs || '', bandwidth: o.bandwidth || 0,
    lang: o.lang || '', name: o.name || '', width: o.width || 0, height: o.height || 0,
    channels: o.channels || 0, samplingRate: 0,
    container: o.container || 'unknown', playlistUrl: o.playlistUrl,
    drm: false, durationSec: 0, isDynamic: false,
    download: o.download || null, approxBytes: 0, segmentCount: 0,
  };
}

function isPlaylist(text) { return /^\s*#EXTM3U/.test(text); }

function splitLines(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

function nextUri(lines, i) {
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j] && !lines[j].startsWith('#')) return lines[j];
    if (lines[j].startsWith('#EXT-X-STREAM-INF')) return null;
  }
  return null;
}

// Parse a quoted/unquoted HLS attribute list into a plain object.
function attrsOf(line) {
  const out = {};
  const body = line.slice(line.indexOf(':') + 1);
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(body))) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function resolution(s) {
  if (!s) return [0, 0];
  const m = /(\d+)x(\d+)/i.exec(s);
  return m ? [int(m[1]), int(m[2])] : [0, 0];
}

// "<length>[@<offset>]" -> "start-end" for the engine's Range header. With no
// offset, the sub-range continues from the previous one for the same URL.
function byteRange(spec, lastEnd, url) {
  if (!spec) return null;
  const m = /(\d+)(?:@(\d+))?/.exec(spec);
  if (!m) return null;
  const length = int(m[1]);
  const offset = m[2] != null ? int(m[2]) : (lastEnd.get(url) || 0);
  lastEnd.set(url, offset + length);
  return `${offset}-${offset + length - 1}`;
}

function containerHint(url) {
  const path = stripQuery(url).toLowerCase();
  if (/\.(m4s|mp4|cmf[va]?|m4v|m4a|fmp4)$/.test(path)) return 'mp4';
  if (/\.(ts|m2ts|aac|mp3|ac3|ec3)$/.test(path)) return 'ts';
  return 'unknown';
}

function seqToIv(seq) {
  const iv = new Uint8Array(16);
  let n = BigInt(seq >>> 0) + (BigInt(Math.floor(seq / 2 ** 32)) << 32n);
  for (let i = 15; i >= 0 && n > 0n; i--) { iv[i] = Number(n & 0xffn); n >>= 8n; }
  return iv;
}

function hexToBytes(hex) {
  let s = String(hex).trim();
  if (s.startsWith('0x') || s.startsWith('0X')) s = s.slice(2);
  if (s.length % 2) s = '0' + s;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

function abs(base, rel) {
  if (!rel) return base;
  try { return new URL(rel, base).href; } catch { return rel; }
}

function stripQuery(url) { const i = url.indexOf('?'); return i < 0 ? url : url.slice(0, i); }
function int(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }
