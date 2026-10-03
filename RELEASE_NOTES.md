# Democracy Web 1.0.3

Democracy Web 1.0.3 is a security-focused release responding to the full code audit.

## Fixed in this release
- Signed, deterministic political state transitions verified independently by every connected peer.
- Lobby Owner self-actions use the same identity/permission checks as peer actions.
- Signed, strictly sequential Lobby Owner migration claims with deterministic successor validation.
- Signed presence, roster and recovery control messages.
- Proposer-only online edits for law and constitutional proposals, with Host-only administrative exceptions where defined.
- Secure player signing keys migrated to non-extractable Web Crypto keys stored in IndexedDB rather than plaintext private JWKs in localStorage.
- Ballot-box private keys stay local/recovery-only; decrypted choices are shuffled before shared reveal to reduce transport-level correlation.
- Recovery/checkpoint technical metadata is sanitised before it can affect local migration state.

## Remaining security limitations
- Trystero 0.25.4 is still loaded from pinned runtime CDN providers. Vendoring/bundling it locally is still required to remove that supply-chain exposure.
- The browser holding a secret ballot-box private key can technically decrypt ballots early; threshold/mix-net voting is required to cryptographically prevent that.
- First-time joins now require a pinned Lobby Owner fingerprint. Full invite links carry it automatically; manual room-code joins must obtain and enter it out-of-band.

All existing regression suites plus new adversarial 1.0.3 security checks pass.
