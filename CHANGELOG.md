## 1.2.0-phase69 — Laws, Constitution, Committees and Cases workspace polish

## Phase 69 guide update — Self-hosted Cloudflare backend walkthrough

- Expanded the Cloudflare guide into a beginner-first 14-step deployment walkthrough with prerequisites and explicit success checks.
- Added Windows, macOS and Linux terminal guidance plus Node/npm/Wrangler verification before deployment.
- Added `wrangler whoami`, `wrangler deploy --dry-run`, deployment/version checks, second-device verification and safe update guidance.
- Added a structured debugging decision tree covering `origin_not_allowed`, PowerShell script policy, missing Node/npm, OAuth/account mistakes, disabled/protected workers.dev routes, missing rooms, WebSocket failures, stale local Durable Object state, Durable Object configuration errors and usage-limit symptoms.
- Added official Cloudflare documentation links for Wrangler, workers.dev, local development, Durable Objects and Workers logs.
- Replaced hash-based guide table-of-contents links with router-safe in-page jump controls.
- Added a full in-app guide for deploying the Democracy Web Cloud backend to a user's own Cloudflare account.
- Added direct access from **Multiplayer → Set up your own Cloudflare link** and **Help & Guides**.
- Added source-download instructions for the GitHub repository, Wrangler login/deploy commands, `workers.dev` subdomain setup, `/health` verification, `ALLOWED_ORIGINS` guidance, update instructions, and troubleshooting.
- Added Windows-safe `npm.cmd` / `npx.cmd` alternatives for machines where PowerShell blocks npm scripts.
- Added responsive desktop/mobile guide layouts and one-tap command-copy controls.
- Added regression coverage for the deployment guide.


- Phase 68 gives Laws a remembered **In progress / Statute book / Archive** workspace and makes law details document-first on desktop and mobile.
- The Constitution now has live section search, stable section deep links, a sticky desktop contents rail, compact horizontal mobile contents and amendment backlinks.
- Phase 69 prioritises the connected player’s committee work and open matters, with clearer membership, alternates, recusals and decision-stage presentation.
- Cases now surface **Your case actions** first and use a structured procedural record separating complaint, response, PAC finding, mandatory jury review and PPC outcome.
- Desktop layouts use available width for readable workspaces and supporting sidebars while phone layouts convert the same information into compact, action-first flows.
- Preserved legacy structural hooks used by compact-view/accessibility regressions while replacing the visible layouts.
- Political reducers, constitutional wording, thresholds, permissions, vote counting and Cloud authority remain unchanged.

## 1.2.0-phase67 — Voting, elections, Parliament and Government UX

- Phase 66 surfaces the connected player’s uncast ballots before vote history and gives current elections a focused lifecycle summary.
- Ranked-choice ballots now provide clearer instructions, candidate context and larger touch-friendly ranking controls.
- Election cards and focused summaries expose personal ballot state, deadline and certification stage more clearly.
- Phase 67 makes occupied Parliament seats tappable/keyboard-focusable and links them directly to player profiles.
- Members of Parliament use dedicated mobile cards on narrow screens instead of requiring horizontal table navigation.
- Government pages now lead with a stronger administration/majority summary.
- Government formation now calculates coalition seats live, shows the majority threshold, and tells the user how many additional seats are required.
- Mobile layouts prioritize primary political actions and reduce dense table/detail overload.
- Political reducers, thresholds, permissions, vote counting and Cloud authority remain unchanged.

## 1.2.0-phase65 — Safer forms, consequence previews and mobile-first controls

- Added Phase 64 shared form UX with required-field markers, inline validation, character counters, normalized input and searchable large candidate/member pickers.
- Added local autosaved drafts for substantial political forms, including legislation, constitutional amendments, government formation, cases and committee matters.
- Added review-before-submit steps to high-impact creation flows and ballots without persisting private ballot choices.
- Added Phase 65 consequence previews that identify the acting player and explain important or irreversible state changes before they are dispatched.
- Added clearer persistent error/success feedback and double-submit protection.
- Pulled forward mobile UX work: a current-page mobile header, Home/My Actions/Votes/Cases dock, grouped full menu, acting-player/connection context, mobile back navigation, larger touch controls and sticky bottom-sheet actions.
- Preserved the constitutional terminology guard: **AC means Actions Committee only**.

## 1.2.0-phase63 — Detail pages, constitutional terminology and contextual guidance

- Renamed the Phase 59 personal UI from “Action Centre” to **My Actions** so the abbreviation **AC** remains reserved for the constitutional **Actions Committee**.
- Corrected the Help glossary: AC is the elected constitutional oversight body, not an “Amendment Committee”.
- Added Phase 61 deep-link detail routes for votes, elections, laws, amendments, cases, committees, players and parties.
- Command search now opens the exact political object instead of only its parent list page.
- Added breadcrumbs, meaningful browser titles, related records and object-scoped official history.
- Added Phase 62 central human-readable status explanations for voting, legislation, amendments and ordinary-law cases.
- Added separate personal-state/role strips so system state and “your status” are not conflated.
- Added Phase 63 rulebook-aware “What happens next?” guidance, including the distinct AC/PC/PAC/Jury/PPC responsibilities.
- Added committee constitutional-role explanations and recusal/Decision Membership guidance.
- Political reducers, thresholds, permissions and Cloud authority remain unchanged.

## 1.2.0-phase63 — My Actions + list navigation

- Added Phase 59 My Actions with personal required actions, upcoming deadlines and recent official updates.
- Added explanatory “Why am I seeing this?” context to player-specific attention items.
- Added one-hour local reminder snoozing for non-urgent My Actions items.
- Added persistent My Actions badges to desktop and mobile navigation.
- Added Phase 60 shared search/filter/sort controls to Votes, Elections, Laws, Cases, Players and Activity.
- List preferences persist locally per page, including compact/card view where supported.
- Added live result counts and distinct filtered-empty states with one-click reset.
- Added relevance and deadline sorting so personal actions surface before historical records.
- Political rules, permissions, reducers and Cloud authority remain unchanged.
- Full regression suite: 42/42 test files pass.

## 1.2.0-phase58 — Frontend second pass: foundations + navigation

### Phase 57 — Design-system foundations
- Expanded UI tokens for spacing, typography, controls, semantic borders, elevation, motion, focus and layout.
- Added reusable semantic card/status variants, standardized button sizes/quiet actions, metadata rows, avatars and keyboard-key styling.
- Preserved the existing light visual identity while giving later second-pass phases a consistent component vocabulary.

### Phase 58 — Navigation and application shell
- Sidebar sections are collapsible and remember their state per browser.
- Added actionable vote/case badges alongside the existing notification badge.
- Added persistent local/Cloud connection context and a clear “Acting as” identity panel.
- Added Ctrl/Cmd+K command search for pages, players, parties, votes/elections, law proposals, enacted laws and cases.
- Added recent destinations to command search and matching mobile search access.
- Browser Back/Forward navigation now uses real history entries and restores remembered route scroll positions.
- Active navigation is stronger, the current group automatically opens, and mobile navigation carries action badges.
- Political rules, reducer behavior and Cloud authority remain unchanged.

## 1.2.0-phase56 — Codebase audit hardening

- Added Cloud preflight and authentication timeouts so failed backends cannot leave the UI connecting forever.
- Fatal Cloud verification/protocol errors now close the bad socket and clear sync state before recovery.
- Hardened party data: strict `#RRGGBB` colours, safe CSS rendering, and length limits for party/game metadata.
- Online petitions, signatures and case complainants are explicitly self-bound in the UI; arbitrary-player selection remains offline/test-only.
- Fixed onboarding so it is only marked complete after the final confirmation.
- Modal confirm failures are caught and surfaced instead of becoming unhandled promise rejections.
- Corrected committee names in Help/Profile UI to match the canonical rulebook.
- Aligned package/release/readme metadata with the `1.2.0-phase56` frontend preview.
- Added a complete cross-platform `npm test` runner and audit regressions for the issues above.

## 1.2.0-phase56 — Frontend experience phases 53–56

- Phase 53: redesigned Committees and Cases with membership chips, recusal context, per-case workflow tracking, PAC/jury panels and role-aware controls.
- Phase 54: added richer player profiles plus a global official Activity timeline.
- Phase 55: added Simple/Advanced interface modes and further mobile presentation refinements.
- Phase 56: added the contextual Democracy Coach, which derives helpful next steps from canonical state without changing rules or official state.
- Frontend-only release: shared political core and Cloud Worker behavior remain unchanged.

# Changelog

## 1.1.3 — Cloud backend persistence hotfix

- Cloud Worker URL is now stored in a dedicated browser-local cache key as well as the versioned Cloud settings record.
- Backend URL automatically persists on field change or Enter; saving no longer rerenders the Multiplayer page.
- Production fallback now points to the deployed Democracy Web Worker, while localhost frontends still default to `http://localhost:8787`.
- Cloud action buttons explicitly use `type="button"` to prevent accidental form submission.
- Invite-provided Cloud backend URLs continue to be validated and persisted automatically.

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

## 1.2.0-phase48 — Frontend experience phases 45–48

- Phase 45: simplified Cloud connection experience with visible connection stages, plain-language errors, and advanced diagnostics tucked behind disclosure controls.
- Phase 46: rebuilt the Dashboard around the local player's roles, attention items, political snapshot, upcoming deadlines, and direct next-action buttons.
- Phase 47: added a multi-step first-run introduction plus a permanent Help & Guides centre and glossary.
- Phase 48: added contextual `How this works` guides and reusable visual process trackers across votes, elections, laws, the Constitution, cases, Parliament, Government, Committees, and Multiplayer.
- No political rules, thresholds, counting methods, or Cloud authority behavior were changed by these frontend phases.

## 1.2.0-phase52 — Frontend experience phases 49–52

- Phase 49: added role-aware presentation for elections, Parliament, Government, laws and the Constitution; irrelevant administration controls are hidden or replaced with clear explanations of why an action is unavailable.
- Phase 50: redesigned election/vote results with turnout summaries, bar visualisations, ranked-choice round views, approval cutoffs, and an expandable largest-remainder seat calculation explanation.
- Phase 51: redesigned Parliament and Government with seat maps, party seat-share graphics, majority markers, coalition balance, local-MP highlighting, minister presentation, and role-aware government controls.
- Phase 52: redesigned Laws and Constitution with per-proposal process trackers, petition progress, statute-book cards, side-by-side constitutional wording comparisons, structured Constitution browsing, and clearer Base-rule unlock progress.
- Political rules, permissions, Cloud sequencing, vote counting, and constitutional thresholds remain unchanged.
