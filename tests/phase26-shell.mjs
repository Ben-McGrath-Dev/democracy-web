import fs from 'node:fs';
import assert from 'node:assert/strict';
const read=p=>fs.readFileSync(new URL(p,import.meta.url),'utf8');
const html=read('../index.html'),app=read('../js/app.js'),main=read('../css/main.css'),manifest=read('../manifest.webmanifest'),sw=read('../sw.js'),config=read('../js/config.js');
const manifestJson=JSON.parse(manifest);
const checks=[
 ['Phase 26+ version', /APP_VERSION\s*=\s*['\"](?:1\.[1-9]\.0(?:-phase\d+)?|1\.0\.[0-9]+|0\.(?:2[6-9]|[3-9]\d)\.)/.test(config)],
 ['Notifications route',app.includes("registerRoute('notifications'")&&html.includes('notificationBadge')],
 ['Optional browser notifications',app.includes('requestBrowserPermission')&&app.includes('toggle-browser-notifications')],
 ['PWA manifest',html.includes('manifest.webmanifest')&&manifestJson.display==='standalone'],
 ['Service worker registration',app.includes("serviceWorker")&&app.includes("register('./sw.js')")],
 ['Install prompt',app.includes('beforeinstallprompt')&&app.includes("action === 'install-app'")],
 ['Skip link',html.includes('class="skip-link"')],
 ['Visible focus',main.includes(':focus-visible')],
 ['Modal focus trap',app.includes("e.key==='Tab'")&&app.includes("e.key==='Escape'")],
 ['Reduced motion',main.includes('prefers-reduced-motion')],
 ['Forced colours',main.includes('forced-colors: active')],
 ['Live region',html.includes('aria-live="polite"')]
];
for(const [name,ok] of checks){assert.ok(ok,name);console.log(`PASS: ${name}`)}
console.log('Phase 24–26 shell tests passed.');
