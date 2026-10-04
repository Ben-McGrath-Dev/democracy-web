import fs from 'node:fs';
import assert from 'node:assert/strict';

const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const help = fs.readFileSync(new URL('../js/help.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../css/components.css', import.meta.url), 'utf8');
const config = fs.readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');

assert.match(config, /1\.2\.0-phase(?:4[8-9]|5[0-9]|[6-9][0-9])/);
assert.match(index, /data-route="help"/);
assert.match(app, /registerRoute\('help', helpPage\)/);
assert.match(app, /function cloudConnectionStages/);
assert.match(app, /connectionJourney\(cloud\)/);
assert.match(app, /Your next actions/);
assert.match(app, /Coming up/);
assert.match(app, /function showOnboarding\(force = false, stepIndex = 0\)/);
assert.match(help, /ONBOARDING_STEPS/);
assert.match(help, /GLOSSARY/);
assert.match(app, /data-action="show-guide"/);
assert.match(app, /function processTracker/);
for (const guide of ['multiplayer','votes','elections','parliament','government','laws','constitution','committees','cases']) {
  assert.ok(app.includes(`guideButton('${guide}')`), `missing contextual guide: ${guide}`);
}
assert.match(css, /\.process-tracker/);
assert.match(css, /\.connection-journey/);
assert.match(css, /\.help-grid/);
assert.match(css, /\.attention-command/);
console.log('PASS phases 45–48 frontend experience');
