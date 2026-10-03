let deterministicContext = null;

function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function withDeterministicContext({ seed, timestamp }, fn) {
  const previous = deterministicContext;
  const parsed = Number(timestamp);
  deterministicContext = {
    seed: String(seed ?? 'transition'),
    nowMs: Number.isFinite(parsed) ? Math.trunc(parsed) : Date.now(),
    counter: 0
  };
  try {
    return fn();
  } finally {
    deterministicContext = previous;
  }
}

export function currentNowMs() {
  return deterministicContext?.nowMs ?? Date.now();
}

export function currentNowIso() {
  return new Date(currentNowMs()).toISOString();
}

export function createId(prefix = 'id') {
  if (deterministicContext) {
    const index = deterministicContext.counter++;
    const suffix = fnv1a32(`${deterministicContext.seed}:${index}:${prefix}`).toString(36).padStart(7, '0');
    return `${prefix}-${deterministicContext.nowMs.toString(36)}-${suffix}`;
  }
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}-${Date.now().toString(36)}-${random[0].toString(36)}${random[1].toString(36)}`;
}

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}


export function formatDateTime(value) {
  if (value === null || value === undefined || value === '') return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

export function deepClone(value) {
  return structuredClone(value);
}
