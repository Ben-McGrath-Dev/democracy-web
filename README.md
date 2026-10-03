# Democracy Web

A browser-based multiplayer political simulation game for elections, parties, Parliament, governments, laws, constitutional amendments, committees, cases and political procedure.

The website is intended to be the official mechanical/record-keeping layer while discussion, campaigns and coalition negotiations can remain in WhatsApp, Discord or another chat platform.

## Current Status

**Version:** `1.0.3`  
**Milestone:** Stable security hardening

The original Phase 0–33 roadmap is complete. Version 1.0.3 hardens multiplayer authority so online political state changes are signed deterministic transitions independently verified by every connected peer.

Implemented systems include:

- local game creation and canonical action/state architecture
- players, parties, Parliament, government, laws and Constitution
- elections, committees, cases, juries and punishment
- IndexedDB autosave, verified snapshots and save export/import
- WebRTC P2P multiplayer with signed, peer-verifiable Lobby Owner sequencing
- reconnect and automatic Lobby Owner migration
- signed authority epochs and deterministic state-transition replication
- persistent ECDSA player identities and signed peer actions
- SHA-256 chained official event history
- sealed RSA-OAEP/AES-GCM secret ballots
- signed transition replay for secure resynchronisation
- migration recovery-state rebroadcast
- peer/state/authority diagnostics
- verified snapshot restore with pre-restore safety snapshot
- password-protected sealed-ballot key recovery packages
- full Markdown rulebook and save-specific mutable Constitution

## Run Locally

Do not open `index.html` directly with `file://` because browser security rules block JavaScript modules and data loading.

On Windows, double-click:

```text
start.bat
```

Or run:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Test & Stress Lab

The **Test & Stress Lab** began with the Phase 12 offline-alpha tools and is expanded in Phases 27–28.

It can:

- generate enough synthetic players to reach 30 active players;
- create three test political parties;
- distribute independent test players across parties;
- run a state-integrity audit;
- show which major offline systems have been exercised in the current save;
- run 2,000 randomized rule-property scenarios in the browser;
- measure current save size and synthetic full-state P2P fan-out at 2/10/25/50/100-player scales;
- benchmark proportional/ranked election counting and integrity-audit cost.

The test-data tools modify the current save. The property/stress tests are read-only.

## Automated Phase 12 Smoke Test

From the project directory:

```bash
node tests/phase12-smoke.mjs
```

The scenario creates 30 players and exercises parties, a general election, Parliament, government formation, Host election, all four committee elections, an ordinary law case, jury review, PPC punishment, a constitutional amendment, legislation and Host removal. It finishes with a state-integrity audit.

## Architecture

Political systems are deliberately kept separate from networking:

```text
UI
 ↓
Actions
 ↓
Game Rules / Validation
 ↓
Canonical State
 ↓
Persistence
 ↓
Networking Adapter
```

This allows the same political engine to operate locally now and over P2P networking later.

## Full Rulebook

`full-rules.md` contains the permanent rule/procedure reference.

The mutable starting Constitution and current laws belong to each individual save. Constitutional votes modify the save's live Constitution rather than rewriting the static rulebook file.

## Multiplayer security model

The Lobby Owner sequences actions, but connected peers no longer trust arbitrary owner state replacements. Each online political mutation is signed by the player who requested it, re-authorized against that player's canonical identity/role, replayed deterministically by every peer, and accepted only when the resulting state hash matches. Lobby Owner migration claims are also identity-signed and must advance exactly one authority epoch from the deterministic eligible successor.

First-time joins require the Lobby Owner fingerprint. Full invite links carry it automatically; manual room-code joins must paste the 64-character fingerprint obtained from the host out-of-band.

The **Recovery** tab shows local/peer state versions and authority epochs, recovery packets exchanged during migration, verified local snapshots, and unrevealed sealed ballots. It can request a canonical resync, rebroadcast recovery state, or restore an integrity-checked snapshot.

## Network Failure and Recovery (Phase 21)

Phase 21 adds deliberate recovery paths for failures that automatic migration cannot safely solve:

- **Secure resync** — peers request missing signed transitions rather than accepting a fresh arbitrary full-state overwrite.
- **Recovery-state rebroadcast** — useful when an owner migration appears stuck or peers need to re-advertise their latest state.
- **Peer diagnostics** — shows state version, authority epoch and current network role for connected peers.
- **Migration recovery copies** — shows the recovery-state copies seen during the current session.
- **Verified snapshot restore** — snapshot hashes and event-head hashes are checked before restore, and a pre-restore safety snapshot is created automatically.
- **Sealed ballot recovery** — the ballot-box holder can export a password-protected `.dbr` recovery package. Another browser can import it using the passphrase and continue counting the same sealed vote.

Ballot recovery packages use PBKDF2-SHA-256 (250,000 iterations) to derive an AES-GCM-256 encryption key. The ballot private key is therefore never placed in normal replicated state.

## Security / Identity (Phase 18–19)

Each browser can generate a persistent ECDSA P-256 player identity. In 1.0.3 the secure signing key is stored as a non-extractable Web Crypto key in IndexedDB rather than as plaintext private JWK data in localStorage. The public key fingerprint is bound to the in-game player. Reconnection and every online political action prove possession of that key.

Official history is hash-chained with SHA-256. Each event records its sequence number, the previous event hash and its own hash. Snapshots and exported saves also contain integrity hashes so unexpected modification can be detected.

Legacy 1.0.2 identity files can still be imported once and are converted into the non-extractable storage format. New raw private-key export is intentionally disabled. Losing the browser profile therefore means losing that identity unless an older compatible backup already exists.

## Sealed Secret Ballots (Phase 20)

Secret votes opened through the normal UI now use a sealed ballot box. Each ballot choice is encrypted in the voter's browser using hybrid RSA-OAEP + AES-GCM encryption before entering shared state. The replicated state records only encrypted ballot envelopes plus participation markers while voting is open.

When the vote closes, the ballot-box holder decrypts the envelopes locally and submits a randomized-order list of plaintext choices for tallying. The ballot-box private key is not replicated into shared state. A browser holding the ballot-box key (or an imported recovery package) can audit the revealed multiset against the encrypted envelopes. Sealed ballots cannot be changed after submission.

This is not threshold cryptography: the ballot-box holder can technically decrypt early, so strong secrecy from that holder still requires a future threshold/mix-net design.

The browser that opens a sealed vote still holds the live ballot-box private key locally, but Phase 21 can now export that key as a password-protected recovery package and import it on another trusted browser if recovery is required.

Automated test:

```bash
node tests/phase20-secret-ballots.mjs
```


## Next Phase

**Phase 22 — User Interface Redesign**

The next phase focuses on turning the technically complete administration screens into a cleaner game-like interface while preserving the established political and recovery systems.


## Current Build

**v0.30.0-phase30**

The current build completes Phase 30. It includes the full offline political engine, P2P multiplayer, recovery, cryptographic security on HTTPS, LAN Test Mode for development, accessibility/PWA support, automated/stress testing, security hardening and GitHub Pages deployment configuration.


## Notifications, PWA and Accessibility (Phases 24–26)

Phase 24 adds an in-app attention centre derived from canonical game state, optional browser notifications, unread/dismissed alerts, deadline warnings, unvoted-ballot reminders, caretaker/early-election warnings and accused-player case-response alerts. Notifications are optional and never required for game correctness.

Phase 25 adds a Web App Manifest, application icons, service worker shell caching and an install prompt where supported. Democracy Web remains a normal static GitHub Pages site and does not require installation.

Phase 26 adds keyboard-visible focus, a skip link, accessible route state, modal focus trapping and Escape dismissal, focus restoration, live announcements, reduced-motion support, forced-colour support and mobile-accessibility refinements.


## Phase 27 — Automated Rule Testing

Run the larger command-line property suite with:

```bash
node tests/phase27-rules.mjs
```

It runs 10,000 deterministic randomized scenarios over legislature sizing, committee thresholds, largest-remainder allocation, ranked-choice counting, turnout and ballot invariants.

## Phase 28 — Synthetic Multiplayer Stress Testing

Run:

```bash
node tests/phase28-stress.mjs
```

This creates a 100-player fixture, audits it, measures serialized state size, estimates full-state owner fan-out for 2/10/25/50/100-player lobbies and benchmarks election-counting throughput. It is a synthetic harness: real WebRTC/NAT connection-success measurements still require multi-browser/device alpha testing.

## Phase 29 — Security and Abuse Hardening

Production use requires HTTPS (GitHub Pages supplies HTTPS). Phase 29 adds a restrictive Content Security Policy, referrer protection, network action/state size limits, safer join-name handling, replay/staleness checks, explicit secure-context detection and a visible private-LAN development mode. Plain HTTP on private LAN IPs no longer crashes on `crypto.subtle`; it enters clearly marked **LAN Test Mode** with non-secure development identity proofs. Sealed secret ballots remain disabled until HTTPS is used.

See [`SECURITY.md`](./SECURITY.md) for the trust model.

## Phase 30 — GitHub Pages Deployment

The repository now includes `.nojekyll`, a Pages deployment workflow at `.github/workflows/pages.yml`, a simple `404.html` recovery page, and production-relative asset paths. Push the repository to the `main` branch, enable **Settings → Pages → Source: GitHub Actions**, and the included workflow can publish the static app. No application server is required.

For local multi-device testing, run `start-lan.bat`. Use the printed `http://192.168...:8000` address on other devices. This is development-only LAN Test Mode; use the deployed HTTPS Pages URL to test the full cryptographic feature set.

---

## Version 1.0

Democracy Web has reached its stable release line (`1.0.3`). The original Phase 0–33 development roadmap is complete.

Version 1.0 includes the complete offline political simulation, invite-based P2P multiplayer, persistence/recovery, cryptographic identities, sealed ballots, mobile/PWA/accessibility work, automated rule testing, stress tooling, production hardening and GitHub Pages deployment support.

For release-specific information see [`RELEASE_NOTES.md`](./RELEASE_NOTES.md) and [`CHANGELOG.md`](./CHANGELOG.md).

The in-app **Release** page can generate a privacy-safe diagnostics report for bug reports and rerun the first-use walkthrough.


## TURN Relay Fallback

Democracy Web normally connects peers directly with WebRTC. Some restrictive NAT/firewall combinations require a TURN relay. Version 1.0.3 supports TURN through the **Multiplayer → TURN Relay Fallback** panel.

TURN configuration is stored only in the local browser and is not included in Democracy saves or shared state. Configure one or more `turn:` / `turns:` URLs, username and credential. You can temporarily enable **Force relay for testing** to verify the relay by forcing WebRTC to use relay candidates.

The project does not bundle public TURN credentials. A TURN service (hosted or self-hosted, such as coturn) is still required when relay connectivity is needed.
