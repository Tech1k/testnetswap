// SPDX-License-Identifier: AGPL-3.0-or-later
// Bundle entry: re-export the full monero-ts API so webpack emits a single UMD file that sets the
// global `self.moneroTs` for the no-build site (loaded via <script> in monero-engine.mjs). The wasm
// is already embedded inside monero-ts's published dist (no emscripten/C++ compile happens here); this
// step only repackages that pinned npm artifact into a browser-loadable global.
module.exports = require('monero-ts');
