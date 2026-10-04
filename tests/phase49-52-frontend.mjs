import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../css/components.css', import.meta.url), 'utf8');
const config = fs.readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');

assert.match(config, /1\.2\.0-phase(?:5[2-9]|[6-9][0-9])/);

// Phase 49 — role-aware UI and explanatory disabled states.
assert.match(app, /function actorCapabilities/);
assert.match(app, /function unavailableAction/);
assert.match(app, /Your election role/);
assert.match(app, /Your parliamentary role/);
assert.match(app, /Your government role/);
assert.match(app, /Your legislative role/);
assert.match(css, /\.role-context/);
assert.match(css, /\.disabled-reason/);
assert.match(css, /\.empty-state-rich/);

// Phase 50 — election visualisation.
assert.match(app, /function resultBars/);
assert.match(app, /How were the seats calculated\?/);
assert.match(app, /Final active preferences/);
assert.match(app, /Your ballot is submitted/);
assert.match(css, /\.result-bars/);
assert.match(css, /\.ranked-round/);

// Phase 51 — Parliament and Government visual overhaul.
assert.match(app, /class="seat-map"/);
assert.match(app, /Government majority/);
assert.match(app, /class="government-balance"/);
assert.match(css, /\.seat-map/);
assert.match(css, /\.government-balance/);

// Phase 52 — Laws and Constitution visual overhaul.
assert.match(app, /Legislative Pipeline/);
assert.match(app, /class="constitutional-diff"/);
assert.match(app, /Current Constitution/);
assert.match(app, /class="constitution-browser"/);
assert.match(css, /\.petition-progress/);
assert.match(css, /\.constitutional-diff/);
assert.match(css, /\.constitution-browser/);

console.log('PASS phases 49–52 frontend visual overhaul');
