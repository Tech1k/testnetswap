#!/usr/bin/env node
// Vendor-drift guard. Every hand-written module copied into testnetswap-site/vendor/ from an
// in-repo package MUST stay byte-identical to its canonical source. A silent drift once shipped
// a vendored swap-xmr/src/swap.js that had LOST the MAX_T_BLOCKS timelock cap (a fund-safety
// regression caught only by luck). This check makes any such drift fail loudly.
//
//   node testnetswap-site/tools/check-vendor.mjs   → exit 0 if clean, 1 if any file drifted.
//
// Only in-repo hand-written .js is checked; third-party bundles (*.mjs, monero-engine.*,
// the Rust->WASM pkg-web build) have no in-repo canonical and are skipped by design.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // repo root
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// vendored dir  ->  canonical source dir. recurse: mirror the whole src/ tree.
const RULES = [
  { vendor: 'testnetswap-site/vendor/swap-core/src', canon: 'swap-core/src', recurse: true },
  { vendor: 'testnetswap-site/vendor/swap-xmr/src',  canon: 'swap-xmr/src',  recurse: true },
  { vendor: 'testnetswap-site/vendor/swap-taker',    canon: 'swap-taker/src', recurse: false },
];

function jsFiles(dir, recurse) {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, e);
    if (statSync(join(ROOT, rel)).isDirectory()) { if (recurse) out.push(...jsFiles(rel, recurse)); }
    else if (e.endsWith('.js')) out.push(rel);
  }
  return out;
}

let drift = 0, checked = 0;
const skipped = [];
for (const rule of RULES) {
  for (const vf of jsFiles(rule.vendor, rule.recurse)) {
    const sub = relative(join(ROOT, rule.vendor), join(ROOT, vf)); // path within the vendor dir
    const canon = join(rule.canon, sub);
    if (!existsSync(join(ROOT, canon))) { skipped.push(`${vf}  (no canonical ${canon})`); continue; }
    checked++;
    if (sha(join(ROOT, vf)) !== sha(join(ROOT, canon))) { drift++; console.error(`DRIFT: ${vf}  !=  ${canon}`); }
  }
}

if (skipped.length) {
  console.log(`note: ${skipped.length} vendored file(s) have no in-repo canonical (site-local or third-party):`);
  for (const s of skipped) console.log(`  - ${s}`);
}
console.log(`checked ${checked} vendored file(s) against canonical sources.`);

// VENDOR.lock: a sha256 integrity manifest of EVERY vendored file, INCLUDING the third-party bundles
// that have no in-repo canonical (monero-engine.*, qrcode.mjs, the pkg-web WASM, the noble/btc-signer
// vendors). The drift check above proves the in-repo copies still match source; this proves the
// SHIPPED bytes match the recorded manifest, so a re-vendor that forgets to regenerate the lock fails
// loudly instead of silently drifting the published integrity list for the key-handling browser crypto.
const VENDOR = join(ROOT, 'testnetswap-site', 'vendor');
const LOCK = join(VENDOR, 'VENDOR.lock');
let lockBad = 0, lockChecked = 0;
if (existsSync(LOCK)) {
  for (const line of readFileSync(LOCK, 'utf8').split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (!m) continue;
    const p = join(VENDOR, m[2]);
    if (!existsSync(p)) { lockBad++; console.error(`LOCK MISSING: ${m[2]}`); continue; }
    lockChecked++;
    if (sha(p) !== m[1]) { lockBad++; console.error(`LOCK DRIFT: ${m[2]}`); }
  }
  console.log(`verified ${lockChecked} file(s) against VENDOR.lock.`);
} else {
  console.log('note: no VENDOR.lock present to verify.');
}

if (drift || lockBad) {
  if (drift) console.error(`\n✗ ${drift} vendored file(s) DRIFTED from source. Re-vendor them (cp canonical -> vendor) before deploying.`);
  if (lockBad) console.error(`\n✗ ${lockBad} file(s) mismatch VENDOR.lock. Regenerate it: (cd testnetswap-site/vendor && sha256sum $(awk '{print $2}' VENDOR.lock) > VENDOR.lock.new && mv VENDOR.lock.new VENDOR.lock)`);
  process.exit(1);
}
console.log('✓ no vendor drift; VENDOR.lock verified.');
