import fs from 'node:fs';
import assert from 'node:assert/strict';
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const html=read('../index.html'), app=read('../js/app.js'), responsive=read('../css/responsive.css'), main=read('../css/main.css'), config=read('../js/config.js');
const checks=[
 ['Phase 23+ version',/APP_VERSION\s*=\s*'(?:1\.[1-9]\.[0-9]+(?:-phase\d+)?|1\.0\.[0-9]+|0\.(?:2[3-9]|[3-9]\d)\.)/.test(config)],
 ['Desktop sidebar',html.includes('class="sidebar"')&&html.includes('class="side-nav"')],
 ['Mobile bottom dock',html.includes('class="mobile-dock"')],
 ['Mobile full menu',html.includes('id="mobileMenu"')&&app.includes('setMobileMenu')],
 ['Attention dashboard',app.includes('Needs attention')&&app.includes('Political state')],
 ['Quick political links',main.includes('.quick-links')&&app.includes('quick-link')],
 ['Web Share integration',app.includes('navigator.share')&&app.includes("action === 'share-game'")],
 ['Vote sharing',app.includes("action === 'share-vote'")],
 ['WhatsApp status copy',app.includes("action === 'copy-status-summary'")],
 ['Responsive mobile breakpoint',responsive.includes('@media (max-width: 860px)')],
 ['Bottom sheet modals',responsive.includes('place-items:end center')],
 ['Safe-area support',responsive.includes('env(safe-area-inset-bottom)')]
];
for(const [name,ok] of checks){assert.ok(ok,name);console.log(`PASS: ${name}`)}
console.log('Phase 22–23 UI/mobile structural tests passed.');
