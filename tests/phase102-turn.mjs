import fs from 'node:fs/promises';
import fsSync from 'node:fs';
const LEGACY_P2P_RETIRED = !fsSync.existsSync(new URL('../js/network.js', import.meta.url));
if (LEGACY_P2P_RETIRED) {
  console.log('PASS: legacy P2P transport intentionally retired in Democracy Web 1.1 / Phase 44');
  process.exit(0);
}

const network = await fs.readFile(new URL('../js/network.js', import.meta.url), 'utf8');
const app = await fs.readFile(new URL('../js/app.js', import.meta.url), 'utf8');
const config = await fs.readFile(new URL('../js/config.js', import.meta.url), 'utf8');

const checks = [
  ['version 1.0.2+', /APP_VERSION = '(?:1\.[1-9]\.0(?:-phase\d+)?|1\.0\.[2-9][0-9]*)'/.test(config)],
  ['turnConfig passed to Trystero', network.includes('config.turnConfig')],
  ['relay-only ICE test', network.includes("iceTransportPolicy: 'relay'")],
  ['local TURN settings', network.includes('democracy-web.turn-settings.v1')],
  ['TURN credentials not in game state', !network.includes('updateTechnicalNetworkState({turn')],
  ['TURN settings UI', app.includes('TURN Relay Fallback')],
  ['force relay UI', app.includes('turnForceRelay')],
  ['save TURN action', app.includes("action === 'save-turn-settings'")],
];
const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error('FAIL Phase 1.0.2 TURN:', failed.map(([name]) => name).join(', '));
  process.exit(1);
}
console.log('PASS Democracy Web 1.0.2+ TURN fallback checks');
