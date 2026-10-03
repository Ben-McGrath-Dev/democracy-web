## 1.0.3 hotfix — Startup regression fix

- Restored the missing `formatDateTime` utility export required by `app.js`.
- Removed `frame-ancestors` from the meta-delivered CSP because browsers ignore that directive outside an HTTP response header.
- Bumped the service-worker cache to prevent the broken 1.0.3 module from remaining cached.

# Changelog

## 1.0.3 — 2026-10-03

### Security
- Replaced trust-based online state replacement with player-signed deterministic transitions independently verified by every connected peer.
- Lobby Owner self-actions now pass through the same identity, permission, state-version and authority-epoch checks as peer actions.
- Signed Lobby Owner migration claims must advance exactly one epoch, match the verified state hash and come from the deterministic eligible successor.
- Signed presence, roster and recovery controls can no longer anonymously rewrite authority or peer/player bindings.
- First-time joins now require a pinned Lobby Owner fingerprint; invite links carry it automatically and manual joins must supply it out-of-band.
- Tightened law and constitutional proposal edit/finalize permissions to the actual proposer/Host rules.
- Migrated secure signing keys to non-extractable CryptoKeys in IndexedDB; raw private-key export is disabled for newly secured identities.
- Ballot-box private keys are no longer replicated into shared state; revealed choices are shuffled before replication and audit compares ballot multisets.

### Remaining hardening items
- Trystero remains version-pinned but runtime-loaded from CDN providers.
- Strong secret-ballot secrecy from the ballot-box holder requires threshold/mix-net cryptography.

## 1.0.2 — 2026-10-03

### Networking
- Added configurable TURN relay fallback using Trystero's `turnConfig`.
- TURN URLs, username and credential are local browser settings and are never placed in game state, saves, diagnostics or P2P replication.
- Added optional `iceTransportPolicy: relay` test mode to verify that a TURN server is actually usable.
- Multiplayer status now reports whether TURN fallback is configured.
- Direct P2P remains preferred when relay-only testing is disabled.

## 1.0.1 — 2026-10-03

### Security and authority
- Bound multiplayer self-actions to the connected cryptographic player identity in both permissions and UI.
- Removed direct online party joins; party membership now uses invitations or join requests with explicit acceptance/rejection.
- Party leaders can invite independent players, and independent players can request to join.
- Added party membership notifications and auditable invite/request events.

### Networking
- Upgraded Trystero target from 0.25.0 to 0.25.4.
- Replaced the single `esm.run` dependency with a resilient CDN fallback chain (jsDelivr, esm.sh, then esm.run).

## 1.0.0 — 2026-10-03

### Release
- Promoted Democracy Web from development phases to the first stable release.
- Added first-run onboarding, release readiness checks and privacy-safe diagnostics.
- Added release notes and a permanent changelog.

### Political simulation
- Players, parties, proportional Parliament, coalition government, Prime Minister and ministers.
- Generic voting engine, ranked-choice elections, approval voting and proportional seat allocation.
- Laws, referendums, citizens' initiatives and per-save constitutional amendments.
- AC, PC, PAC and PPC committee systems, juries, cases and punishments.

### Multiplayer and resilience
- WebRTC/P2P invite-based lobbies with an authoritative Lobby Owner.
- Reconnect, state resync, deterministic Lobby Owner migration and recovery tools.
- IndexedDB autosave, snapshots and portable `.democracy` save files.

### Trust and privacy
- Persistent ECDSA player identities and signed actions.
- Tamper-evident official event history and verified exports.
- Sealed secret ballots with delayed reveal and independent verification.
- Password-protected sealed-ballot recovery packages.

### Experience
- Responsive desktop/mobile UI and WhatsApp/Discord sharing flows.
- Optional notifications and installable PWA support.
- Keyboard, screen-reader, reduced-motion and forced-colour accessibility support.
- Built-in rule-property tests and synthetic multiplayer stress measurements.
