# Democracy Web

A browser-based multiplayer political simulation game built around elections, parties, governments, laws, committees, cases and constitutional politics.

The goal is to turn **Democracy** from a manually managed WhatsApp game into a proper web application while keeping the social side of the game in places like WhatsApp or Discord.

The web app handles the official game state.

Players handle the politics.

---

## What is Democracy?

Democracy is a multiplayer political simulation where players can:

- create political parties;
- contest elections;
- become members of the legislature;
- form governments and coalitions;
- become Prime Minister or a minister;
- propose and vote on laws;
- propose constitutional amendments;
- participate in committees;
- investigate alleged rule violations;
- serve on juries;
- challenge laws and administrative decisions;
- remove governments or office-holders through constitutional procedures;
- campaign, negotiate and debate with other players.

The exact political system is defined by the game's Constitution.

The full Constitution is stored separately from this README so it can evolve without making the project documentation enormous.

---

## Project Goals

Democracy Web is designed around a few main principles.

### Free to Host

The game should be capable of running without a traditional paid multiplayer server.

The website itself can be hosted as a static site, for example using GitHub Pages.

### Peer-to-Peer Multiplayer

Players connect directly to the lobby using browser networking such as WebRTC.

One player acts as the current **Lobby Owner**, maintaining the authoritative game state and distributing updates to connected players.

The Lobby Owner is a technical networking role and is completely separate from the constitutional **Host** role.

A player may hold both roles, but they do not have to.

### Persistent Games

Political games may run for weeks or months.

Game state should therefore be:

- automatically saved locally;
- replicated where practical;
- recoverable if the Lobby Owner disconnects;
- exportable to a file;
- importable later.

### Transparent Administration

Important events should be recorded in a game history.

Examples include:

- elections opening;
- elections closing;
- laws being proposed;
- legislative votes;
- constitutional amendments;
- government formation;
- committee decisions;
- case outcomes;
- office changes.

Private information such as secret ballots should not be exposed in the public event log.

---

## Planned Architecture

The project is intended to run primarily in the browser.

```text
GitHub Pages
     │
     │ serves HTML / CSS / JavaScript
     ▼
Player Browsers
     │
     │
     ├──── WebRTC / P2P ────┐
     │                      │
     ▼                      ▼
Lobby Owner             Other Players
     │
     ▼
Authoritative Game State
```

The website itself does not need a traditional application server for normal gameplay.

Peer discovery/signalling may use decentralised or free infrastructure.

---

## Lobby Owner vs Constitutional Host

These are intentionally separate concepts.

### Lobby Owner

The Lobby Owner is the browser currently responsible for synchronising the multiplayer game.

Responsibilities may include:

- accepting connections;
- maintaining the canonical game state;
- validating incoming actions;
- broadcasting state updates;
- coordinating host migration.

The Lobby Owner does **not** automatically receive any political power.

### Constitutional Host

The Host is an in-game office defined by the Constitution.

The Host handles neutral administrative duties such as:

- elections;
- official records;
- procedural administration;
- result certification.

A Lobby Owner may also be elected as Host, but neither role automatically grants the other.

---

## Planned Features

### Multiplayer

- Create lobby
- Join lobby using room code
- Invite links
- Player list
- Reconnection
- Lobby Owner migration
- Network status

### Players

- Player profiles
- Active/inactive status
- Political roles
- Office history

### Political Parties

- Create party
- Join/leave party
- Party leadership
- Party descriptions
- Electoral candidate lists

### Elections

- General elections
- Host elections
- Deputy Host elections
- Committee elections
- Ranked-choice voting
- Proportional representation
- Approval voting
- Automatic counting

### Legislature

- Seats
- MPs
- Party representation
- Bills
- Legislative voting
- Vote records

### Government

- Prime Minister
- Ministers
- Coalitions
- Government formation
- Votes of confidence
- Votes of no confidence
- Caretaker governments

### Laws

- Propose laws
- Discussion period
- Final proposal locking
- Legislative votes
- Referendums
- Citizens' initiatives
- Repeal and amendment
- Law history

### Constitution

- Current Constitution
- Constitutional amendments
- Amendment voting
- Protected/Base provisions
- Version history
- Constitutional changelog

### Committees

- Actions Committee
- Punishment Committee
- People's Actions Committee
- People's Punishment Committee
- Committee elections
- Recusals
- Alternates
- Committee voting

### Cases

- Allegations
- Evidence
- PAC panels
- Jury selection
- Jury voting
- PPC punishment
- Case history

### Records

- Election history
- Government history
- Laws
- Amendments
- Committee decisions
- Cases
- Punishments
- Public audit log

### Saving

- IndexedDB/local browser saves
- Automatic snapshots
- Export game
- Import game
- Recovery after disconnect

---

## Suggested Technology

The initial version can remain deliberately simple.

- HTML
- CSS
- JavaScript
- WebRTC
- IndexedDB
- GitHub Pages

A lightweight peer-to-peer networking library may be used to simplify WebRTC room discovery and communication.

The project should avoid requiring a permanent Node.js server unless it becomes necessary later.

---

## Repository Structure

A possible structure is:

```text
democracy-web/
│
├── index.html
│
├── README.md
│
├── LICENSE
│
│
├── css/
│   ├── main.css
│   └── game.css
│
├── js/
│   ├── app.js
│   ├── lobby.js
│   ├── network.js
│   ├── state.js
│   ├── storage.js
│   ├── players.js
│   ├── parties.js
│   ├── elections.js
│   ├── legislature.js
│   ├── government.js
│   ├── laws.js
│   ├── committees.js
│   ├── cases.js
│   └── history.js
│
├── data/
│   ├── constitution.json
│   └── starting-laws.json
│
└── assets/
```

This structure will likely change as development continues.

---

## Game State

The game should have one canonical state object representing the current country.

Conceptually:

```js
{
    meta: {},
    players: {},
    parties: {},
    legislature: {},
    government: {},
    elections: {},
    votes: {},
    laws: {},
    constitution: {},
    committees: {},
    cases: {},
    history: []
}
```

The authoritative Lobby Owner updates this state and distributes changes to other connected clients.

Clients should reject state updates that are older than their current state version.

---

## Event History

Important state changes should generate events.

Example:

```text
#104  General election opened
#105  Player joined
#106  Ballot submitted
#107  Ballot submitted
#108  General election closed
#109  Election result certified
#110  Coalition formed
#111  Prime Minister appointed
```

The event system can later be expanded into a tamper-evident audit log.

---

## Secret Voting

Some votes should support secret ballots.

Examples include:

- general elections;
- constitutional referendums;
- Host elections;
- removal votes.

Public legislative votes can remain visible.

The initial version may use simpler trusted-host ballot handling.

A later version may add cryptographic ballot protection so that even the Lobby Owner cannot inspect individual secret votes.

---

## Host Migration

The game should not end just because the original Lobby Owner disconnects.

Connected players should maintain sufficiently recent copies of the game state to allow another player to become Lobby Owner.

Possible flow:

```text
Lobby Owner disconnects
        ↓
Peers detect connection loss
        ↓
Replacement Lobby Owner selected
        ↓
Latest valid state recovered
        ↓
Game continues
```

This is a networking mechanism only.

It does not alter any constitutional office.

---

## Development Roadmap

### Phase 1 — Offline Prototype

- Main menu
- Create local game
- Player management
- Political parties
- Basic game state
- Local save/load
- Basic UI

### Phase 2 — Elections

- Election creation
- Voting
- Ranked-choice counting
- Proportional seat allocation
- Committee elections
- Results screen

### Phase 3 — Legislature and Government

- Legislature
- MPs
- Bills
- Coalitions
- Prime Minister
- Ministers
- Confidence system

### Phase 4 — Laws and Constitution

- Law proposals
- Legislative voting
- Referendums
- Constitutional amendments
- Rule history

### Phase 5 — Committees and Cases

- AC
- PC
- PAC
- PPC
- Evidence
- Jury selection
- Verdicts
- Punishment

### Phase 6 — Multiplayer

- P2P lobby creation
- Lobby codes
- Invite links
- State replication
- Reconnection
- Lobby Owner migration

### Phase 7 — Persistence and Recovery

- IndexedDB
- Automatic snapshots
- Export/import
- Recovery tools
- State validation

### Phase 8 — Security

- Player identities
- Signed actions
- Tamper detection
- Improved secret ballots
- Audit verification

---

## Running Locally

The project should eventually be runnable with any simple static web server.

For example:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

Some browser networking features may require the project to run through HTTP/HTTPS rather than directly opening `index.html`.

---

## GitHub Pages

The production game can be published using GitHub Pages.

Once enabled, players will be able to open the game directly from a browser without installing anything.

A typical deployment would look like:

```text
https://USERNAME.github.io/democracy-web/
```

Players could then create a lobby and share an invite link through WhatsApp, Discord or another messaging service.

---

## Communication

The website is intended to handle official game mechanics.

Political discussion can happen elsewhere.

For example:

**WhatsApp / Discord**

- campaigning
- debates
- manifestos
- coalition negotiations
- political discussion

**Democracy Web**

- official elections
- laws
- legislature
- government
- committees
- cases
- Constitution
- official records

This keeps the social side of the game flexible while giving important political actions a reliable official record.

---

## Status

Early development.

The current focus is designing the architecture and building the first playable prototype.

---

## License

A licence has not yet been selected.

Before accepting outside contributions or releasing the project more widely, an appropriate open-source licence should be added.
