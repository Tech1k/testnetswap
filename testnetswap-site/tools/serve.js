#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/* Dev server for testnetswap-site: serves the static files and proxies /api/* to
 * the maker's status API. In production the static site is hosted (e.g. Cloudflare
 * Pages) and /api/* is reverse-proxied to the maker the same way; this mirrors
 * that locally. Node stdlib only, no deps.
 *
 *   node tools/serve.js            # serves ./ on :8080, proxies /api -> 127.0.0.1:8911
 *   PORT=3000 API_TARGET=http://127.0.0.1:8911 node tools/serve.js
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8080);
const API_TARGET = (process.env.API_TARGET || 'http://127.0.0.1:8911').replace(/\/$/, '');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Proxy /api/* to the maker
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    const target = API_TARGET + url.pathname + url.search;
    try {
      const r = await fetch(target, { method: req.method, headers: { accept: 'application/json' } });
      const body = await r.text();
      res.writeHead(r.status, {
        'content-type': r.headers.get('content-type') || 'application/json',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'maker unreachable: ' + e.message }));
    }
    return;
  }

  // Static files
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = normalize(join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const data = await readFile(filePath);
    // Baseline security headers so a non-Cloudflare serve (this dev server, an Apache mirror) still
    // gets clickjacking/sniff/referrer protection. Per-page <meta> CSP supplies script-src; production
    // should also emit a full CSP with connect-src for its own hosts via the reverse proxy.
    res.writeHead(200, {
      'content-type': TYPES[extname(filePath)] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1>');
  }
});

server.listen(PORT, () => {
  console.log(`testnetswap-site dev server: http://127.0.0.1:${PORT}  (/api -> ${API_TARGET})`);
});
