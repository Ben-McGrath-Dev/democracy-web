import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../css/components.css', import.meta.url), 'utf8');
const responsive = fs.readFileSync(new URL('../css/responsive.css', import.meta.url), 'utf8');
const config = fs.readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');

assert.match(config, /1\.2\.0-phase69/);

// Phase 68 — Laws and Constitution
for (const token of [
  'LAW_WORKSPACE_KEY',
  'set-law-workspace',
  'Statute book',
  'Proposal archive',
  'constitution-section/',
  'data-constitution-search',
  'constitution-toc',
  'Constitutional Changelog',
  'registerDetailRoute(\'constitution-section\''
]) assert.match(app, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(css, /\.legislation-detail-layout/);
assert.match(css, /\.constitution-workspace/);
assert.match(css, /\.constitution-toc/);
assert.match(responsive, /\.constitution-toc-list\{display:flex;overflow-x:auto/);

// Phase 69 — Committees and Cases
for (const token of [
  'Your committee work',
  'committeeMatterStage',
  'Your case actions',
  'case-record-grid',
  'Every Guilty PAC finding proceeds automatically to jury review.',
  'The PPC acts only after a Guilty finding has been upheld'
]) assert.match(app, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(css, /\.your-committee-strip/);
assert.match(css, /\.case-record-grid/);
assert.match(responsive, /\.case-record-grid\{grid-template-columns:1fr\}/);

// Preserve constitutional terminology and the older compact-view hook.
assert.match(app, /Actions Committee/);
assert.doesNotMatch(app, /Amendment Committee/);
assert.match(app, /case-record-grid case-panels/);

console.log('PASS phases 68–69 laws/constitution/committees/cases polished frontend');
