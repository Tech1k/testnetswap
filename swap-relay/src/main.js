// SPDX-License-Identifier: AGPL-3.0-or-later
/* swap-relay entry point. Usage: node src/main.js -c config.json */
import { readFileSync } from 'node:fs';
import { startRelay } from './relay.js';

function parseArgs(argv) {
  const out = { config: 'config.json' };
  for (let i = 2; i < argv.length; i++) {
    if ((argv[i] === '-c' || argv[i] === '--config') && argv[i + 1]) out.config = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);
let cfg = {};
try { cfg = JSON.parse(readFileSync(args.config, 'utf8')); }
catch (e) { console.error(`relay: cannot read config ${args.config}: ${e.message}`); process.exit(1); }

// Allow the maker token to come from the environment (keeps it out of the file).
if (process.env.RELAY_MAKER_TOKEN) cfg.makerToken = process.env.RELAY_MAKER_TOKEN;

const ts = () => new Date().toISOString();
const log = {
  info: (...a) => console.log(ts(), '[relay]', ...a),
  warn: (...a) => console.warn(ts(), '[relay]', ...a),
  error: (...a) => console.error(ts(), '[relay]', ...a),
};

let relay;
try { relay = startRelay(cfg, { log }); }
catch (e) { log.error(e.message); process.exit(1); }

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log.info('shutting down'); relay.stop(); process.exit(0); });
}
