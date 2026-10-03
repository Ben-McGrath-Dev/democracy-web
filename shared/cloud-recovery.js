export const CLOUD_SNAPSHOT_CHUNK_BYTES = 256 * 1024;

export function splitUtf8Text(text, maxBytes = CLOUD_SNAPSHOT_CHUNK_BYTES) {
  const value = String(text ?? '');
  const limit = Math.max(1024, Number(maxBytes) || CLOUD_SNAPSHOT_CHUNK_BYTES);
  const encoder = new TextEncoder();
  const chunks = [];
  let start = 0;
  while (start < value.length) {
    let low = start + 1;
    let high = value.length;
    let best = start + 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (encoder.encode(value.slice(start, mid)).byteLength <= limit) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    // Avoid splitting a UTF-16 surrogate pair at the chunk boundary.
    if (best < value.length && best > start) {
      const prev = value.charCodeAt(best - 1);
      const next = value.charCodeAt(best);
      if (prev >= 0xD800 && prev <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) best -= 1;
    }
    if (best <= start) throw new Error('Snapshot chunk size is too small for the next character.');
    chunks.push(value.slice(start, best));
    start = best;
  }
  return chunks;
}

export function joinSnapshotChunks(chunks, expectedCount = null) {
  if (!Array.isArray(chunks)) throw new Error('Snapshot chunks must be an array.');
  if (expectedCount != null && chunks.length !== Number(expectedCount)) throw new Error('Persistent snapshot is incomplete.');
  return chunks.join('');
}
