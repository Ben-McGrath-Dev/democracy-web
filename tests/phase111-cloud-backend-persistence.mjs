import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem(key) { return store.has(key) ? store.get(key) : null; },
  setItem(key, value) { store.set(key, String(value)); },
  removeItem(key) { store.delete(key); }
};

const { getCloudSettings, setCloudSettings } = await import('../js/cloud-network.js');

const production = 'https://democracy-web-cloud.ben-mcgrath-dev.workers.dev';
let settings = setCloudSettings({ apiBase: production, enabled: true });
assert.equal(settings.apiBase, production);
assert.equal(localStorage.getItem('democracy-web.cloud-backend-url'), production);
assert.equal(JSON.parse(localStorage.getItem('democracy-web.cloud-backend.v2')).apiBase, production);
assert.equal(getCloudSettings().apiBase, production);

// Dedicated cached URL remains authoritative even if the JSON settings entry is damaged.
localStorage.setItem('democracy-web.cloud-backend.v2', '{broken');
assert.equal(getCloudSettings().apiBase, production);

// Pasted Markdown links are normalized to their actual URL.
settings = setCloudSettings({ apiBase: `[${production}](${production})` });
assert.equal(settings.apiBase, production);
assert.equal(getCloudSettings().apiBase, production);

console.log('1.1.1 Cloud backend browser persistence: PASS');
