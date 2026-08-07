# monero-bundle: reproducible builder for the vendored Monero engine

The site loads Monero support from two vendored files:

- `testnetswap-site/vendor/monero-engine.bundle.js`: the monero-ts API as a `<script>`-loadable UMD global (`self.moneroTs`).
- `testnetswap-site/vendor/monero.worker.js`: monero-ts's web worker (scanning + signing run here in WASM).

This tool regenerates both from a **pinned** `monero-ts` npm release. It does **not** compile Monero C++ / emscripten: the prebuilt wasm ships *inside* the monero-ts npm package, anchored by the `integrity` hash in the lockfiles. This step only repackages that artifact into a browser global, and copies monero-ts's dist worker **verbatim**.

## Rebuild + re-vendor

```sh
cd testnetswap-site/tools/monero-bundle
npm ci                 # exact webpack + monero-ts@0.11.10 from package-lock.json
npm run build          # -> out/  (does NOT touch vendor/, so you can diff first)
npm run verify         # loads the bundle in a no-`process` vm (browser-faithful); MUST pass
npm run vendor         # build + verify, then copy both files into ../../vendor/
# then regenerate the manifest:
cd ../../vendor && sha256sum $(awk '{print $2}' VENDOR.lock) > VENDOR.lock.new && mv VENDOR.lock.new VENDOR.lock
node ../tools/check-vendor.mjs        # expect: no vendor drift; VENDOR.lock verified
```

> ⚠️ **Always run a real browser tXMR→tBTC swap before shipping a rebuilt bundle.** A headless Node
> build/smoke test CANNOT catch browser-only breakage: Node provides `process`/`Buffer` globals, so a
> bundle missing their shim passes in Node yet throws `ReferenceError: process is not defined` in a
> browser (this exact bug shipped once). `npm run verify` runs the bundle in a `vm` context with no
> `process` to catch that class of error, but it only checks load + the API surface, not a full swap.
> The webpack config injects the `process`/`Buffer` shims via `ProvidePlugin`; do not remove them.

## What is and isn't reproducible

- **Reproducible here:** the worker is byte-for-byte monero-ts's `dist/monero.worker.js` (verify: `sha256sum out/monero.worker.js node_modules/monero-ts/dist/monero.worker.js` match). The bundle is a deterministic webpack pack of `monero-ts@0.11.10` + `node-polyfill-webpack-plugin`; rebuilding on the pinned toolchain reproduces it (minor cross-machine webpack nondeterminism is possible; diff and explain any delta).
- **Not reproduced here:** monero-ts's wasm compiled from Monero C++ source. Emscripten builds are not bit-deterministic and that is upstream's (monero-ts / the Monero project's) domain. Trusting `monero-ts@0.11.10` from npm is the same trust you extend to any native/wasm dependency.

## Bumping monero-ts

Change the exact version in `package.json` (keep it pinned, no `^`), `npm install` to refresh `package-lock.json`, `npm run vendor`, regen `VENDOR.lock`, then **re-run a full tXMR→tBTC swap** before shipping; the bundle is the in-browser signing path.
