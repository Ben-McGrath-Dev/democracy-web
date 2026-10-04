export const HELP_GUIDES = {
  gettingStarted: {
    title: 'Getting Started',
    summary: 'Create or load a Democracy, understand your role, and find the actions that need you.',
    steps: [
      'Create or load a Democracy save.',
      'Check the Dashboard for actions requiring your attention.',
      'Use Multiplayer to publish or join a Cloud room when playing with other people.',
      'Run binding political actions inside Democracy Web; use chat apps for campaigning and discussion.',
      'Export occasional backups for long-running games.'
    ]
  },
  multiplayer: {
    title: 'Cloud Multiplayer',
    summary: 'Cloudflare provides reliable transport while player actions remain cryptographically signed.',
    steps: [
      'The host publishes an existing save to Cloud and shares the invite link.',
      'A joining browser proves ownership of its local player identity.',
      'New identities request access and an authorised player approves or rejects the request.',
      'The client verifies a canonical snapshot before official actions are enabled.',
      'After an interruption, Democracy Web resumes from the last verified commit or a persistent snapshot.'
    ]
  },
  cloudflareSetup: {
    title: 'Create your own Cloudflare backend',
    summary: 'Download the full Democracy Web source from GitHub, deploy the included Worker/Durable Object backend, then paste your workers.dev URL into Multiplayer.',
    steps: [
      'Create or sign in to a Cloudflare account; SQLite Durable Objects are supported on the Workers Free plan within its usage limits.',
      'Download or clone the full source repository from GitHub — the hosted website alone does not contain the deployment project.',
      'Open a terminal in the repository root and verify Node.js/npm before installing dependencies.',
      'Optionally run the Worker locally and verify the /health endpoint.',
      'Check ALLOWED_ORIGINS in wrangler.jsonc if your frontend uses a different domain.',
      'Sign Wrangler into the correct Cloudflare account and verify it with wrangler whoami.',
      'Run wrangler deploy --dry-run, then the included cloud:deploy command and register a workers.dev account subdomain if Cloudflare asks.',
      'Test the public /health endpoint, save the root Worker URL in Multiplayer, Publish & Connect, and test the invite from a second browser/device.',
      'If anything fails, follow the in-app decision tree and use wrangler tail to capture the actual Worker exception.'
    ]
  },
  votes: {
    title: 'Votes',
    summary: 'Votes snapshot an electorate, accept one valid ballot per voter, then count and certify a result.',
    steps: ['Create the vote and configure its electorate.', 'Open voting.', 'Eligible players cast ballots before the deadline.', 'Close and count the vote.', 'Certify the result when the procedure is complete.']
  },
  elections: {
    title: 'Elections',
    summary: 'General, Host, Deputy Host and committee elections use different counting systems.',
    steps: ['Create the correct election type.', 'Confirm candidates/options and electorate.', 'Open voting.', 'Count using the election-specific method.', 'Certify the result so offices or seats update.']
  },
  parliament: {
    title: 'Parliament',
    summary: 'Parliament is created by a certified General Election. Filled seats determine the majority threshold.',
    steps: ['Certify a General Election.', 'Seats are assigned from electoral lists.', 'MPs take part in parliamentary votes.', 'Vacancies are filled from the same electoral list when possible.', 'Government confidence is measured against the sitting Parliament.']
  },
  government: {
    title: 'Government',
    summary: 'A government needs enough parliamentary support to hold a majority and can enter caretaker status if support is lost.',
    steps: ['Form a coalition from represented parties.', 'Select a Prime Minister and ministers.', 'Confirm the coalition reaches the current majority threshold.', 'Use confidence procedures when support is disputed.', 'If no replacement is formed in time, an early election may be required.']
  },
  laws: {
    title: 'How laws work',
    summary: 'Legislation progresses from proposal through discussion, Parliament and any referendum window.',
    steps: ['Proposal or qualifying petition.', 'Discussion period.', 'Freeze the final text.', 'Parliamentary vote.', 'Referendum petition/window where applicable.', 'Enact, reject, amend or repeal.']
  },
  constitution: {
    title: 'Constitutional amendments',
    summary: 'The Constitution belongs to the save and changes only through its amendment procedures.',
    steps: ['Propose an amendment using a valid sponsorship route.', 'Complete the discussion period.', 'Freeze the amendment text.', 'Hold the required public vote.', 'Apply the amendment only if turnout and approval thresholds pass.']
  },
  committees: {
    title: 'Committees',
    summary: 'AC, PC, PAC and PPC have distinct responsibilities, memberships and recusal rules.',
    steps: ['Elect or appoint the committee membership.', 'Select alternates/chairs where required.', 'Open a committee matter.', 'Apply recusals before the decision electorate is fixed.', 'Record and certify the committee decision.']
  },
  cases: {
    title: 'Cases and accountability',
    summary: 'Cases move through complaint, response, PAC review, jury review and PPC punishment where applicable.',
    steps: ['Complaint is opened with evidence.', 'The accused may respond.', 'A PAC panel decides guilt/not-guilt.', 'A guilty decision proceeds to secret jury review.', 'If upheld, PPC determines punishment.', 'Close the case with a complete official history.']
  }
};

export const GLOSSARY = [
  ['AC', 'Actions Committee — the elected constitutional oversight body. It determines constitutional compliance, reviews specified administrative and election matters, and interprets genuine constitutional ambiguity; it does not determine punishment.'],
  ['PAC', "People's Actions Committee — investigates alleged ordinary-law violations through PAC case panels."],
  ['PPC', "People's Punishment Committee — determines lawful punishment after an upheld guilty finding."],
  ['PC', 'Punishment Committee — determines punishment following constitutional findings by the Actions Committee where appropriate.'],
  ['Host', 'The neutral constitutional administrator of the Democracy.'],
  ['Deputy Host', 'The deputy constitutional administrator and fallback for Host responsibilities where rules permit.'],
  ['MP', 'Member of Parliament; a player occupying a legislative seat.'],
  ['Caretaker government', 'A government operating temporarily while a replacement majority is being formed.'],
  ['Constructive no-confidence', 'A no-confidence process that identifies a replacement government rather than only removing the current one.'],
  ['Largest remainder', 'The proportional seat-allocation method used after applying the election threshold.'],
  ['Recusal', 'Removing a conflicted committee member from a specific decision.'],
  ['Base Rule', 'A specially protected constitutional rule that must first be unlocked before it can be amended.']
];

export const ONBOARDING_STEPS = [
  { title: 'Welcome to Democracy Web', body: 'Democracy Web runs the official machinery of your political simulation. The Dashboard is your starting point: it tells you what needs your attention and what is happening now.' },
  { title: 'Your political identity', body: 'In Cloud multiplayer, actions are tied to the cryptographic identity in this browser. You only act as your own player; join requests and party membership changes require the appropriate consent.' },
  { title: 'Votes and elections', body: 'When you are eligible to vote, the Dashboard and Notifications pages surface the ballot. Election pages explain the counting system and show where the election is in its lifecycle.' },
  { title: 'Parliament and government', body: 'General Elections create Parliament. Coalitions form governments, and parliamentary support determines whether a government has a majority.' },
  { title: 'Laws and Constitution', body: 'Bills and amendments move through visible stages. Use the “How this works” guide on each page whenever you need the exact flow.' },
  { title: 'Help is always available', body: 'Open Help from the sidebar for short guides, a glossary, and links back to the Full Rulebook. You can replay this introduction at any time.' }
];
