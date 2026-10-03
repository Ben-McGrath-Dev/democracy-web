export function estimateCloudClock({ serverAt, clientSentAt = null, receivedAt }) {
  const server = Number(serverAt);
  const received = Number(receivedAt);
  if (!Number.isFinite(server) || server <= 0 || !Number.isFinite(received) || received <= 0) throw new Error('Valid server and receive timestamps are required.');
  const sent = Number(clientSentAt);
  if (Number.isFinite(sent) && sent > 0 && sent <= received) {
    const rttMs = Math.max(0, received - sent);
    return { offsetMs: Math.round(server - (sent + rttMs / 2)), rttMs: Math.round(rttMs) };
  }
  return { offsetMs: Math.round(server - received), rttMs: null };
}

export function cloudNow(localNow = Date.now(), offsetMs = 0) {
  return Number(localNow) + Number(offsetMs || 0);
}
