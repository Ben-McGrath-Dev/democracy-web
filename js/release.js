import { APP_VERSION } from './config.js';
import { securitySummary } from './security.js';
import { verifyEventChain } from './integrity.js';
import { auditState, offlineReadiness } from './diagnostics.js';

export const RELEASE_CHANNEL = 'stable';
export const RELEASE_DATE = '2026-10-03';
export const RELEASE_NAME = 'Democracy Web 1.0.3';

export const RELEASE_HIGHLIGHTS = [
  'Offline and P2P multiplayer Democracy games',
  'Elections, Parliament, government, laws and constitutional amendments',
  'AC / PC / PAC / PPC committees, juries and law cases',
  'Persistent cryptographic player identities and signed multiplayer actions',
  'Sealed secret ballots with local/recovery-key post-close verification',
  'Lobby Owner migration, reconnect and recovery tooling',
  'Installable PWA, mobile UI, notifications and accessibility support',
  'Automated rule-property tests and multiplayer stress tooling'
];

export const KNOWN_LIMITATIONS = [
  'TURN relay fallback is supported, but relay credentials must be supplied by the user or deployment; Democracy Web does not bundle a public TURN account.',
  'Trystero 0.25.4 is version-pinned but still runtime-loaded from CDN providers; local vendoring remains a supply-chain hardening item.',
  'Plain HTTP private-LAN testing runs in explicitly insecure LAN Test Mode; production games should use HTTPS.',
  'The browser holding a sealed ballot-box private key can technically decrypt before close; threshold/mix-net secrecy remains future work.',
  'A sealed ballot should have an exported recovery package if the ballot-box holder may disappear before close.',
  'Public lobby discovery is intentionally not included; games are invite-based.',
  'Real-world maximum lobby size depends on browsers, devices and network topology; the built-in stress test is synthetic.'
];

export function releaseReadiness(state, networkStatus = {}) {
  const security = securitySummary();
  const history = state ? verifyEventChain(state.history ?? []) : { ok: true, count: 0 };
  const audit = state ? auditState(state) : null;
  const offline = state ? offlineReadiness(state) : null;
  return [
    { label: 'Stable build', ok: APP_VERSION.startsWith('1.0.'), detail: `v${APP_VERSION} · ${RELEASE_CHANNEL}` },
    { label: 'Secure production context', ok: security.mode === 'secure', detail: security.mode === 'secure' ? 'Full cryptographic features available' : `${security.mode} — acceptable for development only` },
    { label: 'Official history integrity', ok: history.ok, detail: state ? `${history.count} chained event(s)` : 'No save loaded' },
    { label: 'Current state integrity', ok: !audit || audit.errors === 0, detail: audit ? `${audit.errors} error(s), ${audit.warnings} warning(s)` : 'No save loaded' },
    { label: 'Offline political engine', ok: !offline || offline.ready, detail: offline ? `${offline.completed}/${offline.total} readiness checks` : 'No save loaded' },
    { label: 'Networking layer', ok: Boolean(networkStatus.mode || networkStatus.status), detail: networkStatus.mode ? `${networkStatus.mode} · ${networkStatus.status ?? 'idle'}` : 'Available when Multiplayer is opened' }
  ];
}

export function buildDiagnosticReport({ state = null, networkStatus = {}, recentErrors = [] } = {}) {
  const security = securitySummary();
  const history = state ? verifyEventChain(state.history ?? []) : null;
  const audit = state ? auditState(state) : null;
  const report = {
    product: RELEASE_NAME,
    version: APP_VERSION,
    channel: RELEASE_CHANNEL,
    releaseDate: RELEASE_DATE,
    generatedAt: new Date().toISOString(),
    browser: navigator.userAgent,
    language: navigator.language,
    online: navigator.onLine,
    secureContext: globalThis.isSecureContext,
    securityMode: security.mode,
    game: state ? {
      id: state.meta?.id,
      name: state.meta?.name,
      schemaVersion: state.schemaVersion,
      stateVersion: state.stateVersion,
      players: Object.keys(state.players ?? {}).length,
      parties: Object.keys(state.parties ?? {}).length,
      votes: Object.keys(state.votes ?? {}).length,
      cases: Object.keys(state.cases ?? {}).length,
      historyEvents: state.history?.length ?? 0,
      historyIntegrity: history?.ok ?? null,
      auditErrors: audit?.errors ?? null,
      auditWarnings: audit?.warnings ?? null
    } : null,
    network: {
      mode: networkStatus.mode ?? null,
      status: networkStatus.status ?? null,
      roomCode: networkStatus.roomCode ? '[redacted]' : null,
      peers: networkStatus.connectedPeers?.length ?? networkStatus.peerCount ?? null,
      authorityEpoch: networkStatus.authorityEpoch ?? null
    },
    recentErrors: recentErrors.slice(-10).map(item => ({ at: item.at, type: item.type, message: item.message }))
  };
  return JSON.stringify(report, null, 2);
}
