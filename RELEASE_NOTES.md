# Democracy Web 1.1.1 — Cloud backend persistence hotfix

The configured Cloudflare Worker URL is now saved persistently in the browser and restored on reload. The production fallback for this deployment is `https://democracy-web-cloud.ben-mcgrath-dev.workers.dev`; local frontend development still falls back to `http://localhost:8787` when no browser override has been saved.

# Democracy Web 1.1.0 — Cloud Multiplayer Cutover

Version 1.1 replaces the production WebRTC/P2P transport with Cloudflare Durable Objects and WebSockets.

## Highlights

- Cloudflare Durable Object per multiplayer room.
- SQLite-backed canonical state, signed commit history and persistent chunked snapshots.
- Player ECDSA identities remain browser-owned.
- Every online political mutation is player-signed.
- Durable Object verifies signature, nonce, state version, permissions and deterministic transition.
- Clients independently replay and verify each committed action and resulting state hash.
- Canonical Cloud time controls multiplayer deadlines.
- Automatic reconnect/resume after network loss or browser sleep.
- Verified commit-delta catch-up with persistent snapshot fallback.
- Existing local/legacy saves can be published to Cloud.
- Cloud invite links carry both room code and backend address.
- Legacy Trystero, Nostr signaling, WebRTC, TURN and Lobby Owner network migration removed from production.
- Browser CSP no longer allows the old runtime CDN dependencies.

## Offline mode

Offline/local games remain supported with IndexedDB autosave, local snapshots and `.democracy` import/export.

## Deployment requirement

Production multiplayer requires a deployed Cloudflare Worker/Durable Object backend. After deployment, set its HTTPS URL in the Multiplayer page; generated invite links carry that URL to joining browsers.

## Security notes

Cloudflare is trusted for service availability and ordering, but not for player identity. A valid player action still requires that player's private signing key, and clients verify the signed commit independently.

The remaining major cryptographic limitation is sealed-ballot early-decryption capability by the browser holding the ballot-box private key. Threshold/mix-net ballot secrecy is not part of 1.1.
