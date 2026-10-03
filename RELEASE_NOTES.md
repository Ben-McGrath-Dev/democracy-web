# Democracy Web 1.0.4

Democracy Web 1.0.4 improves first-time multiplayer connectivity without weakening the 1.0.3 authority/security model.

## Fixed in this release
- Initial join acknowledgement and canonical checkpoint are now delivered as one atomic signed bootstrap packet, removing a race that could leave clients stuck on “Waiting for join approval…”.
- Full invite links continue to pin the Lobby Owner fingerprint automatically.
- Room-code-only joins can discover a self-signed owner identity, but the app requires the user to compare a short verification code with the host before trusting it.
- Conflicting discovered owner fingerprints trigger a security warning and cannot be auto-trusted.
- A client joining a new lobby no longer inherits authority epoch/owner metadata from an unrelated local save.
- Lobby Owner migration cannot start while an initial join/bootstrap is incomplete.
- Join retries last longer and restart when the pinned owner appears.

## Security retained from 1.0.3
- Signed deterministic political transitions independently verified by peers.
- Signed strictly sequential owner migration claims.
- Non-extractable player signing keys in IndexedDB.
- Proposer/role authorization for sensitive law and constitutional mutations.
- Ballot-box private keys remain local/recovery-only.

## Remaining limitations
- Trystero 0.25.4 is still runtime-loaded from pinned CDN providers; vendoring remains a supply-chain hardening item.
- A secret-ballot box key holder can technically decrypt before close; threshold/mix-net voting is required to prevent this cryptographically.

All existing regression suites plus the new secure first-join tests pass.
