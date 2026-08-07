// SPDX-License-Identifier: AGPL-3.0-or-later
// Live testnet4 proof of the BTC-side adaptor mechanism for the XMR swap:
//   fund a 2-of-2 P2WSH -> spend it with one sig made via an ECDSA ADAPTOR
//   signature (encrypt under Y=s*G, decrypt with s) -> broadcast -> recover s
//   from the on-chain witness. This is exactly how publishing the BTC redeem
//   leaks the scalar that unlocks the Monero side. (Monero half proven separately
//   in the crypto crate; this proves the BTC integration on a real chain.)
import * as btc from '../../swap-core/vendor/btc-signer.mjs';
import * as sc from '../../swap-core/src/index.js';
import * as x from '../crypto/pkg-node/swap_xmr_crypto.js';

const NET = sc.BTC_TESTNET4;
const API = sc.COINS.tBTC.api;
const hex = (u) => Buffer.from(u).toString('hex');
const fromHex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand32 = () => { const b = new Uint8Array(32); crypto.getRandomValues(b); return b; };

async function get(p) { const r = await fetch(API + p); const t = await r.text(); if (!r.ok) throw new Error(`GET ${p}: ${r.status} ${t}`); try { return JSON.parse(t); } catch { return t; } }
async function broadcast(h) { const r = await fetch(API + '/tx', { method: 'POST', body: h }); const t = (await r.text()).trim(); if (!r.ok) throw new Error('broadcast: ' + t); return t; }

// --- minimal strict-DER <-> compact(64) for secp256k1 sigs ---
function toDER(compact) {
  const trim = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = Uint8Array.from([0, ...b]); return b; };
  const r = trim(compact.slice(0, 32)), s = trim(compact.slice(32, 64));
  const seq = Uint8Array.from([0x02, r.length, ...r, 0x02, s.length, ...s]);
  return Uint8Array.from([0x30, seq.length, ...seq]);
}
function fromDER(der) {
  const pad = (b) => { while (b.length > 32 && b[0] === 0) b = b.slice(1); const o = new Uint8Array(32); o.set(b, 32 - b.length); return o; };
  let i = 2; if (der[i] !== 0x02) throw new Error('der r'); const rl = der[i + 1]; const r = der.slice(i + 2, i + 2 + rl); i += 2 + rl;
  if (der[i] !== 0x02) throw new Error('der s'); const sl = der[i + 1]; const s = der.slice(i + 2, i + 2 + sl);
  return Uint8Array.from([...pad(r), ...pad(s)]);
}

const main = async () => {
  // funding key (p2wpkh), signed by @scure
  const fundKey = rand32();
  const fundPub = fromHex(x.secp_pubkey(hex(fundKey)));
  const fundAddr = btc.p2wpkh(fundPub, NET).address;
  console.log('fund addr', fundAddr);

  // 2-of-2 participants (Alice, Bob) + the adaptor secret s (real ed-derived path)
  const keyA = rand32(), keyB = rand32();
  const pubA = fromHex(x.secp_pubkey(hex(keyA)));
  const pubB = fromHex(x.secp_pubkey(hex(keyB)));
  const sEd = x.gen_secret_share();            // a Monero key share
  const sSecp = x.ed_to_secp_scalar(sEd);      // same scalar on secp256k1
  const Y = x.secp_pubkey(sSecp);              // adaptor encryption key = s*G
  console.log('adaptor encryption key Y =', Y.slice(0, 16) + '…');

  const ms = btc.p2ms(2, [pubA, pubB]);        // unsorted: sig order = [A, B]
  const wsh = btc.p2wsh(ms, NET);
  console.log('2-of-2 P2WSH addr', wsh.address);

  // claim + fund the 2-of-2
  console.log('claiming tBTC…');
  const cr = await fetch('https://cypherfaucet.com/api/v1/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ network: 'btc-testnet', address: fundAddr }) });
  console.log('faucet:', cr.status, (await cr.text()).slice(0, 120));
  let utxos = [];
  for (let i = 0; i < 40 && !utxos.length; i++) { await sleep(5000); try { utxos = await get(`/address/${fundAddr}/utxo`); } catch {} process.stdout.write('.'); }
  console.log('\nutxos', JSON.stringify(utxos));
  if (!utxos.length) throw new Error('no faucet utxo');
  const u = utxos.sort((a, b) => b.value - a.value)[0];

  const amount = 100000;
  const fund = sc.buildFundingTx({ utxos: [{ inp: { txid: u.txid, index: u.vout, sequence: 0xfffffffd, witnessUtxo: { script: btc.p2wpkh(fundPub, NET).script, amount: BigInt(u.value) } }, key: fundKey }], contractAddress: wsh.address, amount, changeAddress: fundAddr, feeRate: 2, network: NET });
  const fundTxid = await broadcast(fund.hex);
  console.log('funded 2-of-2:', fundTxid, 'vout', fund.vout);

  // build the redeem tx spending the 2-of-2
  await sleep(1500);
  const tx = new btc.Transaction({ allowUnknownOutputs: true, disableScriptCheck: true });
  tx.addInput({ txid: fromHex(fundTxid), index: fund.vout, sequence: 0xfffffffd, witnessUtxo: { amount: BigInt(amount), script: wsh.script }, witnessScript: ms.script });
  tx.addOutputAddress(fundAddr, BigInt(amount - 1000), NET);

  // BIP143 sighash for the 2-of-2 input
  const sighash = tx.preimageWitnessV0(0, ms.script, btc.SigHash.ALL, BigInt(amount));
  console.log('sighash len', sighash.length);
  const shHex = hex(sighash);

  // sig A = plain ECDSA; sig B = via ADAPTOR (encrypt under Y, decrypt with s)
  const sigA = fromHex(x.ecdsa_sign(hex(keyA), shHex));
  const encSig = x.adaptor_encrypt(hex(keyB), Y, shHex);
  console.log('adaptor verify:', x.adaptor_verify(hex(pubB), Y, shHex, encSig));
  const sigB = fromHex(x.adaptor_decrypt(sSecp, encSig));

  // witness: [OP_0 dummy, sigA||01, sigB||01, witnessScript]
  const wit = [new Uint8Array(0), Uint8Array.from([...toDER(sigA), 1]), Uint8Array.from([...toDER(sigB), 1]), ms.script];
  tx.updateInput(0, { finalScriptWitness: wit }, true);
  const redeemHex = tx.hex;
  const redeemTxid = await broadcast(redeemHex);
  console.log('REDEEM broadcast (adaptor-signed 2-of-2):', redeemTxid);

  // recover s from the on-chain witness
  await sleep(4000);
  const rtx = await get(`/tx/${redeemTxid}`);
  const onchainWit = rtx.vin[0].witness;        // array of hex
  const sigBderHex = onchainWit.find((w, i) => i === 2) || onchainWit[2];
  const sigBcompact = fromDER(fromHex(sigBderHex).slice(0, -1)); // strip sighash byte
  const recovered = x.adaptor_recover(Y, hex(sigBcompact), encSig);
  console.log('recovered s == original:', recovered === sSecp ? 'YES ✓' : `NO (${recovered.slice(0, 16)}…)`);
  console.log('explorer:', sc.COINS.tBTC.explorer + '/tx/' + redeemTxid);
  console.log('DONE');
};
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
