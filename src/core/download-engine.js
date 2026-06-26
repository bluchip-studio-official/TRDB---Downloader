// Concurrent segment downloader.
//
// downloadTrack(rep, { connections, retries, signal, onProgress, fetchImpl, headers })
//   -> Promise<ArrayBuffer[]>   (ordered: init first if present, then segments)
//
// Works in any context with fetch + AbortController (offscreen document, Node).
// Progress is reported as { done, total, bytes } and is the caller's to throttle.

const RANGE_SPLIT_MIN_BYTES = 4 * 1024 * 1024;

export async function downloadTrack(rep, opts = {}) {
  const {
    connections = 5,
    retries = 3,
    signal,
    onProgress,
    fetchImpl = fetch,
    headers = {},
  } = opts;

  const requests = await buildRequests(rep, { connections, signal, fetchImpl, headers });
  const results = new Array(requests.length);
  const keyCache = new Map(); // keyUri -> Promise<CryptoKey>, for HLS AES-128
  let done = 0;
  let bytes = 0;
  let nextIndex = 0;

  const runOne = async () => {
    for (;;) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const i = nextIndex++;
      if (i >= requests.length) return;
      let buf = await fetchWithRetry(requests[i], { retries, signal, fetchImpl, headers });
      buf = await maybeDecrypt(buf, requests[i], { keyCache, signal, fetchImpl, headers });
      results[i] = buf;
      done += 1;
      bytes += buf.byteLength;
      if (onProgress) onProgress({ done, total: requests.length, bytes });
    }
  };

  const poolSize = Math.max(1, Math.min(connections, requests.length));
  await Promise.all(Array.from({ length: poolSize }, runOne));
  return results;
}

// Turn a representation's download descriptor into a flat, ordered request list.
async function buildRequests(rep, { connections, signal, fetchImpl, headers }) {
  const dl = rep.download;
  if (!dl.single) {
    const reqs = [];
    if (dl.init) reqs.push(dl.init);
    for (const s of dl.segments) reqs.push(s);
    return reqs;
  }

  // Single self-contained file: split into parallel byte ranges when worthwhile.
  const url = dl.segments[0].url;
  const size = await probeSize(url, { signal, fetchImpl, headers });
  if (!size || size < RANGE_SPLIT_MIN_BYTES || connections <= 1) {
    return [{ url }];
  }
  const parts = Math.min(connections, Math.ceil(size / RANGE_SPLIT_MIN_BYTES));
  const chunk = Math.ceil(size / parts);
  const reqs = [];
  for (let start = 0; start < size; start += chunk) {
    const end = Math.min(start + chunk - 1, size - 1);
    reqs.push({ url, range: `${start}-${end}` });
  }
  return reqs;
}

// ---- HLS AES-128 clear-key decryption -------------------------------------
// Segments tagged by the HLS parser with { key:{ method:'AES-128', keyUri, iv } }
// are decrypted here (AES-128-CBC; WebCrypto strips PKCS7 padding). The key is
// fetched once per URI and cached for the whole track. DASH segments carry no
// `key` and skip this path entirely.

async function maybeDecrypt(buf, req, ctx) {
  const k = req.key;
  if (!k || k.method !== 'AES-128') return buf;
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('WebCrypto unavailable for AES-128 decryption');
  const key = await getCryptoKey(k.keyUri, ctx, subtle);
  try {
    return await subtle.decrypt({ name: 'AES-CBC', iv: k.iv }, key, buf);
  } catch (err) {
    throw new Error('AES-128 decrypt failed: ' + ((err && err.message) || err));
  }
}

function getCryptoKey(keyUri, ctx, subtle) {
  if (!keyUri) return Promise.reject(new Error('EXT-X-KEY has no URI'));
  let p = ctx.keyCache.get(keyUri);
  if (!p) {
    p = (async () => {
      const r = await ctx.fetchImpl(keyUri, { headers: ctx.headers, credentials: 'include', signal: ctx.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching AES key`);
      const raw = await r.arrayBuffer();
      if (raw.byteLength !== 16) throw new Error(`AES-128 key must be 16 bytes, got ${raw.byteLength}`);
      return subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
    })();
    p.catch(() => ctx.keyCache.delete(keyUri)); // let a transient failure retry
    ctx.keyCache.set(keyUri, p);
  }
  return p;
}

// Probe a single file's size, but only report one when the server actually
// honours range requests (a 206 with Content-Range to our bytes=0-0 probe).
// A 200 means the server ignored the Range, so splitting into parallel ranges
// would re-download the whole file per part and corrupt the output -- report 0
// (no split) instead. DASH/HLS byte-range servers always answer 206.
async function probeSize(url, { signal, fetchImpl, headers }) {
  try {
    const r = await fetchImpl(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal, credentials: 'include' });
    const cr = r.headers.get('Content-Range'); // "bytes 0-0/12345"
    if (r.body && r.body.cancel) { try { await r.body.cancel(); } catch { /* ignore */ } }
    if (r.status === 206 && cr && cr.includes('/')) {
      const total = parseInt(cr.split('/')[1], 10);
      if (Number.isFinite(total)) return total;
    }
    return 0;
  } catch {
    return 0;
  }
}

async function fetchWithRetry(req, { retries, signal, fetchImpl, headers }) {
  let attempt = 0;
  let lastErr;
  for (;;) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const reqHeaders = { ...headers };
      if (req.range) reqHeaders.Range = `bytes=${req.range}`;
      const res = await fetchImpl(req.url, { headers: reqHeaders, signal, credentials: 'include' });
      if (!res.ok && res.status !== 206 && res.status !== 200) {
        throw new Error(`HTTP ${res.status} for ${req.url}`);
      }
      return await res.arrayBuffer();
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      lastErr = err;
      if (attempt >= retries) break;
      await delay(Math.min(1000 * 2 ** attempt, 8000), signal);
      attempt += 1;
    }
  }
  throw new Error(`Failed after ${retries + 1} attempts: ${lastErr && lastErr.message}`);
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(id);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
  });
}
