import fs from 'node:fs';
import assert from 'node:assert/strict';
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const app = read('../js/app.js');
const net = read('../js/network.js');
const storage = read('../js/storage.js');
const ballots = read('../js/secret-ballots.js');
const config = read('../js/config.js');
const html = read('../index.html');
const checks = [
  ['Phase 21+ version', /(?:1\.0\.[0-9]+|0\.(2[1-9]|[3-9][0-9])\.0-phase)/.test(config)],
  ['Recovery navigation', html.includes('data-route="recovery"')],
  ['Recovery route', app.includes("registerRoute('recovery', recoveryPage)" )],
  ['Manual full resync', net.includes('export function requestFullResync')],
  ['Recovery-state rebroadcast', net.includes('export function broadcastRecoveryState')],
  ['Recovery diagnostics', net.includes('export function getRecoveryDiagnostics')],
  ['Verified snapshot read', storage.includes('export async function getSnapshot')],
  ['Snapshot restore', storage.includes('export async function restoreSnapshot')],
  ['Snapshot audit', storage.includes('export async function verifySnapshots')],
  ['Pre-restore safety snapshot', app.includes("createSnapshot(current,'pre-restore')")],
  ['Ballot recovery export', ballots.includes('export async function exportBallotBoxRecovery')],
  ['Ballot recovery import', ballots.includes('export async function importBallotBoxRecovery')],
  ['PBKDF2 recovery KDF', ballots.includes("name: 'PBKDF2'") && ballots.includes('iterations: 250000')],
  ['AES-GCM recovery encryption', ballots.includes("name:'AES-GCM'")],
  ['Recovery package UI', app.includes('Sealed Ballot Recovery')]
];
for (const [name, ok] of checks) { assert.ok(ok, name); console.log(`PASS: ${name}`); }
console.log('Phase 21 recovery structural tests passed.');
