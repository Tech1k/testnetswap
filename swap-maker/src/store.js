// SPDX-License-Identifier: AGPL-3.0-or-later
/* swap-maker/store: crash-safe JSON persistence of swaps (atomic write+rename). */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';

export class FileStore {
  constructor(stateDir, filename = 'swaps.json') {
    this.dir = stateDir;
    this.file = join(stateDir, filename);
    // 0700 dir: state can hold in-flight XMR key material (xmr-swaps.json), so keep it
    // owner-only rather than the default world-readable 0755.
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }

  load() {
    if (!existsSync(this.file)) return []; // genuine first boot
    try { return JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (e) {
      // L10: corrupt/truncated state (NOT first boot); do NOT silently return [] and let
      // the next save() overwrite it, which would drop in-flight swaps' refund keys.
      // Preserve the file and fail loudly so the operator intervenes.
      try { renameSync(this.file, this.file + '.corrupt.' + Date.now()); } catch {}
      throw new Error(`state file ${this.file} is corrupt (preserved as .corrupt.*): ${e.message || e}`);
    }
  }

  save(swaps) {
    const tmp = this.file + '.tmp';
    // 0600: state may hold hot XMR key shares; never world-readable.
    writeFileSync(tmp, JSON.stringify(swaps, null, 2), { mode: 0o600 });
    // fsync the bytes to disk before the (atomic) rename, then fsync the dir, so a power-loss
    // right after rename can't leave stale/zero-length state on some filesystems.
    try { const fd = openSync(tmp, 'r'); fsyncSync(fd); closeSync(fd); } catch { /* best-effort durability */ }
    renameSync(tmp, this.file);
    try { const dfd = openSync(this.dir, 'r'); fsyncSync(dfd); closeSync(dfd); } catch { /* best-effort */ }
  }
}
