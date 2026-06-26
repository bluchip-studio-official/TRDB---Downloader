// DASH MPD parser (VOD / type="static").
//
// parseMpd(xmlText, manifestUrl, { DOMParserImpl? }) -> {
//   isDynamic, isDRM, durationSec,
//   videos: Representation[],   // sorted best-first
//   audios: Representation[],   // sorted best-first
// }
//
// Representation = {
//   id, type: 'video'|'audio', mimeType, codecs, bandwidth, lang,
//   width, height,                       // video
//   channels, samplingRate,              // audio
//   drm, segmentCount, approxBytes,
//   download: {
//     single: boolean,                   // true => one file, may be range-split for speed
//     init:  { url, range? } | null,     // init/moov segment
//     segments: [{ url, range? }],       // media segments (ordered)
//   },
// }
//
// Pure and isomorphic: uses the standard DOMParser interface, which can be
// injected for Node tests (e.g. @xmldom/xmldom) via opts.DOMParserImpl.

export function parseMpd(xmlText, manifestUrl, opts = {}) {
  const DP = opts.DOMParserImpl || (typeof DOMParser !== 'undefined' ? DOMParser : null);
  if (!DP) throw new Error('No DOMParser available');
  const doc = new DP().parseFromString(xmlText, 'application/xml');
  const mpd = first(doc, 'MPD') || doc.documentElement;
  if (!mpd || mpd.nodeName === 'parsererror') throw new Error('Invalid MPD XML');

  const isDynamic = mpd.getAttribute('type') === 'dynamic';
  const mpdDuration = parseDuration(mpd.getAttribute('mediaPresentationDuration'));
  const mpdBase = resolveBaseUrl(manifestUrl, mpd);

  // v1: use the first Period only (multi-period concat is out of scope).
  const period = first(mpd, 'Period');
  if (!period) throw new Error('No Period in MPD');
  const periodBase = resolveBaseUrl(mpdBase, period);
  const periodDuration = parseDuration(period.getAttribute('duration')) || mpdDuration || 0;

  const videos = [];
  const audios = [];
  let isDRM = false;

  for (const aset of children(period, 'AdaptationSet')) {
    const asetBase = resolveBaseUrl(periodBase, aset);
    const ctype = contentType(aset);
    if (ctype !== 'video' && ctype !== 'audio') continue;
    const asetDrm = hasContentProtection(aset);
    if (asetDrm) isDRM = true;

    const asetLang = aset.getAttribute('lang') || '';
    const asetSeg = segmentInfo(aset);

    for (const rep of children(aset, 'Representation')) {
      const repBase = resolveBaseUrl(asetBase, rep);
      const repDrm = asetDrm || hasContentProtection(rep);
      if (repDrm) isDRM = true;

      const id = rep.getAttribute('id') || '';
      const bandwidth = int(rep.getAttribute('bandwidth')) || 0;
      const mimeType = rep.getAttribute('mimeType') || aset.getAttribute('mimeType') || '';
      const codecs = rep.getAttribute('codecs') || aset.getAttribute('codecs') || '';
      const width = int(rep.getAttribute('width')) || int(aset.getAttribute('width')) || 0;
      const height = int(rep.getAttribute('height')) || int(aset.getAttribute('height')) || 0;
      const channels = audioChannels(rep) || audioChannels(aset) || 0;
      const samplingRate = int(rep.getAttribute('audioSamplingRate')) ||
        int(aset.getAttribute('audioSamplingRate')) || 0;

      const seg = mergeSegmentInfo(asetSeg, segmentInfo(rep));
      const download = buildDownload({ repBase, seg, id, bandwidth, periodDuration });
      if (!download) continue; // unsupported addressing -> skip rep

      const approxBytes = bandwidth && periodDuration
        ? Math.round((bandwidth * periodDuration) / 8) : 0;
      const model = {
        id, type: ctype, mimeType, codecs, bandwidth, lang: asetLang,
        width, height, channels, samplingRate, drm: repDrm,
        segmentCount: download.single ? 1 : (download.segments.length + (download.init ? 1 : 0)),
        approxBytes, download,
      };
      (ctype === 'video' ? videos : audios).push(model);
    }
  }

  videos.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  audios.sort((a, b) => (b.bandwidth - a.bandwidth));

  return { isDynamic, isDRM, durationSec: periodDuration, videos, audios };
}

// ---- segment addressing ---------------------------------------------------

function buildDownload({ repBase, seg, id, bandwidth, periodDuration }) {
  const vars = { RepresentationID: id, Bandwidth: bandwidth };

  if (seg.template) {
    const t = seg.template;
    const timescale = int(t.timescale) || 1;
    const startNumber = t.startNumber != null ? int(t.startNumber) : 1;
    const init = t.initialization
      ? { url: abs(repBase, fillTemplate(t.initialization, vars)) }
      : null;
    let list;
    if (t.timeline) {
      list = timelineEntries(t.timeline, timescale, periodDuration, startNumber);
    } else if (t.duration) {
      const count = Math.ceil((periodDuration * timescale) / int(t.duration));
      list = [];
      for (let i = 0; i < count; i++) list.push({ number: startNumber + i, time: i * int(t.duration) });
    } else {
      return null;
    }
    const segments = list.map((e) =>
      ({ url: abs(repBase, fillTemplate(t.media, { ...vars, Number: e.number, Time: e.time })) }));
    return { single: false, init, segments };
  }

  if (seg.list) {
    const init = seg.list.initialization
      ? { url: abs(repBase, seg.list.initialization.sourceURL || ''), range: seg.list.initialization.range }
      : null;
    const segments = seg.list.urls.map((u) => ({ url: abs(repBase, u.media || ''), range: u.mediaRange }));
    return { single: false, init, segments };
  }

  // SegmentBase or a bare BaseURL: the representation is one self-contained
  // file. Download it whole (the engine may split it into parallel ranges).
  if (repBase) return { single: true, init: null, segments: [{ url: repBase }] };
  return null;
}

function timelineEntries(timelineEl, timescale, periodDuration, startNumber) {
  const out = [];
  const S = children(timelineEl, 'S');
  let number = startNumber;
  let time = 0;
  const periodEnd = periodDuration ? periodDuration * timescale : Infinity;
  for (let i = 0; i < S.length; i++) {
    const s = S[i];
    const tAttr = s.getAttribute('t');
    if (tAttr != null && tAttr !== '') time = int(tAttr);
    const d = int(s.getAttribute('d'));
    const r = s.getAttribute('r') != null ? int(s.getAttribute('r')) : 0;
    if (r < 0) {
      const next = S[i + 1];
      const end = next && next.getAttribute('t') != null && next.getAttribute('t') !== ''
        ? int(next.getAttribute('t')) : periodEnd;
      while (time < end) { out.push({ number, time }); number++; time += d; }
    } else {
      for (let k = 0; k <= r; k++) { out.push({ number, time }); number++; time += d; }
    }
    if (out.length > 200000) break; // safety
  }
  return out;
}

// Reads SegmentTemplate / SegmentList / SegmentBase from an element.
function segmentInfo(el) {
  const out = { template: null, list: null, base: false };
  const tpl = directChild(el, 'SegmentTemplate');
  if (tpl) {
    out.template = {
      media: tpl.getAttribute('media'),
      initialization: tpl.getAttribute('initialization'),
      timescale: tpl.getAttribute('timescale'),
      duration: tpl.getAttribute('duration'),
      startNumber: tpl.getAttribute('startNumber'),
      timeline: directChild(tpl, 'SegmentTimeline'),
    };
  }
  const list = directChild(el, 'SegmentList');
  if (list) {
    const initEl = directChild(list, 'Initialization');
    out.list = {
      initialization: initEl
        ? { sourceURL: initEl.getAttribute('sourceURL'), range: initEl.getAttribute('range') }
        : null,
      urls: children(list, 'SegmentURL').map((u) => ({
        media: u.getAttribute('media'), mediaRange: u.getAttribute('mediaRange'),
      })),
    };
  }
  if (directChild(el, 'SegmentBase')) out.base = true;
  return out;
}

// Representation-level segment info overrides AdaptationSet-level.
function mergeSegmentInfo(asetSeg, repSeg) {
  return {
    template: repSeg.template || asetSeg.template,
    list: repSeg.list || asetSeg.list,
    base: repSeg.base || asetSeg.base,
  };
}

// ---- template + url helpers ----------------------------------------------

// Fill a SegmentTemplate string. Handles $RepresentationID$, $Bandwidth$,
// $Number$, $Time$ (with optional %0Nd padding) and the $$ -> $ escape.
function fillTemplate(tpl, vars) {
  if (!tpl) return '';
  let out = '';
  let i = 0;
  while (i < tpl.length) {
    const open = tpl.indexOf('$', i);
    if (open < 0) { out += tpl.slice(i); break; }
    out += tpl.slice(i, open);
    const close = tpl.indexOf('$', open + 1);
    if (close < 0) { out += tpl.slice(open); break; }
    const token = tpl.slice(open + 1, close);
    if (token === '') {
      out += '$';
    } else {
      const m = /^(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?$/.exec(token);
      if (m && vars[m[1]] != null) {
        let v = String(vars[m[1]]);
        if (m[2]) v = v.padStart(parseInt(m[2], 10), '0');
        out += v;
      } else {
        out += '$' + token + '$';
      }
    }
    i = close + 1;
  }
  return out;
}

function resolveBaseUrl(parentBase, el) {
  const b = el && directChild(el, 'BaseURL');
  const val = b && text(b);
  return val ? abs(parentBase, val) : parentBase;
}

function abs(base, rel) {
  if (!rel) return base;
  try { return new URL(rel, base).href; } catch { return rel; }
}

// ---- small DOM helpers ----------------------------------------------------

function first(parent, tag) { return parent.getElementsByTagName(tag)[0] || null; }

function children(parent, tag) {
  const out = [];
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && localName(n) === tag) out.push(n);
  }
  return out;
}

function directChild(parent, tag) {
  for (let n = parent.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && localName(n) === tag) return n;
  }
  return null;
}

function localName(node) {
  return node.localName || (node.nodeName.includes(':') ? node.nodeName.split(':').pop() : node.nodeName);
}

function text(el) { return (el.textContent || '').trim(); }
function int(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }

function contentType(aset) {
  const ct = aset.getAttribute('contentType');
  if (ct) return ct;
  const rep0 = first(aset, 'Representation');
  const mime = aset.getAttribute('mimeType') || (rep0 && rep0.getAttribute('mimeType')) || '';
  if (mime.startsWith('video')) return 'video';
  if (mime.startsWith('audio')) return 'audio';
  return 'other';
}

function audioChannels(el) {
  const c = directChild(el, 'AudioChannelConfiguration');
  return c ? int(c.getAttribute('value')) : 0;
}

function hasContentProtection(el) { return !!directChild(el, 'ContentProtection'); }

// ISO-8601 duration (e.g. PT1H2M3.5S) -> seconds, or null.
export function parseDuration(s) {
  if (!s) return null;
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return (+y || 0) * 31536000 + (+mo || 0) * 2592000 + (+d || 0) * 86400 +
    (+h || 0) * 3600 + (+mi || 0) * 60 + (+se || 0);
}
