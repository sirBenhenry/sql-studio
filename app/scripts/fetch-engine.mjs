// Downloads MySQL Community Server (portable zip, win64), strips it to the
// minimum needed to run a local sandbox, and places it in
// src-tauri/resources/engine/. Run once per machine / engine upgrade:
//   node scripts/fetch-engine.mjs
// The binaries are NOT committed (size); CI/build machines run this script.
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const destDir = join(here, '..', 'src-tauri', 'resources', 'engine');

// pinned candidates, newest first — first one that downloads wins
// (dev.mysql.com/get redirects to the current CDN; archives host older builds)
const CANDIDATES = [
  'https://dev.mysql.com/get/Downloads/MySQL-8.4/mysql-8.4.10-winx64.zip',
  'https://dev.mysql.com/get/Downloads/MySQL-8.4/mysql-8.4.9-winx64.zip',
  'https://downloads.mysql.com/archives/get/p/23/file/mysql-8.4.6-winx64.zip'
];

if (existsSync(join(destDir, 'bin', 'mysqld.exe'))) {
  console.log('engine already present at', destDir, '— delete it to re-fetch');
  process.exit(0);
}

const work = join(tmpdir(), 'sqlstudio-engine-fetch');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const zipPath = join(work, 'mysql.zip');

let got = null;
for (const url of CANDIDATES) {
  console.log('trying', url);
  const r = spawnSync('curl.exe', ['-fL', '--retry', '3', '-o', zipPath, url], { stdio: 'inherit' });
  if (r.status === 0) { got = url; break; }
}
if (!got) { console.error('all download candidates failed'); process.exit(1); }
console.log('downloaded', got);

console.log('extracting (this takes a minute)…');
execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${work}\\x' -Force"`, { stdio: 'inherit' });

// the zip contains a single mysql-<ver>-winx64/ root
const root = join(work, 'x', readdirSync(join(work, 'x')).find(d => d.startsWith('mysql-')));

// strip: keep only what a local sandbox needs
mkdirSync(join(destDir, 'bin'), { recursive: true });
cpSync(join(root, 'bin', 'mysqld.exe'), join(destDir, 'bin', 'mysqld.exe'));
// runtime DLLs (OpenSSL etc.) — without these mysqld dies with 0xC0000135
for (const f of readdirSync(join(root, 'bin'))) {
  if (f.toLowerCase().endsWith('.dll')) cpSync(join(root, 'bin', f), join(destDir, 'bin', f));
}
// error messages + charsets are required at runtime
cpSync(join(root, 'share'), join(destDir, 'share'), {
  recursive: true,
  filter: src => {
    // drop non-english locale folders (each ~2 MB)
    const m = src.replace(/\\/g, '/').match(/\/share\/([a-z_]+)(\/|$)/);
    if (m && !['english', 'charsets'].includes(m[1]) && statSync(src).isDirectory()) return false;
    return true;
  }
});
// optional server components — silences 'Cannot load component' stderr noise
const pluginDir = join(root, 'lib', 'plugin');
if (existsSync(pluginDir)) {
  for (const f of ['component_reference_cache.dll']) {
    const src = join(pluginDir, f);
    if (existsSync(src)) {
      mkdirSync(join(destDir, 'lib', 'plugin'), { recursive: true });
      cpSync(src, join(destDir, 'lib', 'plugin', f));
    }
  }
}
cpSync(join(root, 'LICENSE'), join(destDir, 'LICENSE'));

rmSync(work, { recursive: true, force: true });

const size = (function du(p) {
  let s = 0;
  for (const f of readdirSync(p)) {
    const fp = join(p, f);
    const st = statSync(fp);
    s += st.isDirectory() ? du(fp) : st.size;
  }
  return s;
})(destDir);
console.log('engine ready at', destDir, '=', (size / 1024 / 1024).toFixed(1), 'MB');
