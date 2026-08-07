// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Maker relay identity: a stable ed25519 keypair derived from the maker seed (label
 * 'relay-identity', domain-separated from the funding/HTLC keys). maker_id = hex(pubkey);
 * the maker proves ownership by signing the relay's challenge. Uses node:crypto only.
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';

const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex'); // ed25519 PKCS8 prefix + 32-byte seed
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');         // ed25519 SPKI prefix + 32-byte pubkey

/** @param {Uint8Array|Buffer} seed  the maker's HD seed. @returns {{ id:string, sign:(str:string)=>string }} */
export function makerIdentity(seed) {
  if (!seed || seed.length < 16) throw new Error('makerIdentity: seed required');
  // domain-separate from HTLC/funding key derivation so the identity key is never a signing
  // oracle over those keys and vice-versa.
  const idSeed = createHash('sha256').update(Buffer.from(seed)).update('relay-identity').digest();
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8, idSeed]), format: 'der', type: 'pkcs8' });
  const der = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  const id = Buffer.from(der.subarray(der.length - 32)).toString('hex');
  return { id, sign: (str) => edSign(null, Buffer.from(str), priv).toString('hex') };
}
