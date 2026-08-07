// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Web Crypto global polyfill for the Node entrypoint.
 *
 * swap-core's randomSecret() uses `globalThis.crypto.getRandomValues`, which is a
 * standard global in the browser and in Node >= 19, but NOT in Node 18 (where it
 * lives behind --experimental-global-webcrypto). On Node 18 the maker would crash
 * at startup with "crypto.getRandomValues unavailable".
 *
 * This module installs node:crypto's webcrypto as the global when it's missing. It
 * is imported FIRST by main.js so the global exists before any code path calls
 * randomSecret(). No-op on Node >= 19. This file is Node-only (the maker daemon);
 * the shared swap-core/crypto.js stays browser-safe and untouched.
 *
 * Note: Node 18 is EOL; prefer running the maker on Node 20+ LTS. This shim just
 * keeps it working if you haven't upgraded yet.
 */
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
  // defineProperty (not assignment) because in some Node versions globalThis.crypto
  // is a non-writable accessor; defineProperty replaces it cleanly.
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}
