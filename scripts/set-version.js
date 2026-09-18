// node scripts/set-version.js 1.0.1 → writes the version into extension/manifest.json, extension/store.js (VERSION),
// every ?v=… import in extension/*.html|*.js and touch-server/package.json. Without an argument it re-applies the
// manifest's version. There is no build step — this is the only place a version is typed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'extension/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const v = process.argv[2] || manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(v)) { console.error('usage: node scripts/set-version.js <major.minor.patch>'); process.exit(1); }

manifest.version = v;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const ext = path.join(root, 'extension');
for (const f of fs.readdirSync(ext)) {
  if (!/\.(html|js)$/.test(f)) continue;
  const p = path.join(ext, f);
  let s = fs.readFileSync(p, 'utf8').replace(/\?v=[\d.]+/g, '?v=' + v);
  if (f === 'store.js') s = s.replace(/export const VERSION = '[^']*'/, `export const VERSION = '${v}'`);
  fs.writeFileSync(p, s);
}
for (const rel of ['package.json', 'touch-server/package.json']) {
  const p = path.join(root, rel);
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
  pkg.version = v;
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
}
// the lock file carries the version twice — without this the next `npm install` leaves the release dirty
const lockPath = path.join(root, 'touch-server/package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = v;
  if (lock.packages && lock.packages['']) lock.packages[''].version = v;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}
console.log('version', v);
