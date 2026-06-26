// MPEG-2 TS -> fragmented-MP4 transmuxing via mux.js, so HLS .ts segments can
// flow into the existing mp4box muxer (which only understands MP4/fMP4).
//
// Relies on the muxjs global, set by a classic <script> tag in the extension
// (vendor/mux.js) or by the Node test loader (test/load-muxjs.mjs).
//
// transmuxTsToMp4(buffers: (ArrayBuffer|Uint8Array)[]) -> Promise<ArrayBuffer>
//   Concatenates the produced init segment + media data into one fMP4 buffer.
// detectContainer(bytes) -> 'ts' | 'mp4' | 'unknown'   (probes the leading bytes)

const MP4_BOX_TYPES = new Set(['ftyp', 'styp', 'moof', 'moov', 'sidx', 'mdat', 'free', 'skip', 'emsg']);

function lib() {
  const g = globalThis;
  if (!g.muxjs || !g.muxjs.mp4 || !g.muxjs.mp4.Transmuxer) {
    throw new Error('mux.js not loaded (need global muxjs.mp4.Transmuxer)');
  }
  return g.muxjs;
}

export function detectContainer(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!u.length) return 'unknown';
  // TS packets are 188 bytes and begin with the 0x47 sync byte.
  if (u.length >= 189 && u[0] === 0x47 && u[188] === 0x47) return 'ts';
  // MP4 / fMP4: a top-level box is size(4) + a 4-char type.
  if (u.length >= 8) {
    const type = String.fromCharCode(u[4], u[5], u[6], u[7]);
    if (MP4_BOX_TYPES.has(type)) return 'mp4';
  }
  if (u[0] === 0x47) return 'ts';        // TS without 188-alignment at offset 0
  if (u[0] === 0xff && (u[1] & 0xf6) === 0xf0) return 'ts'; // raw ADTS AAC (mux.js handles it)
  if (u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33) return 'ts'; // ID3-prefixed packed audio
  return 'unknown';
}

export function transmuxTsToMp4(buffers) {
  const muxjs = lib();
  return new Promise((resolve, reject) => {
    const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
    let initSegment = null;
    const datas = [];
    transmuxer.on('data', (event) => {
      if (!initSegment && event.initSegment) initSegment = event.initSegment;
      if (event.data) datas.push(event.data);
    });
    transmuxer.on('done', () => {
      if (!initSegment || !datas.length) {
        reject(new Error('Transmux produced no MP4 output (input may not be MPEG-TS)'));
        return;
      }
      resolve(concat([initSegment, ...datas]).buffer);
    });
    try {
      for (const ab of buffers) {
        transmuxer.push(ab instanceof Uint8Array ? ab : new Uint8Array(ab));
      }
      transmuxer.flush();
    } catch (err) {
      reject(err);
    }
  });
}

// Streaming variant: transmux MPEG-TS and hand each produced fMP4 fragment
// (init segment first, then media) to `onChunk` so it can be written straight to
// disk -- the whole file is never held in memory at once. Raw input buffers are
// released as they are pushed (mux.js copies them internally). `onChunk` may be
// async; calls are serialized. Resolves with the total bytes written.
export function transmuxTsToWriter(buffers, onChunk) {
  const muxjs = lib();
  return new Promise((resolve, reject) => {
    const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
    let initSegment = null;
    let total = 0;
    let chain = Promise.resolve();
    const queue = (part) => {
      if (!part || !part.byteLength) return;
      total += part.byteLength;
      chain = chain.then(() => onChunk(part));
    };
    transmuxer.on('data', (event) => {
      if (!initSegment && event.initSegment) { initSegment = event.initSegment; queue(initSegment); }
      queue(event.data);
    });
    transmuxer.on('done', () => {
      chain.then(() => {
        if (!initSegment || !total) reject(new Error('Transmux produced no MP4 output (input may not be MPEG-TS)'));
        else resolve(total);
      }, reject);
    });
    try {
      for (let i = 0; i < buffers.length; i++) {
        const ab = buffers[i];
        transmuxer.push(ab instanceof Uint8Array ? ab : new Uint8Array(ab));
        buffers[i] = null; // free the raw segment once mux.js has copied it
      }
      transmuxer.flush();
    } catch (err) {
      reject(err);
    }
  });
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}
