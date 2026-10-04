import { APP_VERSION } from './config.js';
import { securitySummary } from './security.js';
import { verifyEventChain } from './integrity.js';
import { auditState, offlineReadiness } from './diagnostics.js';

export const RELEASE_CHANNEL = 'preview';
export const RELEASE_DATE = '2026-10-04';
export const RELEASE_NAME = 'Democracy Web 1.2 Frontend Second Pass';

export const RELEASE_HIGHLIGHTS = [
  'Phases 68–69 Laws/Constitution and Committees/Cases polish with equal desktop and mobile information architecture',
  'Legislation workspaces, searchable constitutional contents/deep links, richer committee workspaces and procedural case records',
  'Phases 66–67 voting/election and Parliament/Government UX overhaul with mobile-first action ordering',
  'Pending ballots are surfaced first; elections have lifecycle summaries and government formation has live majority feedback',
  'Phases 61–63 deep-linked object pages with unified status language and rulebook-aware contextual guidance',
  'My Actions terminology avoids conflict with AC, which is reserved for the constitutional Actions Committee',
  'Phase 59 personal My Actions with required actions, upcoming deadlines, explanation panels and reminder snoozing',
  'Phase 60 shared search, filters, sorting, result counts and remembered list preferences across core political pages',
  'Phase 57 design-system foundations with expanded tokens and reusable semantic component states',
  'Phase 58 navigation overhaul with remembered collapsible groups, actionable badges and persistent player/connection context',
  'Global Ctrl/Cmd+K command search across pages and current Democracy objects',
  'Browser Back/Forward navigation now preserves useful route scroll positions',
  'Contextual Democracy Coach that surfaces useful next steps without changing official state',
  'Redesigned committee and case workflows with clearer membership, recusals, panels, juries and process stages',
  'Player profiles and official activity timeline for long-running political history',
  'Simple and Advanced interface modes with improved mobile presentation',
  'Role-aware frontend that prioritises controls relevant to the connected player',
  'Visual election results including ranked-choice rounds and largest-remainder explanations',
  'Redesigned Parliament and Government composition views',
  'Redesigned legislative and constitutional workflows with document comparisons',
  'Cloudflare Durable Object multiplayer replaces WebRTC/P2P',
  'Player-signed canonical actions with deterministic client-side verification',
  'Automatic reconnect, verified commit resume and persistent snapshot recovery',
  'Cloud canonical time for multiplayer deadlines',
  'Secure join approval bound to cryptographic player identities',
  'Shared deterministic political core used by browser and Worker',
  'Offline/local Democracy games remain fully supported',
  'Elections, Parliament, government, laws, Constitution, committees and cases',
  'Sealed secret ballots with local/recovery-key post-close verification',
  'Installable PWA, mobile UI, notifications and accessibility support'
];

export const KNOWN_LIMITATIONS = [
  'Production multiplayer requires a deployed Cloudflare Worker/Durable Object backend and its URL must be configured or carried in an invite link.',
  'Cloudflare is trusted for availability and action ordering, but player actions remain cryptographically signed and independently verified by clients.',
  'Plain HTTP private-LAN testing cannot use secure Cloud identities; use HTTPS or localhost for multiplayer.',
  'The browser holding a sealed ballot-box private key can technically decrypt before close; threshold/mix-net secrecy remains future work.',
  'A sealed ballot should have an exported recovery package if the ballot-box holder may disappear before close.',
  'Real-world room capacity depends on Cloudflare/browser limits; built-in stress testing remains synthetic.'
];

export function releaseReadiness(state, cloudStatus = {}) {
  const security = securitySummary();
  const history = state ? verifyEventChain(state.history ?? []) : { ok: true, count: 0 };
  const audit = state ? auditState(state) : null;
  const offline = state ? offlineReadiness(state) : null;
  const cloudReady = !cloudStatus.roomCode || (cloudStatus.authenticated && cloudStatus.stateSynced && cloudStatus.connection === 'connected');
  return [
    { label: 'Current frontend preview', ok: /^1\.2\.0-phase(?:4[5-9]|5[0-9]|6[0-9])$/.test(APP_VERSION), detail: `v${APP_VERSION} · ${RELEASE_CHANNEL}` },
    { label: 'Secure production context', ok: security.mode === 'secure', detail: security.mode === 'secure' ? 'Full cryptographic features available' : `${security.mode} — acceptable for development only` },
    { label: 'Official history integrity', ok: history.ok, detail: state ? `${history.count} chained event(s)` : 'No save loaded' },
    { label: 'Current state integrity', ok: !audit || audit.errors === 0, detail: audit ? `${audit.errors} error(s), ${audit.warnings} warning(s)` : 'No save loaded' },
    { label: 'Offline political engine', ok: !offline || offline.ready, detail: offline ? `${offline.completed}/${offline.total} readiness checks` : 'No save loaded' },
    { label: 'Cloud multiplayer integrity', ok: cloudReady, detail: cloudStatus.roomCode ? `${cloudStatus.connection} · commit #${cloudStatus.commitSequence ?? 0} · ${cloudStatus.stateSynced ? 'verified' : 'syncing'}` : 'No Cloud room connected' }
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
    cloud: {
      status: networkStatus.connection ?? null,
      roomCode: networkStatus.roomCode ? '[redacted]' : null,
      authRole: networkStatus.authRole ?? null,
      playerId: networkStatus.localPlayerId ? '[present]' : null,
      stateSynced: networkStatus.stateSynced ?? null,
      stateVersion: networkStatus.stateVersion ?? null,
      commitSequence: networkStatus.commitSequence ?? null,
      recoverySource: networkStatus.recoverySource ?? null,
      connectedClients: networkStatus.connectedClients ?? null,
      clockRttMs: networkStatus.clockRttMs ?? null
    },
    recentErrors: recentErrors.slice(-10).map(item => ({ at: item.at, type: item.type, message: item.message }))
  };
  return JSON.stringify(report, null, 2);
}
