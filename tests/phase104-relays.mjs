import fs from 'node:fs';

const network = fs.readFileSync(new URL('../js/network.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

const checks = [
  [!network.includes('nostr.tegila.com.br'), 'failed tegila relay removed'],
  [network.includes('warnOnRelayFailure: false'), 'relay warning suppression enabled'],
  [network.includes("'wss://nos.lol'"), 'custom Nostr relay list present'],
  [(network.match(/wss:\/\//g) || []).length >= 6, 'multiple signaling relays configured'],
  [network.includes('signaling: signalingStatus()'), 'signaling health exported'],
  [app.includes('Signaling Relays'), 'signaling health visible in UI']
];

for (const [ok, label] of checks) {
  if (!ok) throw new Error(`FAIL: ${label}`);
}
console.log('PASS Democracy Web 1.0.4 signaling relay hotfix checks');
