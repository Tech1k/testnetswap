// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser-faithful load check for the freshly-built bundle. A plain Node smoke test CANNOT catch a
// missing `process`/`Buffer` shim; Node provides those globals, so a broken bundle passes there yet
// throws `ReferenceError: process is not defined` in a real browser (this exact bug shipped once).
// A vm context has NO `process`, so running the bundle in one reproduces the browser's globals. This
// is a load/interface check only; ALWAYS also run a real tXMR->tBTC swap in a browser before shipping.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(dir, 'out', 'monero-engine.bundle.js');
const code = fs.readFileSync(file, 'utf8');

const sandbox = { console };
sandbox.self = sandbox;
sandbox.window = sandbox; // browser globals present, but deliberately NO `process` / Node globals
vm.createContext(sandbox);
try {
  vm.runInContext(code, sandbox, { filename: 'monero-engine.bundle.js' });
  const m = sandbox.moneroTs || sandbox.self.moneroTs;
  if (!m || typeof m.createWalletFull !== 'function' || !m.LibraryUtils) {
    console.error('FAIL: bundle ran but moneroTs global / API is missing');
    process.exit(1);
  }
  console.log('OK: bundle loads in a no-process (browser-like) context and exposes the moneroTs API');
} catch (e) {
  console.error('FAIL: ' + (e && e.message) + '  (a real browser would throw the same)');
  process.exit(1);
}
