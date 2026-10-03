# Security model

Democracy Web is a static peer-to-peer application. GitHub Pages/HTTPS is the intended production environment.

## Production mode

On a secure context (`https://` or localhost), Democracy Web enables Web Crypto identities, signed actions, sealed ballots, ballot recovery encryption, integrity hashes and service-worker/PWA support.

## LAN Test Mode

Plain HTTP on private LAN addresses (for example `http://192.168.x.x:8000`) cannot use `crypto.subtle` in normal browsers. Democracy Web therefore enters an explicitly marked **LAN Test Mode**. This mode is for multi-device development only:

- player/action proofs use a deliberately non-secure development fallback;
- sealed ballot encryption and encrypted ballot recovery are disabled;
- the UI displays a persistent warning;
- LAN Test identities are not importable as production credentials.

Do not use LAN Test Mode for a real competitive game.

## Abuse limits

The network layer rejects oversized actions and oversized incoming canonical states, validates player identity/permissions, rejects stale authority/state versions, rejects replayed signed nonces, and limits user-facing names/text lengths where appropriate.

## Reporting

Do not commit real exported player identity files, ballot recovery packages, or private credentials to the repository.

## 1.0.3 security model update
Online political mutations are replicated as signed deterministic transitions. A Lobby Owner sequences actions but connected peers independently verify the actor signature, permissions, prior state version, authority epoch and resulting canonical state hash before accepting each transition. A modified Lobby Owner can no longer silently overwrite the state of already-connected honest peers.

Lobby migration control messages are identity-signed and claims must advance exactly one epoch and come from the deterministic eligible successor after loss of the current owner.

Secure-context player signing keys are stored as non-extractable Web Crypto keys in IndexedDB. Raw identity export is intentionally disabled in 1.0.3. Legacy 1.0.2 identity files can still be imported once and are converted to the non-extractable storage format.

Secret ballot caveat: 1.0.3 removes replicated ballot-box private keys and shuffles revealed plaintext choices before they enter shared state, reducing envelope-to-choice correlation by the transport owner. The browser that holds the ballot-box private key can still technically decrypt ballots early, and collusion between that holder and a transport peer that logged sender/envelope correlation can weaken anonymity. Strong threshold/mix-net ballot secrecy remains future work.

Initial-join protection: first-time joins require a pinned Lobby Owner identity fingerprint. Full invite links carry it automatically; a manual room-code join must provide the 64-character fingerprint out-of-band. Reconnect sessions retain the previously trusted owner fingerprint.

Supply-chain caveat: Trystero 0.25.4 is version-pinned but 1.0.3 still loads it from a runtime CDN provider. Vendoring/bundling the exact dependency locally remains required to remove that remaining high-severity supply-chain exposure.
