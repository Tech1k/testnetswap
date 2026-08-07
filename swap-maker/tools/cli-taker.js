// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * cli-taker: a command-line TAKER that drives a full atomic swap against the
 * relay + maker, to prove the system end-to-end without the wallet UI.
 *
 *   node tools/cli-taker.js --relay ws://127.0.0.1:8910/ --from tLTC --to tBTC --amount 0.005
 *
 * It funds itself from CypherFaucet on the send chain, negotiates over the relay,
 * verifies the maker's contract on-chain, then redeems it (revealing the secret).
 * The maker then extracts the secret and claims the taker's contract.
 */
import { WebSocket } from 'ws';
import * as sc from '@testnetswap/swap-core';
import { Chain } from '../src/chain.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => {
  if (x.startsWith('--')) a.push([x.slice(2), arr[i + 1]]); return a;
}, []));
const RELAY = args.relay || 'ws://127.0.0.1:8910/';
const FROM = args.from || 'tLTC';
const TO = args.to || 'tBTC';
const AMOUNT_SATS = Math.round(Number(args.amount || '0.005') * 1e8);
const FAUCET = args.faucet || 'https://cypherfaucet.com';
const MIN_CONF = Number(args['min-conf'] ?? 1); // wait this many confs on the maker's contract before redeeming (0 only for fast local regtest)
const FAUCET_SLUGS = { tBTC: 'btc-testnet', tLTC: 'ltc-testnet' };

const hx = sc.bytesToHex;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// tBTC uses independent mempool.space (a taker should not depend on the operator's explorer);
// tLTC uses testnetscan.com only because Litecoin testnet has no reliable independent Esplora
// (litecoinspace is stalled). Accepted testnet tradeoff; see swap.js for the rationale.
const apis = { tBTC: ['https://mempool.space/testnet4/api'], tLTC: ['https://testnetscan.com/ltc-testnet/api'] };
const chains = { tBTC: new Chain(apis.tBTC), tLTC: new Chain(apis.tLTC) };

// taker keys
const secret = sc.randomSecret();
const secretHash = sc.secretHashOf(secret);
const fundPriv = sc.randomSecret();                 // funds the taker's contract (send chain)
const fundPub = sc.getPublicKey(fundPriv);
const recvPriv = sc.randomSecret();                 // claims the maker's contract (receive chain)
const recvPub = sc.getPublicKey(recvPriv);
const refundPriv = sc.randomSecret();               // refunds the taker's contract (send chain)
const refundPub = sc.getPublicKey(refundPriv);

const sendNet = sc.getCoin(FROM).network;
const recvNet = sc.getCoin(TO).network;
const fundAddr = sc.btc.p2wpkh(fundPub, sendNet).address;
const fundScript = sc.btc.p2wpkh(fundPub, sendNet).script;
const recvAddr = sc.btc.p2wpkh(recvPub, recvNet).address;

async function faucetClaim(coin, address) {
  const r = await fetch(FAUCET + '/api/v1/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ network: FAUCET_SLUGS[coin], address }) });
  return { status: r.status, body: await r.text() };
}
async function waitForUtxo(coin, address, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const u = await chains[coin].getUtxos(address); if (u.length) return u.sort((a, b) => b.value - a.value)[0]; } catch {}
    process.stdout.write('.'); await sleep(5000);
  }
  return null;
}
async function waitForOutput(coin, txid, vout, minConf, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const o = await chains[coin].getOutput(txid, vout);
    if (o && o.confirmations >= minConf) return o;
    process.stdout.write('.'); await sleep(5000);
  }
  return null;
}

function rpc(ws, want) {
  return new Promise((resolve, reject) => {
    const onMsg = (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === '_relay_hello' || m.type === '_pong') return;
      if (m.type === 'error' || m.type === 'abort') { ws.off('message', onMsg); return reject(new Error(`${m.type}: ${m.reason}`)); }
      if (!want || m.type === want) { ws.off('message', onMsg); resolve(m); }
    };
    ws.on('message', onMsg);
  });
}

(async () => {
  log(`TAKER: ${AMOUNT_SATS} sats ${FROM} -> ${TO}`);
  log('fund addr', fundAddr, '| receive addr', recvAddr);

  // 1) fund the taker on the send chain
  log(`claiming ${FROM} from faucet...`);
  const claim = await faucetClaim(FROM, fundAddr);
  log('faucet:', claim.status, claim.body.slice(0, 160));
  if (claim.status !== 200) throw new Error('faucet claim failed');
  const utxo = await waitForUtxo(FROM, fundAddr);
  if (!utxo) throw new Error('no faucet utxo appeared');
  log('\nfunding utxo', utxo.txid + ':' + utxo.vout, utxo.value, 'sats');
  if (utxo.value < AMOUNT_SATS + 1000) throw new Error('faucet utxo too small for swap amount');

  // 2) connect to relay (attach the hello listener before awaiting open so we can't miss it)
  const ws = new WebSocket(`${RELAY}?role=taker`);
  const helloP = new Promise((resolve) => {
    const h = (d) => { let m; try { m = JSON.parse(d.toString()); } catch { return; } if (m.type === '_relay_hello') { ws.off('message', h); resolve(m); } };
    ws.on('message', h);
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const hello = await helloP;
  log('relay sid', hello.sid, '| maker online:', hello.maker_online);
  if (!hello.maker_online) throw new Error('maker is offline at the relay');

  // 3) request a quote
  ws.send(JSON.stringify(sc.buildMessage.requestQuote({ from: FROM, to: TO, sendSats: AMOUNT_SATS })));
  const quote = await rpc(ws, 'quote');
  log('quote: receive', quote.recv_sats, 'sats', TO, '@', quote.rate, '| t1/t2 hours', quote.t1_hours + '/' + quote.t2_hours);

  // 4) initiate
  ws.send(JSON.stringify(sc.buildMessage.initiate({ quoteId: quote.quote_id, from: FROM, to: TO, sendSats: AMOUNT_SATS, secretHash: hx(secretHash), takerRecvPubkey: hx(recvPub), takerRefundPubkey: hx(refundPub) })));
  const accept = await rpc(ws, 'accept');
  log('accept: recv', accept.recv_sats, '| t1', accept.t1, 't2', accept.t2);

  // verify accept against the quote + timelock safety
  const chk = sc.checkAcceptAgainstQuote(quote, accept, now());
  if (!chk.ok) throw new Error('accept check failed: ' + chk.reason);

  // 5) build + fund the taker's contract on the send chain (pays the maker, locktime T1)
  const takerC = sc.takerContractParams({ secretHash, makerRecvPubkey: sc.hexToBytes(accept.maker_recv_pubkey), takerRefundPubkey: refundPub, t1: accept.t1, sendCoin: FROM });
  log('taker contract', takerC.address);
  const funding = sc.buildFundingTx({ utxos: [{ inp: { txid: utxo.txid, index: utxo.vout, sequence: 0xfffffffd, witnessUtxo: { script: fundScript, amount: BigInt(utxo.value) } }, key: fundPriv }], contractAddress: takerC.address, amount: AMOUNT_SATS, changeAddress: fundAddr, feeRate: 2, network: sendNet });
  const fundTxid = await chains[FROM].broadcast(funding.hex);
  log('broadcast taker funding', fundTxid);
  ws.send(JSON.stringify(sc.buildMessage.takerLocked({ quoteId: quote.quote_id, contractAddr: takerC.address, fundTxid, vout: funding.vout, t1: accept.t1 })));

  // 6) wait for the maker to lock
  log('waiting for maker to lock...');
  const makerLocked = await rpc(ws, 'maker_locked');
  log('maker locked', makerLocked.fund_txid + ':' + makerLocked.vout);

  // 7) verify the maker's contract pays us + is funded on-chain
  const makerC = sc.makerContractParams({ secretHash, takerRecvPubkey: recvPub, makerRefundPubkey: sc.hexToBytes(accept.maker_refund_pubkey), t2: accept.t2, recvCoin: TO });
  const vm = sc.verifyMakerContract({ witnessScript: makerC.witnessScript, fundedAddress: makerLocked.contract_addr, secretHash, takerRecvPubkey: recvPub, makerRefundPubkey: sc.hexToBytes(accept.maker_refund_pubkey), t1: accept.t1, t2: accept.t2, nowSec: now(), recvCoin: TO });
  if (!vm.ok) throw new Error('maker contract verify failed: ' + vm.reason);
  log('verifying maker funded output (min conf ' + MIN_CONF + ')...');
  const mout = await waitForOutput(TO, makerLocked.fund_txid, makerLocked.vout, MIN_CONF);
  if (!mout) throw new Error('maker funded output not found/confirmed');
  const vf = sc.verifyFundedOutput({ witnessScript: makerC.witnessScript, fundedScriptPubKey: mout.scriptpubkey, fundedValueSats: mout.value, expectedSats: accept.recv_sats, network: recvNet });
  if (!vf.ok) throw new Error('maker funded output check failed: ' + vf.reason);
  log('\nmaker contract verified: pays us', mout.value, 'sats', TO);

  // 8) redeem the maker's contract, revealing the secret
  const redeem = sc.buildRedeemTx({ contract: makerC, utxo: { txid: makerLocked.fund_txid, vout: makerLocked.vout, amount: mout.value }, secret, privkey: recvPriv, destAddress: recvAddr, feeRate: 2, network: recvNet });
  const redeemTxid = await chains[TO].broadcast(redeem.hex);
  log('REDEEMED maker contract:', redeemTxid);
  log(`\n✓ SWAP COMPLETE (taker side). Received ~${redeem.outAmount} sats ${TO} at ${recvAddr}`);
  log(`  ${sc.getCoin(TO).explorer}/tx/${redeemTxid}`);
  log('  the maker will now extract the secret and claim the taker contract.');
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('TAKER ERROR:', e.message); process.exit(1); });
