import fs from 'node:fs';
import assert from 'node:assert/strict';

const index=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
const router=fs.readFileSync(new URL('../js/router.js',import.meta.url),'utf8');
const vars=fs.readFileSync(new URL('../css/variables.css',import.meta.url),'utf8');
const components=fs.readFileSync(new URL('../css/components.css',import.meta.url),'utf8');
const main=fs.readFileSync(new URL('../css/main.css',import.meta.url),'utf8');
const config=fs.readFileSync(new URL('../js/config.js',import.meta.url),'utf8');

assert.match(config,/1\.2\.0-phase69/);
assert.match(vars,/--space-1:/);
assert.match(vars,/--control-md:/);
assert.match(vars,/--focus-ring:/);
assert.match(components,/card-warning/);
assert.match(components,/command-palette/);
assert.match(index,/data-action="toggle-nav-group"/);
assert.match(index,/id="voteBadge"/);
assert.match(index,/id="caseBadge"/);
assert.match(index,/id="shellActorName"/);
assert.match(index,/id="commandPalette"/);
assert.match(main,/sidebar-context/);
assert.match(app,/NAV_GROUPS_KEY/);
assert.match(app,/openCommandPalette/);
assert.match(app,/updateShellContext/);
assert.match(app,/rememberRecentRoute/);
assert.match(router,/history\.pushState/);
assert.match(router,/scrollPositions/);
assert.match(router,/popstate/);
assert.match(router,/location\.pathname.*location\.search/); // preserve hashless invite URLs until boot handles them
console.log('PASS frontend phases 57-58');
