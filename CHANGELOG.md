# Changelog

## 1.1.0-phase43 — Cloud reconnect/resume + save migration

- Added remembered Cloud sessions with automatic reconnect after network loss, page sleep/wake and browser focus restoration.
- Added verified delta resume from the last locally verified commit sequence/hash, with persistent snapshot fallback.
- Added explicit Cloud session forgetting on manual disconnect.
- Added migration preparation for existing local/P2P saves that preserves political state/history while clearing obsolete transport authority metadata.
- Added Phase 43 regression coverage.

## 1.1.0-phase42 — Canonical Cloud time + durable recovery

### Phase 41
- Cloudflare now assigns the canonical acceptance timestamp for every multiplayer action; client wall-clock values never decide whether a deadline-sensitive action is valid.
- Added periodic authenticated server-time synchronization with round-trip estimation and a monotonic browser clock anchor.
- Vote countdowns and attention/deadline UI use the synchronized Cloud clock while connected.
- Added explicit server-time data to room/session metadata and resynchronization responses.

### Phase 42
- Added immutable SQLite recovery snapshots, beginning with a genesis snapshot and then every 50 committed actions.
- Snapshot JSON is split into UTF-8-safe chunks capped at 256 KiB so large games do not depend on a single oversized SQLite row.
- Snapshots store state version/hash and the matching commit-chain head.
- Reconnect/resync can recover from the latest verified persistent snapshot plus subsequent signed commits, or use a short commit delta when the local base is already verified.
- Manual resync forces persistent-snapshot recovery; automatic sequence-gap repair may request a bounded commit delta.
- State and commit writes remain atomic in the Durable Object SQLite transaction.

## 1.1.0-phase40 — Cloud secure join + signed action sequencer

### Phase 39
- Added authenticated join requests for previously unknown browser identities.
- Join requests store the verified public key/fingerprint but do not receive canonical state until approved.
- Host/Deputy/pre-Host creator receives pending requests and can approve or reject them.
- Approval is a signed canonical `PLAYER_ADDED` transition tied exactly to the pending request; arbitrary Cloud `PLAYER_ADDED` actions are rejected.
- Rejections are signed and nonce-protected without mutating political state.

### Phase 40
- Added signed Cloud `ACTION_SUBMIT` envelopes with room, player, nonce and expected state version.
- Durable Object verifies the player's registered public key, signature, replay nonce, state version and shared permission rules.
- Worker and browser run the same deterministic reducer with server-assigned acceptance time and transition seed.
- Added persisted commit sequence/hash chain and atomic SQLite state+commit writes.
- Clients independently verify signer, authorization, commit hash, reducer result and resulting state hash before loading each commit.
- Added verified snapshot sync/resync and a `stateSynced` gate that prevents actions against stale local state.


## 1.0.4 — Secure first-join reliability
- Added a compact per-relay health panel with connected/retrying/unavailable state, last failure details, and automatic retry timing.

### Signaling hotfix
- Replaced Trystero's broad default Nostr relay pool with a smaller Democracy Web signaling list that excludes the repeatedly failing `nostr.tegila.com.br` endpoint.
- Suppressed individual relay-failure warnings while retaining multiple independent relays for redundancy.
- Added signaling relay health to the Multiplayer status panel so a partial relay outage is shown as degraded rather than as a lobby failure.
- Bumped the service-worker cache so the updated signaling configuration replaces cached 1.0.4 assets.

- Replaced the two-message initial join acknowledgement/checkpoint with one atomic signed bootstrap packet, removing a first-join race.
- Full invite links still pin the Lobby Owner fingerprint automatically.
- Room-code-only joins now discover a self-signed owner fingerprint and require explicit human verification before pinning it.
- Detects conflicting owner identities during discovery and refuses to auto-trust either.
- Joining no longer inherits authority metadata from an unrelated local save.
- Initial joins no longer trigger Lobby Owner migration while bootstrap is incomplete.
- Extended/restarted join retries when the verified owner appears late.

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

## 1.1.0-phase38 — Cloudflare migration foundation

- Phase 34: moved the deterministic political state/rules implementation into a browser/Worker shared module tree.
- Added `shared/reducer.js` and a versioned shared cloud protocol.
- Phase 35: added a Cloudflare Worker with one SQLite-backed `DemocracyRoom` Durable Object per room code.
- Added room creation/info endpoints and a hibernatable WebSocket foundation.
- Existing Trystero/P2P multiplayer remains enabled during migration; no cutover has occurred yet.

## 1.1.0-phase38 — Cloud rooms, WebSockets and authentication

- Phase 36: added secure Cloudflare room creation lifecycle tied to the save creator's public Democracy identity.
- Phase 37: added browser-to-Durable-Object WebSocket transport using hibernatable sockets and versioned protocol messages.
- Phase 38: added per-connection signed challenge authentication with expiry, room binding and replay-resistant nonces. Creator identities authenticate as `creator`; unknown valid keys authenticate as `unregistered` pending Phase 39 join approval.
- Added a Cloud Multiplayer Preview panel while retaining the legacy P2P stack during migration.

## 1.1.0 — 2026-10-03

### Cloud multiplayer cutover (Phase 44)
- Replaced production WebRTC/P2P multiplayer with Cloudflare Durable Object WebSockets.
- Removed Trystero/Nostr/TURN/Lobby Owner network migration from the browser application shell.
- Made Cloud multiplayer the default and only online transport; offline/local play remains supported.
- Added invite links carrying Cloud room code plus backend URL.
- Added automatic invite-link connection and secure production backend URL validation.
- Updated Recovery and Release pages for Cloud commit/snapshot recovery.
- Tightened CSP to self-hosted scripts and removed old runtime CDN allowances.
- Finalized version as `1.1.0` and completed the Phase 34–44 Cloudflare migration roadmap.
