import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app=readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
const attention=readFileSync(new URL('../js/attention.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../css/components.css',import.meta.url),'utf8');
const config=readFileSync(new URL('../js/config.js',import.meta.url),'utf8');

assert.match(config,/1\.2\.0-phase69/);
assert.match(html,/data-route="actions"/);
assert.match(html,/id="actionBadge"/);
assert.match(app,/function actionsPage\(\)/);
assert.match(app,/Needs you now/);
assert.match(app,/Coming up/);
assert.match(app,/For your information/);
assert.match(app,/Why am I seeing this\?/);
assert.match(attention,/snoozed/);
assert.match(attention,/snoozeAttention/);
assert.match(app,/function listToolbar\(/);
assert.match(app,/function applyListTools\(/);
for (const page of ['votes','elections','laws','cases','players','activity']) {
  assert.ok(app.includes(`listToolbar('${page}'`), `missing list toolbar for ${page}`);
  assert.ok(app.includes(`data-list-container=\\"${page}\\"`) || app.includes(`data-list-container="${page}"`), `missing list container for ${page}`);
}
assert.match(css,/\.list-toolbar/);
assert.match(css,/\.my-actions-summary/);
console.log('PASS phases 59–60 frontend');
