import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['js','shared','worker/src'];
const files = roots.flatMap(dir => fs.readdirSync(path.join(root, dir), { recursive:true })
  .filter(name => name.endsWith('.js'))
  .map(name => path.join(root, dir, name)));

const cache = new Map();
function source(file) { if (!cache.has(file)) cache.set(file, fs.readFileSync(file,'utf8')); return cache.get(file); }
function resolveLocal(from, spec) {
  if (!spec.startsWith('.')) return null;
  let out = path.resolve(path.dirname(from), spec);
  if (!path.extname(out)) out += '.js';
  return out;
}
function exportedNames(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const text = source(file);
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const item of m[1].split(',')) {
      const bits = item.trim().split(/\s+as\s+/);
      if (bits[0]) names.add((bits[1] || bits[0]).trim());
    }
  }
  for (const m of text.matchAll(/export\s+\*\s+from\s+['"]([^'"]+)['"]/g)) {
    const target = resolveLocal(file, m[1]);
    if (target && fs.existsSync(target)) for (const name of exportedNames(target, seen)) names.add(name);
  }
  return names;
}

let checkedImports = 0;
for (const file of files) {
  const text = source(file);
  for (const m of text.matchAll(/import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[1].trim();
    const target = resolveLocal(file, m[2]);
    if (!target) continue;
    assert.ok(fs.existsSync(target), `${path.relative(root,file)} imports missing ${m[2]}`);
    checkedImports++;
    const named = clause.match(/\{([^}]+)\}/)?.[1];
    if (!named) continue;
    const available = exportedNames(target);
    for (const item of named.split(',')) {
      const imported = item.trim().split(/\s+as\s+/)[0]?.trim();
      if (imported) assert.ok(available.has(imported), `${path.relative(root,file)} imports non-exported ${imported} from ${path.relative(root,target)}`);
    }
  }
  for (const m of text.matchAll(/(?:import|export)\s+['"]([^'"]+)['"]/g)) {
    const target = resolveLocal(file, m[1]);
    if (target) assert.ok(fs.existsSync(target), `${path.relative(root,file)} references missing ${m[1]}`);
  }
}
console.log(`PASS local module graph — ${files.length} modules, ${checkedImports} relative imports checked`);
