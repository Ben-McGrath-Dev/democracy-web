# Democracy Web Security

## Production architecture

Democracy Web 1.1 uses a static browser frontend plus a Cloudflare Worker and SQLite-backed Durable Objects for multiplayer.

The old production WebRTC/P2P transport, Trystero runtime dependency, Nostr signaling, TURN configuration and Lobby Owner peer-authority system have been retired.

## Player identity

Players use ECDSA P-256 identities. Secure private signing keys are non-extractable Web Crypto keys stored through IndexedDB. Private keys are never included in Democracy saves or Cloud room state.

## Signed Cloud actions

Every official online mutation is submitted as a player-signed action containing the room, player identity, expected state version and replay nonce.

The Durable Object verifies:

- registered public key / player binding;
- signature;
- replay nonce;
- expected state version;
- political permission/authorization;
- deterministic reducer transition.

It then persists and broadcasts an ordered commit.

Clients independently verify:

- player signature;
- authorization result;
- previous commit hash;
- commit hash;
- deterministic transition seed/time;
- resulting state version and state hash.

A Cloud server cannot produce a valid signed action for another player without that player's private key.

## Trust boundary

Cloudflare remains trusted for availability, connection routing and sequencing. A malicious or compromised sequencer could censor/delay messages or choose an ordering between simultaneously valid actions. Clients detect forged player actions or state transitions, but cannot force the service to deliver data.

## Recovery

Reconnects resume from the last locally verified commit when possible. The Worker validates the claimed commit head before sending a delta. Larger gaps recover from immutable chunked SQLite snapshots plus later signed commits. Snapshot hashes and final commit heads are verified by the client.

## Canonical time

Multiplayer deadline validation uses the Durable Object's accepted timestamp rather than a player's local clock.

## Web security

Production multiplayer requires HTTPS. Plain HTTP Cloud backends are accepted only for localhost development. The frontend Content Security Policy permits self-hosted scripts only; no runtime JavaScript CDN is required by multiplayer.

The Worker restricts browser origins using `ALLOWED_ORIGINS` in `wrangler.jsonc`. This is defense in depth and does not replace cryptographic authentication.

## Secret ballots

Sealed ballot ciphertext is stored in canonical state; the ballot-box private key is not replicated through normal shared state. Password-protected ballot recovery packages use PBKDF2 + AES-GCM.

Known limitation: the browser holding the ballot-box private key can technically decrypt ballots before close. Strong threshold/mix-net secrecy remains future work.

## LAN Test Mode

Plain HTTP on private LAN addresses is development-only. Insecure LAN identities must not be used for Cloud multiplayer. Use HTTPS or localhost when testing cryptographic multiplayer.
