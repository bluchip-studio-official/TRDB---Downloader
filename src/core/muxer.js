// mp4box.js muxer: combine downloaded DASH media for a video track and an
// optional audio track into one progressive MP4, losslessly (no re-encode).
//
// We extract every sample and rebuild via mp4box addSample, producing a normal
// non-fragmented MP4 (one moov with full stbl, then mdat). An earlier version
// reused the original DASH moof/mdat fragments interleaved per track; that is
// spec-valid but some players (notably VLC) mishandle the interleaved
// single-track-moof layout and drop audio periodically, so we always rebuild.
//
// Relies on mp4box globals (MP4Box / BoxParser / DataStream), set by a classic
// <script> tag in the extension, or by indirect-eval in the Node tests.
//
// muxToMp4({ video: ArrayBuffer[], audio?: ArrayBuffer[], durationSec? })
//   -> { chunks: Uint8Array[] }   (write sequentially; concat for a single blob)

const VIDEO_CONFIG_BOXES = ['avcC', 'hvcC', 'av1C', 'vpcC'];
const AUDIO_CONFIG_BOXES = ['esds', 'dOps', 'dac3', 'dec3', 'dfLa', 'mhaC'];
const AUX_BOXES = new Set(['btrt', 'pasp', 'colr', 'clap', 'sinf', 'saiz', 'saio', 'fiel']);

function lib() {
  const g = globalThis;
  if (!g.MP4Box || !g.BoxParser || !g.DataStream) {
    throw new Error('mp4box not loaded (need global MP4Box/BoxParser/DataStream)');
  }
  return g;
}

export function muxToMp4({ video, audio }) {
  if (!video || !video.length) throw new Error('No video data to mux');
  const v = probe(video);

  // Source already carries audio (muxed) and the caller asked for no separate
  // audio: it's a complete file already -> pass through unchanged.
  if ((!audio || !audio.length) && v.info.tracks.length >= 2) {
    return { chunks: [v.bytes] };
  }

  const a = audio && audio.length ? probe(audio) : null;
  return muxBySamples(v, a);
}

function addInitTrack(out, p, durationSec, movieTs) {
  const t = p.track;
  const opts = {
    type: p.entry.type,
    timescale: t.timescale,
    media_duration: durationSec ? Math.round(durationSec * t.timescale) : 0,
    duration: durationSec ? Math.round(durationSec * movieTs) : 0,
    language: t.language && t.language !== 'und' ? t.language : undefined,
    description: p.description,
  };
  if (t.video) {
    opts.hdlr = 'vide';
    opts.width = t.video.width;
    opts.height = t.video.height;
  } else if (t.audio) {
    opts.hdlr = 'soun';
    opts.channel_count = t.audio.channel_count || 2;
    opts.samplesize = t.audio.sample_size || 16;
    opts.samplerate = t.audio.sample_rate || 48000;
  }
  return out.addTrack(opts);
}

// ---- extract samples + rebuild as a progressive (non-fragmented) MP4 ------
//
// mp4box's addSample only emits one moof+mdat per sample (fragmented). We need
// a plain moov (full stbl) + a single mdat, so we let mp4box build the moov and
// stsd via addTrack, then fill the sample tables and append one mdat ourselves.

function muxBySamples(v, a) {
  const { MP4Box, BoxParser, DataStream } = lib();
  const out = MP4Box.createFile();

  const parts = [extractSamples(v)];
  if (a) parts.push(extractSamples(a));
  const movieTs = parts[0].track.timescale;

  const tracks = parts.map((p) => buildTrack(out, p, movieTs, BoxParser));

  // Non-fragmented: drop the movie-extends box mp4box adds for fragmentation.
  if (out.moov.mvex) {
    out.moov.boxes = out.moov.boxes.filter((b) => b !== out.moov.mvex);
    out.moov.mvex = null;
  }
  const movieDur = Math.max(...tracks.map((t) => scale(t.mediaDuration, t.timescale, movieTs)));
  if (out.moov.mvhd) { out.moov.mvhd.timescale = movieTs; out.moov.mvhd.duration = movieDur; }

  // One chunk per track. Chunk offsets need the final moov size, so measure the
  // header (ftyp + moov) with placeholder offsets first, then point each chunk
  // into the single mdat that follows (offset-only edit -> moov size unchanged).
  let mdatPayload = 0;
  for (const t of tracks) mdatPayload += t.data.byteLength;
  let dataStart = measure(out, DataStream) + 8; // +8 for the mdat box header
  for (const t of tracks) {
    t.stco.chunk_offsets = [dataStart];
    dataStart += t.data.byteLength;
  }

  // Stream the output as separate chunks (ftyp+moov header, the mdat box header,
  // then each track's sample data) instead of mp4box's getBuffer(), which would
  // allocate the entire file as one ArrayBuffer -- and on top of the mdat concat,
  // that doubles peak memory and fails ("Array buffer allocation failed") on long
  // videos. The file-writer writes these chunks sequentially. (32-bit mdat size;
  // outputs <4 GiB, matching the previous getBuffer() path.)
  const header = serialize(out, DataStream);
  const mdatHeader = new Uint8Array(8);
  new DataView(mdatHeader.buffer).setUint32(0, mdatPayload + 8);
  mdatHeader.set([0x6d, 0x64, 0x61, 0x74], 4); // 'mdat'
  return { chunks: [header, mdatHeader, ...tracks.map((t) => t.data)] };
}

// Build a track via mp4box (moov/tkhd/mdia/stsd), then populate its sample
// tables (stts/stsc/stsz/stco, plus ctts/stss when needed) and return the
// concatenated sample data plus the stco box for later offset patching.
function buildTrack(out, parsed, movieTs, BoxParser) {
  const samples = parsed.samples;
  const ts = parsed.track.timescale || 1;
  const id = addInitTrack(out, parsed, parsed.mediaDuration / ts, movieTs);
  const trak = out.getTrackById(id);
  const stbl = trak.mdia.minf.stbl;
  const isVideo = !!parsed.track.video;

  const stts = childBox(stbl, 'stts');
  stts.sample_counts = []; stts.sample_deltas = [];
  for (const s of samples) {
    const n = stts.sample_deltas.length;
    if (n && stts.sample_deltas[n - 1] === s.duration) stts.sample_counts[n - 1] += 1;
    else { stts.sample_deltas.push(s.duration); stts.sample_counts.push(1); }
  }

  const stsz = childBox(stbl, 'stsz');
  stsz.sample_sizes = samples.map((s) => s.size);

  const stsc = childBox(stbl, 'stsc');
  stsc.first_chunk = [1]; stsc.samples_per_chunk = [samples.length]; stsc.sample_description_index = [1];

  const stco = childBox(stbl, 'stco');
  stco.chunk_offsets = [0]; // patched once the moov size is known

  // ctts: composition offsets (B-frame reordering). Skip when all zero.
  let ctts = null;
  if (samples.some((s) => (s.cts - s.dts) !== 0)) {
    ctts = new BoxParser.cttsBox();
    ctts.sample_counts = []; ctts.sample_offsets = [];
    for (const s of samples) {
      const off = s.cts - s.dts;
      const n = ctts.sample_offsets.length;
      if (n && ctts.sample_offsets[n - 1] === off) ctts.sample_counts[n - 1] += 1;
      else { ctts.sample_offsets.push(off); ctts.sample_counts.push(1); }
    }
  }

  // stss: sync samples (video only, and only if not every sample is a sync).
  let stss = null;
  if (isVideo) {
    const sync = [];
    samples.forEach((s, i) => { if (s.is_sync) sync.push(i + 1); });
    if (sync.length && sync.length !== samples.length) {
      stss = new BoxParser.stssBox();
      stss.sample_numbers = sync;
    }
  }

  // Conventional stbl child order.
  stbl.boxes = [stbl.stsd, stts, ctts, stss, stsc, stsz, stco].filter(Boolean);

  return { id, stco, mediaDuration: parsed.mediaDuration, timescale: ts, data: concat(samples.map((s) => s.data)) };
}

// Serialize the current boxes (ftyp + moov; mdat is streamed separately) to bytes.
function serialize(out, DataStream) {
  const ds = new DataStream();
  ds.endianness = DataStream.BIG_ENDIAN;
  for (const b of out.boxes) b.write(ds);
  return new Uint8Array(ds.buffer);
}

// Byte length of ftyp + moov, used to compute mdat chunk offsets.
function measure(out, DataStream) {
  return serialize(out, DataStream).byteLength;
}

function childBox(stbl, type) {
  return stbl.boxes.find((b) => b.type === type) || stbl[type];
}

function extractSamples(p) {
  const { MP4Box } = lib();
  const file = MP4Box.createFile();
  let parseError = null;
  const samples = [];
  file.onError = (e) => { parseError = e; };
  file.onReady = (inf) => {
    const tr = inf.tracks[0];
    file.setExtractionOptions(tr.id, null, { nbSamples: (tr.nb_samples || 0) + 1 });
    file.start();
  };
  file.onSamples = (id, user, s) => { for (const x of s) samples.push(x); };
  const ab = p.bytes.buffer.slice(p.bytes.byteOffset, p.bytes.byteOffset + p.bytes.byteLength);
  ab.fileStart = 0;
  file.appendBuffer(ab);
  file.flush();
  if (parseError) throw new Error('mp4box parse error: ' + parseError);
  if (!samples.length) throw new Error('No samples extracted from media data');
  let mediaDuration = 0;
  for (const s of samples) mediaDuration += s.duration;
  return { track: p.track, entry: p.entry, description: p.description, samples, mediaDuration };
}

// ---- shared parsing -------------------------------------------------------

function probe(buffers) {
  const { MP4Box } = lib();
  const bytes = concat(buffers);
  const ab = bytes.buffer;
  ab.fileStart = 0;

  const file = MP4Box.createFile();
  let info = null;
  let parseError = null;
  file.onError = (e) => { parseError = e; };
  file.onReady = (inf) => { info = inf; };
  file.appendBuffer(ab);
  file.flush();

  if (parseError) throw new Error('mp4box parse error: ' + parseError);
  if (!info || !info.tracks.length) throw new Error('No track found in media data');

  const track = info.tracks[0];
  const entry = file.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0];
  const description = extractConfig(entry, bytes);
  return { bytes, info, track, entry, description };
}

function extractConfig(entry, bytes) {
  const wanted = [...VIDEO_CONFIG_BOXES, ...AUDIO_CONFIG_BOXES];
  let cfg = (entry.boxes || []).find((b) => wanted.includes(b.type));
  if (!cfg) cfg = (entry.boxes || []).find((b) => !AUX_BOXES.has(b.type));
  if (!cfg) throw new Error('No codec configuration box found for ' + entry.type);
  const payload = bytes.slice(cfg.start + 8, cfg.start + cfg.size);
  return rawBox(cfg.type, payload);
}

// A minimal mp4box-compatible box that re-emits captured raw config bytes.
function rawBox(type, payload) {
  return {
    type,
    size: 0,
    write(stream) {
      this.size = 8 + payload.length;
      stream.writeUint32(this.size);
      stream.writeString(type, null, 4);
      stream.writeUint8Array(payload);
    },
  };
}

// ---- byte helpers ---------------------------------------------------------

function concat(buffers) {
  // Avoid a full-size copy when there's nothing to join (e.g. a single passed-
  // through / transmuxed buffer): view the existing memory instead.
  if (buffers.length === 1) {
    const b = buffers[0];
    return b instanceof Uint8Array ? b : new Uint8Array(b);
  }
  let total = 0;
  for (const b of buffers) total += b.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of buffers) { out.set(new Uint8Array(b), off); off += b.byteLength; }
  return out;
}

function scale(value, fromTs, toTs) {
  if (!fromTs || fromTs === toTs) return value;
  return Math.round((value * toTs) / fromTs);
}
