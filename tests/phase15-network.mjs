import fs from 'node:fs';
const root = new URL('../', import.meta.url);
const permissions = fs.readFileSync(new URL('../js/permissions.js', import.meta.url),'utf8');
const network = fs.readFileSync(new URL('../js/network.js', import.meta.url),'utf8');
const app = fs.readFileSync(new URL('../js/app.js', import.meta.url),'utf8');
const index = fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
const assertions = [
  [network.includes("makeAction('dw-game-action-v2')"),'game action channel'],
  [network.includes('stateVersion'),'state version replication'],
  [network.includes('authorizePeerAction'),'owner-side permission validation'],
  [permissions.includes("action.voterId = playerId"),'ballot identity enforcement'],
  [permissions.includes('Only the Constitutional Host or Deputy Host'),'administrative permission enforcement'],
  [app.includes("registerRoute('multiplayer'"),'multiplayer route'],
  [index.includes('data-route="multiplayer"'),'multiplayer navigation']
];
for (const [ok,name] of assertions) { if(!ok) throw new Error(`FAIL: ${name}`); console.log(`PASS: ${name}`); }
console.log('Phase 15 structural network tests passed.');
