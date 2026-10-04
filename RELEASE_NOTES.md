# Democracy Web 1.2.0-phase69 — Laws, Constitution, Committees & Cases Polish

Phases 68–69 continue the second frontend pass with **equal desktop and phone polish**. Dense legal and procedural pages now use deliberate workspaces on large screens and compact action-first flows on small screens, without changing the political engine.

## Phase 68 — Laws and Constitution

- Laws is split into remembered **In progress**, **Statute book** and **Archive** workspaces.
- Law detail pages put the actual legal text first, with procedure and linked vote/referendum stages alongside it on desktop and below it on phone.
- The Constitution has live search across section number/title/category/text, a sticky desktop contents rail and horizontally scrollable mobile contents.
- Every structured constitutional section has a stable deep link and an effective-text detail view.
- Applied amendments link back to the section they changed and remain visible in the constitutional changelog.

## Phase 69 — Committees and Cases

- Committees the connected player serves on are prioritised, with open matters shown before completed work.
- Committee pages clarify purpose, members, alternates, Decision Membership, recusals and matter progression.
- Cases now begin with **Your case actions** when the verified player has a formal action available.
- Case detail pages separate the official record into complaint, response, PAC finding, jury review and PPC outcome instead of presenting one dense card.
- The case UI preserves the rulebook flow: every PAC Guilty finding receives mandatory jury review, and PPC punishment follows only after an upheld Guilty finding.

## Desktop and phone parity

- Desktop uses two-column document/procedure layouts, sticky navigation and wider record grids instead of merely stretching mobile cards.
- Phone uses compact workspace tabs, horizontal constitutional contents, one-column procedural records and touch-friendly primary actions.
- Both layouts expose the same political information and capabilities; neither is treated as the secondary interface.

## Phase 66 — Votes and Elections

- The Votes page now begins with **Your ballots**, showing open ballots that still need the connected player’s action.
- When there is nothing to cast, a clear caught-up state replaces an empty/actionless area.
- Current elections receive a focused lifecycle card showing election type, state, electorate size, deadline and the player’s own ballot state.
- Ranked-choice ballots have clearer instructions, larger mobile controls and candidate-party context when available.
- Existing visual results, sealed-ballot verification and administrative controls remain available below the simpler summaries.

## Phase 67 — Parliament and Government

- Occupied seats in the Parliament map are now interactive and open the MP’s player profile.
- Parliament member tables switch to touch-friendly MP cards on narrow screens.
- The Government page now presents the administration and its majority position before lower-level controls.
- Government formation shows selected coalition seats live, marks the majority threshold and states how many more seats are needed.
- Coalition feedback updates immediately as governing parties are selected.

## Phase 64 — Forms, drafts and review

- Important forms now use consistent required markers, inline validation and character counters.
- Longer forms autosave drafts on the current device and offer a clear discard control when restored.
- Large player/member selectors become searchable and show the current selection count.
- High-impact forms show a review screen before submission so users can catch mistakes without losing their work.
- Ballots have a final review step, but ballot choices are deliberately **not** stored in local form drafts.
- Inputs are normalized before submission and duplicate taps are blocked while an action is being processed.

## Phase 65 — Consequence previews and action feedback

- Important actions now explain **who is acting**, **what will change**, and whether the action is effectively irreversible from the interface.
- Vote opening/closing/certification, government changes, committee procedure, case stages, law/constitution finalization, resignations, recovery and save deletion receive explicit confirmation where appropriate.
- Case confirmations preserve the actual rulebook flow: PAC finding → mandatory jury review after Guilty → PPC punishment only if upheld.
- Errors remain visible long enough to act on, while success messages say what actually happened.

## Mobile GUI improvements pulled forward

- The mobile header now shows the current page rather than acting like a compressed desktop header.
- Bottom navigation is focused on **Home, My Actions, Votes, Cases and Menu**.
- The full menu is grouped by purpose instead of presenting one large undifferentiated grid.
- Connection state and **Acting as** identity are visible in the mobile menu before official actions are taken.
- Detail pages get a real mobile Back control.
- Form dialogs behave as mobile bottom sheets with large controls and sticky Review/Confirm actions.
- Important page-level form actions remain reachable above the mobile dock.

## Constitutional terminology

**AC means Actions Committee only.** The personal task surface remains **My Actions**.

## Verification

- New Phase 68–69 regression coverage protects the legislation workspaces, constitutional deep links, committee prioritisation, procedural case records and responsive parity.
- Earlier Phase 64–65 regression coverage continues to protect forms, confirmations and the mobile shell.
- No political reducer, counting, threshold, permission or Cloud-authority behavior was changed.

---

# Democracy Web 1.2.0-phase63 — Understand Every Political Object

Phases 61–63 add deep-linked political object pages, consistent status language and contextual guidance grounded in the Democracy Constitution.

## Constitutional terminology correction

**AC always means Actions Committee.** The personal agenda introduced in Phase 59 is now called **My Actions**. The Help glossary has also been corrected so it no longer calls AC an “Amendment Committee”.

## Phase 61 — Detail pages and deep links

- Dedicated routes for votes/elections, laws, amendments, cases, committees, players and parties.
- Breadcrumbs and parent-section highlighting.
- Command search opens exact objects.
- Browser titles update to the current object.
- Detail pages show procedure, related records and object-specific official history.

## Phase 62 — Status and terminology

- Central human-readable status explanations for votes, laws, amendments and cases.
- “Your status” / “Your role” is separated from the official object state.
- Internal-looking case states such as `awaiting-jury` are presented as meaningful procedural language.

## Phase 63 — What happens next?

- Rulebook-aware next-step panels explain who acts next and why.
- Case guidance preserves the constitutional separation of powers: PAC decides ordinary-law guilt, jury reviews every PAC Guilty finding, and PPC determines punishment only after an upheld finding.
- Committee pages explain the distinct constitutional roles of AC, PC, PAC and PPC, plus Decision Membership and recusal principles.
- Disabled actions continue to explain why the current player cannot perform them.

## Verification

- Added Phase 61–63 frontend regression coverage, including an explicit AC terminology guard.
- No political reducer, counting, threshold, permission or Cloud-authority behavior was changed.

---

# Democracy Web 1.2.0-phase58 — Frontend Second Pass

This frontend-only build begins the second frontend pass with Phases 57–58. It establishes a broader design system and overhauls navigation with collapsible remembered groups, actionable badges, persistent identity/connection context, global command search and proper browser history/scroll restoration. No political rules or Cloud protocol behavior changed.

## Phase 57 — Design-system foundations
- Expanded spacing, type, control, motion, focus, elevation and semantic tokens.
- Added reusable semantic card/status states, button sizes, avatars, metadata rows and keyboard-hint styling.

## Phase 58 — Navigation and app shell
- Remembered collapsible sidebar groups.
- Action badges for outstanding ballots/case actions.
- Persistent acting-player and local/Cloud connection context.
- Ctrl/Cmd+K command search over pages and current-game objects, with recent destinations.
- Improved mobile search/navigation and real Back/Forward route history with scroll restoration.

This frontend-only preview builds on the earlier Phases 45–52 experience work without changing Democracy Web's political rules or Cloud authority model.

## Phase 49 — Role-aware experience
- Controls now reflect the connected player's actual roles such as Host, Deputy Host, MP, Prime Minister, coalition leader and party leader.
- Administration actions are hidden when irrelevant or shown disabled with a plain-language reason.
- Rich empty states explain what must happen before a feature becomes available.

## Phase 50 — Elections and voting results
- Visual turnout and result bars.
- Ranked-choice results shown round by round.
- Proportional results show votes, seats and threshold status.
- Largest-remainder results include an expandable calculation explanation.
- Eligible players get clear personal ballot state such as "Your vote is needed" and "Your ballot is submitted".

## Phase 51 — Parliament and Government
- Parliament seat map with the local MP highlighted.
- Party seat-share graphics and majority threshold presentation.
- Government-vs-other-seat balance with coalition composition.
- Role-aware government management and minister controls.

## Phase 52 — Laws and Constitution
- Per-proposal legislative lifecycle trackers and petition progress.
- Cleaner statute book with expandable current wording.
- Constitutional amendments compare current and proposed wording side by side.
- Structured Constitution browser marks Base, Editable, Protected and Amended sections.
- Base-rule unlocks show their protected procedure as a visual workflow.


## Audit hardening included

A broad codebase audit after Phase 56 also tightened Cloud connection failure handling, party metadata/CSS validation, onboarding completion, modal error handling, online self-identity presentation for petitions/cases, release metadata consistency and Help terminology. The political reducer rules and Cloud authority protocol remain unchanged.

## Compatibility
The political reducer, vote counting, permissions, constitutional thresholds, Cloud signed-action sequencer, persistence and recovery systems are unchanged from the underlying 1.1 Cloud architecture.
## Phase 69 guide update — Your own Cloudflare Worker

Democracy Web now includes a beginner-first self-hosting handbook for users who want their own Cloud backend URL, such as `https://democracy-web-cloud.example.workers.dev`. The expanded guide walks from Cloudflare account creation and GitHub source download through terminal navigation, Node/npm checks, dependency installation, optional local Worker testing, `ALLOWED_ORIGINS`, Wrangler authentication/account verification, dry-run validation, first workers.dev deployment, `/health` verification, Multiplayer connection, second-device testing and safe future updates. A detailed debugging decision tree covers Windows PowerShell policy errors, missing Node/npm, OAuth/account mistakes, CORS/origin rejection, disabled or Access-protected workers.dev routes, missing rooms, WebSocket failures, stale local Durable Object state, Durable Object configuration problems and Cloudflare usage limits. It also links directly to the relevant current Cloudflare documentation and uses router-safe setup navigation on both phone and desktop.
