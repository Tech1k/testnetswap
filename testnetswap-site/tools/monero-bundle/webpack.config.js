// SPDX-License-Identifier: AGPL-3.0-or-later
// Reproducible builder for the vendored Monero engine. Repackages the PINNED monero-ts npm artifact
// (its prebuilt wasm is embedded in monero-ts's own dist; nothing is compiled from C++/emscripten
// here) into the UMD global `moneroTs` that the no-build site loads via <script>.
//
// monero-ts's browser paths use a handful of Node built-ins (Buffer, crypto, stream, process, ...);
// NodePolyfillPlugin supplies the standard browser polyfills for them (this is the ~0.9 MB the bundle
// would otherwise be missing). Its genuinely Node-only paths (spawning monerod) are inert in-browser.
const path = require('path');
const webpack = require('webpack');
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin');

module.exports = {
  mode: 'production',
  target: 'web',
  entry: path.resolve(__dirname, 'entry.js'),
  output: {
    path: path.resolve(__dirname, 'out'),
    filename: 'monero-engine.bundle.js',
    library: { name: 'moneroTs', type: 'umd' },
    globalObject: 'self',
  },
  plugins: [
    new NodePolyfillPlugin(),
    // monero-ts's emscripten module references bare `process`/`Buffer` globals on paths that run in
    // the browser too; inject shims for them, or the bundle throws `process is not defined` at load
    // and never sets self.moneroTs. (A headless Node build check CANNOT catch this; Node has these
    // globals; so validate the output in a no-`process` context, e.g. tools/monero-bundle vm check.)
    new webpack.ProvidePlugin({ process: 'process/browser.js', Buffer: ['buffer', 'Buffer'] }),
  ],
  // child_process is Node-only (spawns monerod); there is no browser polyfill and it is never reached
  // in the browser, so resolve it to an empty module rather than erroring the build.
  resolve: { fallback: { child_process: false } },
  performance: { hints: false },
  optimization: { minimize: true, moduleIds: 'deterministic', chunkIds: 'deterministic' },
  stats: 'errors-warnings',
};
