// Writes the muxed MP4 to disk. Two backends:
//   - 'fsaccess'  : stream chunks straight to a file in the user's chosen
//                   FileSystemDirectoryHandle (low memory, any folder).
//   - 'downloads' : buffer chunks, then hand a blob to chrome.downloads
//                   (Downloads folder only; whole file held in memory).
//
// createWriter({ saveMode, dirHandle, filename }) -> writer
//   writer.write(chunk: Uint8Array) ; writer.close() -> { savedAs, backend } ; writer.abort()

export async function createWriter({ saveMode, dirHandle, filename }) {
  if (saveMode === 'fsaccess' && dirHandle) {
    // This runs in the offscreen document, which has no user activation, so we
    // can only *check* permission, never request it. If the grant established in
    // the side panel isn't visible here, fall back to the Downloads folder
    // rather than failing the whole download.
    const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') return createFsWriter(dirHandle, filename);
    console.warn('[file-writer] folder permission not granted in offscreen; saving to Downloads instead');
  }
  return createDownloadsWriter(filename);
}

async function createFsWriter(dirHandle, filename) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  return {
    backend: 'fsaccess',
    async write(chunk) { await writable.write(chunk); },
    async close() { await writable.close(); return { savedAs: filename, backend: 'fsaccess' }; },
    async abort() {
      try { await writable.abort(); } catch { /* ignore */ }
      try { await dirHandle.removeEntry(filename); } catch { /* ignore */ }
    },
  };
}

function createDownloadsWriter(filename) {
  const parts = [];
  return {
    backend: 'downloads',
    async write(chunk) { parts.push(chunk); },
    async close() {
      const blob = new Blob(parts, { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      parts.length = 0;
      return { savedAs: filename, backend: 'downloads', downloadId };
    },
    async abort() { parts.length = 0; },
  };
}
