import fs from 'node:fs';
import assert from 'node:assert/strict';
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const app = read('../js/app.js');
const legacyP2P = fs.existsSync(new URL('../js/network.js', import.meta.url));
const net = legacyP2P ? read('../js/network.js') : read('../js/cloud-network.js');
const storage = read('../js/storage.js');
const ballots = read('../js/secret-ballots.js');
const config = read('../js/config.js');
const html = read('../index.html');
const checks = [
  ['Phase 21+ version', /(?:1\.[1-9]\.0(?:-phase\d+)?|1\.0\.[0-9]+|0\.(2[1-9]|[3-9][0-9])\.0-phase)/.test(config)],
  ['Recovery navigation', html.includes('data-route="recovery"')],
  ['Recovery route', app.includes("registerRoute('recovery', recoveryPage)" )],
  ['Manual full resync', legacyP2P ? net.includes('export function requestFullResync') : net.includes('export function requestCloudResync')],
  ['Recovery-state rebroadcast / durable recovery', legacyP2P ? net.includes('export function broadcastRecoveryState') : net.includes('RECOVERY_BUNDLE')],
  ['Recovery diagnostics', legacyP2P ? net.includes('export function getRecoveryDiagnostics') : net.includes('recoverySource')],
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
