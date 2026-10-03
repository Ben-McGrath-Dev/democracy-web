# Democracy Web 1.1

Democracy Web is a browser political simulation for running elections, Parliament, governments, laws, constitutional procedure, committees, cases and referendums.

Version **1.1.0** completes the multiplayer migration from WebRTC/P2P to **Cloudflare Workers + SQLite-backed Durable Objects + WebSockets**.

## Multiplayer architecture

The browser keeps each player's private signing key. Cloudflare provides transport, ordering, canonical multiplayer time and durable recovery, but player actions remain cryptographically signed and independently replayed/verified by every client.

```text
Browser
  -> signed action
Cloudflare Durable Object
  -> verify identity / permissions / state version
  -> order + persist commit
  -> broadcast commit
Browser
  -> verify signature / authorization / commit chain / state hash
```

There is no production dependency on Trystero, Nostr signaling, WebRTC ICE, STUN, TURN or Lobby Owner peer migration.

## Offline mode

Local/offline Democracies still work without Cloudflare. IndexedDB autosave, snapshots, `.democracy` export/import and the full political engine remain available locally.

## Local development

Serve the frontend over HTTP:

```bash
python -m http.server 8000
```

Install Worker tooling and start the Cloud backend:

```bash
npm install
npm run cloud:dev
```

Then open:

```text
http://localhost:8000
```

The default local Cloud backend is:

```text
http://localhost:8787
```

## Production deployment

### Frontend

The static frontend can continue to be deployed with GitHub Pages using `.github/workflows/pages.yml`.

### Cloud backend

Deploy the Worker/Durable Object backend:

```bash
npm run cloud:deploy
```

Set the deployed Worker URL in **Multiplayer → Cloud backend URL**. Cloud invite links include that backend URL automatically, so a new player's browser can connect without manual configuration.

`wrangler.jsonc` currently allows these browser origins:

- `https://ben-mcgrath-dev.github.io`
- `http://localhost:8000`
- `http://127.0.0.1:8000`

Update `ALLOWED_ORIGINS` if the frontend is deployed somewhere else.

## Cloud room flow

### Create / migrate a game

1. Create or load a Democracy locally.
2. Open **Multiplayer**.
3. Configure the Worker URL.
4. Choose **Publish & Connect**.
5. Share the generated Cloud invite link.

Existing local and former P2P saves can be published to Cloud. Political state and history are preserved; obsolete P2P transport metadata is normalised before upload.

### Join

1. Open the Cloud invite link or enter a room code.
2. The browser proves possession of its ECDSA P-256 identity.
3. Existing players are matched to their registered public key.
4. New identities submit a join request.
5. The Host, Deputy Host, or pre-Host creator approves/rejects the request.

## Cloud recovery

Cloud multiplayer supports:

- automatic reconnect after WebSocket/network loss;
- browser sleep/wake recovery;
- resume from the last verified commit;
- bounded commit-delta replay;
- persistent chunked SQLite snapshots;
- full verified snapshot + commit recovery when a delta is not possible;
- canonical server time for multiplayer deadlines.

The browser refuses to submit official Cloud actions until the recovered state has been verified.

## Security model

- ECDSA P-256 private signing keys remain in the browser.
- Secure private keys are non-extractable and stored through IndexedDB/Web Crypto.
- Cloud actions are signed by the player who requested them.
- The Durable Object rechecks signature, replay nonce, state version and political permissions.
- Clients independently verify the originating signature, applied action, commit chain and resulting state hash.
- Production Worker URLs must use HTTPS; plain HTTP is accepted only for localhost development.
- Runtime third-party JavaScript is not required for multiplayer in 1.1.

Cloudflare is still trusted for **availability and ordering**. It can theoretically delay, censor or reorder simultaneously valid requests, but it cannot create a valid signed action on behalf of another player without that player's private key.

## Secret ballots

Sealed ballots remain encrypted in shared state. The ballot-box private key is not replicated through normal Cloud state. A password-protected `.dbr` recovery package can be exported for critical ballots.

Current limitation: the browser holding the ballot-box private key can technically decrypt early. Threshold/mix-net ballot secrecy is a future improvement.

## Main project layout

```text
js/                 Browser UI/runtime
shared/             Deterministic rules shared by browser + Worker
worker/src/          Cloudflare Worker + DemocracyRoom Durable Object
css/                UI styling
data/               Starting rules/laws data
tests/              Automated/regression/security tests
wrangler.jsonc       Cloudflare configuration
```

## Tests

Run the focused 1.1 test set:

```bash
npm test
```

Run all Cloud migration tests:

```bash
npm run test:cloud
```

The repository also retains the older political, security and recovery regression suites. Legacy P2P-specific tests detect the 1.1 cutover and report that their transport has been intentionally retired.

## Release

**1.1.0 — Cloud Multiplayer Cutover**

Phase 44 completes the Phase 34–44 Cloudflare migration roadmap.
