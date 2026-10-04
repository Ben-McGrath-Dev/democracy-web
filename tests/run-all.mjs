import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter(name => name.endsWith('.mjs') && name !== 'run-all.mjs').sort();
for (const name of files) {
  console.log(`\n== ${name} ==`);
  const result = spawnSync(process.execPath, [join(dir, name)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`\nPASS full Democracy Web test suite — ${files.length} test files`);
