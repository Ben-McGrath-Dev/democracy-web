import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const help = fs.readFileSync(new URL('../js/help.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../css/components.css', import.meta.url), 'utf8');
const responsive = fs.readFileSync(new URL('../css/responsive.css', import.meta.url), 'utf8');
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');

for (const token of [
  'Create your own Cloudflare link',
  'github.com/Ben-McGrath-Dev/democracy-web/tree/main',
  'node --version',
  'npm --version',
  'npm install',
  'npx wrangler --version',
  'npx wrangler login',
  'npx wrangler whoami',
  'npm run cloud:dev',
  '.wrangler/state',
  'ALLOWED_ORIGINS',
  'location.origin',
  'npx wrangler deploy --dry-run',
  'npm run cloud:deploy',
  '/health',
  'npx wrangler deployments list',
  'npx wrangler versions list',
  'npx wrangler tail democracy-web-cloud',
  'origin_not_allowed',
  'WebSocket connection failed',
  'workers.dev',
  'data-action="cloud-guide-jump"',
  "registerRoute('cloud-setup'",
  'copy-cloud-command',
  'Set up your own Cloudflare link',
  'Durable Object troubleshooting',
  'Workers logs'
]) assert.match(app, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

// The guide must not use raw #cloud-step links: the app router owns the URL hash.
assert.doesNotMatch(app, /href=["']#cloud-step-/);
assert.match(help, /cloudflareSetup/);
assert.match(help, /wrangler whoami/);
assert.match(help, /wrangler tail/);
assert.match(css, /\.cloud-guide-layout/);
assert.match(css, /\.cloud-debug-flow/);
assert.match(css, /\.cloud-guide-jump/);
assert.match(responsive, /\.cloud-guide-layout\{grid-template-columns:1fr\}/);
assert.match(readme, /Create your own `workers\.dev` Cloud backend/);
assert.match(readme, /npx wrangler deploy --dry-run/);
assert.match(readme, /npm\.cmd run cloud:deploy/);
assert.match(readme, /\.wrangler\/state/);

console.log('PASS expanded Cloudflare self-host deployment guide');
