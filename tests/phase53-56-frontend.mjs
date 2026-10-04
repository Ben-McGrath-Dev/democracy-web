import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../js/app.js', import.meta.url),'utf8');
const css = fs.readFileSync(new URL('../css/components.css', import.meta.url),'utf8');
const responsive = fs.readFileSync(new URL('../css/responsive.css', import.meta.url),'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
const config = fs.readFileSync(new URL('../js/config.js', import.meta.url),'utf8');

assert.match(config,/1\.2\.0-phase69/);
// Phase 53 committees/cases
for (const token of ['committee-summary','person-chip-row','caseStage','case-panels','Your committee','PAC panel','Jury']) assert.match(app,new RegExp(token));
assert.match(css,/\.committee-card/); assert.match(css,/\.case-card/);
// Phase 54 profiles/activity
for (const token of ['playerProfileHtml','playerPublicActivity','activityPage','Full Activity Timeline','Political record']) assert.match(app,new RegExp(token));
assert.match(html,/data-route="activity"/); assert.match(css,/\.activity-timeline/); assert.match(css,/\.profile-preview/);
// Phase 55 simple/advanced + mobile
for (const token of ['UI_MODE_KEY','getUiMode','setUiMode','toggle-ui-mode']) assert.match(app,new RegExp(token));
assert.match(html,/data-ui-mode="simple"/); assert.match(html,/advanced-only/); assert.match(css,/data-ui-mode="simple"/); assert.match(responsive,/player-profile-grid/);
// Phase 56 Coach
for (const token of ['deriveCoachTips','coachPanel','Democracy Coach','What should I do next']) assert.match(app,new RegExp(token));
assert.match(css,/\.coach-panel/);
console.log('PASS frontend phases 53-56');
