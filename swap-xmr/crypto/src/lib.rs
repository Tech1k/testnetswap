// SPDX-License-Identifier: AGPL-3.0-or-later
//! swap-xmr-crypto: the cross-curve crypto core for TestnetSwap's BTC/LTC <-> XMR
//! atomic swaps (the Gugger construction). Production secp256kfun crates only,
//! never hand-rolled: cross-curve secp256k1<->ed25519 DLEQ (sigma_fun) + ECDSA
//! adaptor signatures (ecdsa_fun).
//!
//! Atomic link: one 252-bit scalar `s` is the discrete log of BOTH a secp256k1
//! point (the adaptor encryption key on the BTC/LTC side) and an ed25519 point
//! (a Monero public spend-key share). Publishing the decrypted adaptor signature
//! on BTC/LTC leaks `s`, which reconstructs the Monero spend key.
//!
//! `api` holds JS-callable, hex-in/hex-out functions (native-testable); the wasm
//! module re-exports them through wasm-bindgen for the browser taker + Node maker.

use curve25519_dalek_ng::constants::ED25519_BASEPOINT_TABLE;
use curve25519_dalek_ng::edwards::{CompressedEdwardsY, EdwardsPoint};
use curve25519_dalek_ng::scalar::Scalar as EdScalar;
use curve25519_dalek_ng::traits::Identity;
use ecdsa_fun::adaptor::{Adaptor, EncryptedSignature, HashTranscript as AdaptorTranscript};
use ecdsa_fun::fun::{g, Point as SecpPoint, Scalar as SecpScalar, G};
use ecdsa_fun::nonce::Deterministic;
use ecdsa_fun::{Signature, ECDSA};
use rand::rngs::OsRng;
use rand::{RngCore, SeedableRng};
use rand_chacha::ChaCha20Rng;
use sha2::{Digest, Sha256};
use sigma_fun::ext::dl_secp256k1_ed25519_eq::{CrossCurveDLEQ, CrossCurveDLEQProof};
use sigma_fun::HashTranscript;

type DleqTranscript = HashTranscript<Sha256, ChaCha20Rng>;
type AdaptorT = Adaptor<AdaptorTranscript<Sha256, ChaCha20Rng>, Deterministic<Sha256>>;

fn cfg() -> bincode::config::Configuration {
    bincode::config::standard()
}

/// Deterministic hash-to-curve NUMS point on secp256k1 with NO known discrete log:
/// try-and-increment over SHA-256(domain || counter) as a compressed x-coordinate.
fn nums_secp(domain: &[u8]) -> SecpPoint {
    let mut ctr: u32 = 0;
    loop {
        let mut hasher = Sha256::new();
        Digest::update(&mut hasher, domain);
        Digest::update(&mut hasher, ctr.to_le_bytes());
        let d = hasher.finalize();
        let mut comp = [0u8; 33];
        comp[0] = 0x02; // even-y compressed prefix
        comp[1..].copy_from_slice(&d);
        if let Some(p) = SecpPoint::from_bytes(comp) {
            return p;
        }
        ctr = ctr.wrapping_add(1);
    }
}

/// Deterministic hash-to-curve NUMS point on ed25519 with NO known discrete log:
/// try-and-increment SHA-256(domain || counter) as a compressed Y, then clear the
/// cofactor so the result is a torsion-free prime-order point.
fn nums_ed(domain: &[u8]) -> EdwardsPoint {
    let mut ctr: u32 = 0;
    loop {
        let mut hasher = Sha256::new();
        Digest::update(&mut hasher, domain);
        Digest::update(&mut hasher, ctr.to_le_bytes());
        let d = hasher.finalize();
        let mut y = [0u8; 32];
        y.copy_from_slice(&d);
        if let Some(p) = CompressedEdwardsY(y).decompress() {
            let p = p.mul_by_cofactor(); // clear torsion -> prime-order subgroup
            if p != EdwardsPoint::identity() {
                return p;
            }
        }
        ctr = ctr.wrapping_add(1);
    }
}

/// Fixed public NUMS Pedersen generators with NO known discrete log on either
/// curve, derived deterministically by hash-to-curve so both parties derive
/// identical DLEQ parameters. Genuine NUMS points (not scalar*G, whose DL would
/// be recomputable) are required for the binding/soundness of the cross-curve
/// equality proof that the swap's atomicity rests on.
fn dleq_system() -> CrossCurveDLEQ<DleqTranscript> {
    let h_p = nums_secp(b"TestnetSwap/DLEQ/secp256k1/H_p/v1");
    let h_q = nums_ed(b"TestnetSwap/DLEQ/ed25519/H_q/v1");
    CrossCurveDLEQ::new(h_p, h_q)
}

fn adaptor() -> AdaptorT {
    Adaptor::default()
}

// ---------- byte helpers ----------
fn h2b(s: &str) -> Result<Vec<u8>, String> {
    hex::decode(s.trim()).map_err(|e| format!("bad hex: {e}"))
}
fn arr32(v: &[u8]) -> Result<[u8; 32], String> {
    v.try_into().map_err(|_| "expected 32 bytes".to_string())
}
fn arr33(v: &[u8]) -> Result<[u8; 33], String> {
    v.try_into().map_err(|_| "expected 33 bytes".to_string())
}
fn arr64(v: &[u8]) -> Result<[u8; 64], String> {
    v.try_into().map_err(|_| "expected 64 bytes".to_string())
}

fn secp_scalar(hex: &str) -> Result<SecpScalar, String> {
    SecpScalar::from_bytes(arr32(&h2b(hex)?)?)
        .ok_or("not a valid secp scalar")?
        .non_zero()
        .ok_or("secp scalar is zero".into())
}
fn secp_point(hex: &str) -> Result<SecpPoint, String> {
    SecpPoint::from_bytes(arr33(&h2b(hex)?)?).ok_or("not a valid secp point".into())
}
fn ed_scalar_le(hex: &str) -> Result<EdScalar, String> {
    Ok(EdScalar::from_bytes_mod_order(arr32(&h2b(hex)?)?))
}
fn ed_point(hex: &str) -> Result<curve25519_dalek_ng::edwards::EdwardsPoint, String> {
    CompressedEdwardsY(arr32(&h2b(hex)?)?)
        .decompress()
        .ok_or("not a valid ed25519 point".into())
}

// ---------- the JS-callable API (hex in / hex or JSON out) ----------
pub mod api {
    use super::*;

    /// A fresh 252-bit ed25519 scalar (the secret key share), as 32 LE hex bytes.
    /// Masking the top 4 bits yields a value uniform over [0, 2^252) (the DLEQ
    /// requirement). Uses `try_fill_bytes` so an OS-RNG failure returns an error
    /// instead of panicking (the WASM never-panic contract).
    pub fn gen_secret_share() -> Result<String, String> {
        let mut b = [0u8; 32];
        OsRng
            .try_fill_bytes(&mut b)
            .map_err(|e| format!("OS RNG failure: {e}"))?;
        b[31] &= 0x0f; // clear top 4 bits => value < 2^252 (DLEQ requirement)
        if b == [0u8; 32] {
            return Err("RNG produced a zero scalar".into()); // astronomically unlikely; reject
        }
        Ok(hex::encode(b))
    }

    /// Convert an ed25519 scalar (LE hex) to the equivalent secp256k1 scalar (BE hex).
    pub fn ed_to_secp_scalar(ed_le_hex: &str) -> Result<String, String> {
        let mut be = arr32(&h2b(ed_le_hex)?)?;
        be.reverse();
        let s: SecpScalar = SecpScalar::from_bytes(be).ok_or("invalid")?.non_zero().ok_or("zero")?;
        Ok(hex::encode(s.to_bytes()))
    }

    /// secp256k1 public point for a scalar (BE hex) -> 33-byte compressed hex.
    pub fn secp_pubkey(scalar_be_hex: &str) -> Result<String, String> {
        let s = secp_scalar(scalar_be_hex)?;
        Ok(hex::encode(g!(s * G).normalize().to_bytes()))
    }

    /// ed25519 public point for a scalar (LE hex) -> 32-byte compressed hex.
    pub fn ed_pubkey(scalar_le_hex: &str) -> Result<String, String> {
        let s = ed_scalar_le(scalar_le_hex)?;
        Ok(hex::encode((&s * &ED25519_BASEPOINT_TABLE).compress().to_bytes()))
    }

    /// Add two ed25519 scalars (LE hex) mod l -> LE hex. (Monero spend key = s_a + s_b.)
    pub fn ed_scalar_add(a_le: &str, b_le: &str) -> Result<String, String> {
        let r = ed_scalar_le(a_le)? + ed_scalar_le(b_le)?;
        Ok(hex::encode(r.to_bytes()))
    }

    /// Add two ed25519 points (compressed hex) -> compressed hex. (Public spend key.)
    pub fn ed_point_add(a: &str, b: &str) -> Result<String, String> {
        let r = ed_point(a)? + ed_point(b)?;
        Ok(hex::encode(r.compress().to_bytes()))
    }

    /// Prove DLEQ for a secret share (ed LE hex). Returns JSON
    /// {"proof":hex,"secp":hex(33),"ed":hex(32)}: secp point is the adaptor
    /// encryption key, ed point is the Monero public spend-key share.
    pub fn dleq_prove(secret_le_hex: &str) -> Result<String, String> {
        // The DLEQ requires the secret < 2^252 (sigma_fun asserts bit 252 is clear
        // and would otherwise PANIC/abort the module). Validate the caller-supplied
        // scalar here and return a clean error instead. Zero is also rejected.
        let raw = arr32(&h2b(secret_le_hex)?)?;
        if raw[31] & 0xf0 != 0 {
            return Err("dleq secret must be < 2^252 (top 4 bits must be clear)".into());
        }
        if raw == [0u8; 32] {
            return Err("dleq secret is zero".into());
        }
        let s_ed = ed_scalar_le(secret_le_hex)?;
        let dleq = dleq_system();
        // L1: don't pass raw OsRng into sigma_fun (its Scalar::random calls the PANICKING
        // fill_bytes). Seed an infallible ChaCha20 PRNG from a checked OsRng draw instead, so
        // an OS-RNG failure returns Err rather than aborting the WASM module.
        let mut seed = [0u8; 32];
        OsRng
            .try_fill_bytes(&mut seed)
            .map_err(|e| format!("OS RNG failure: {e}"))?;
        let mut rng = ChaCha20Rng::from_seed(seed);
        let (proof, (s_secp_point, s_ed_point)): (CrossCurveDLEQProof, _) =
            dleq.prove(&s_ed, &mut rng);
        let proof_hex = hex::encode(
            bincode::encode_to_vec(bincode::serde::Compat(&proof), cfg()).map_err(|e| e.to_string())?,
        );
        Ok(format!(
            "{{\"proof\":\"{}\",\"secp\":\"{}\",\"ed\":\"{}\"}}",
            proof_hex,
            hex::encode(s_secp_point.to_bytes()),
            hex::encode(s_ed_point.compress().to_bytes()),
        ))
    }

    /// Verify a DLEQ proof binds the secp point and ed point to one scalar.
    pub fn dleq_verify(proof_hex: &str, secp_hex: &str, ed_hex: &str) -> Result<bool, String> {
        let bytes = h2b(proof_hex)?;
        let proof: CrossCurveDLEQProof =
            bincode::decode_from_slice::<bincode::serde::Compat<CrossCurveDLEQProof>, _>(&bytes, cfg())
                .map_err(|e| e.to_string())?
                .0
                 .0;
        let p = secp_point(secp_hex)?.non_zero().ok_or("zero secp point")?;
        let q = ed_point(ed_hex)?;
        Ok(dleq_system().verify(&proof, (p, q)))
    }

    /// ECDSA adaptor "encrypted" signature: signing_key (BE hex) signs msg (32 hex)
    /// encrypted under encryption_point (33 hex). Returns enc-sig hex.
    pub fn adaptor_encrypt(signing_key_be: &str, enc_point_hex: &str, msg32_hex: &str) -> Result<String, String> {
        let sk = secp_scalar(signing_key_be)?;
        let y = secp_point(enc_point_hex)?.non_zero().ok_or("zero enc point")?;
        let msg = arr32(&h2b(msg32_hex)?)?;
        let es = adaptor().encrypted_sign(&sk, &y, &msg);
        Ok(hex::encode(
            bincode::encode_to_vec(bincode::serde::Compat(&es), cfg()).map_err(|e| e.to_string())?,
        ))
    }

    /// Verify an encrypted signature against the signer's pubkey (33 hex).
    pub fn adaptor_verify(verify_point_hex: &str, enc_point_hex: &str, msg32_hex: &str, enc_sig_hex: &str) -> Result<bool, String> {
        let vk = secp_point(verify_point_hex)?;
        let y = secp_point(enc_point_hex)?.non_zero().ok_or("zero enc point")?;
        let msg = arr32(&h2b(msg32_hex)?)?;
        let es = decode_encsig(enc_sig_hex)?;
        Ok(adaptor().verify_encrypted_signature(&vk, &y, &msg, &es))
    }

    /// Decrypt the encrypted signature with the decryption scalar (BE hex) ->
    /// 64-byte compact ECDSA signature hex (broadcastable in a witness).
    pub fn adaptor_decrypt(decryption_be: &str, enc_sig_hex: &str) -> Result<String, String> {
        let y = secp_scalar(decryption_be)?;
        let es = decode_encsig(enc_sig_hex)?;
        let sig = adaptor().decrypt_signature(&y, es);
        Ok(hex::encode(sig.to_bytes()))
    }

    /// Recover the decryption scalar from the published signature (64 hex) and the
    /// encrypted signature. Returns BE hex, or "" if it can't (wrong inputs).
    pub fn adaptor_recover(enc_point_hex: &str, sig64_hex: &str, enc_sig_hex: &str) -> Result<String, String> {
        let y = secp_point(enc_point_hex)?.non_zero().ok_or("zero enc point")?;
        let sig = Signature::from_bytes(arr64(&h2b(sig64_hex)?)?).ok_or("bad signature")?;
        let es = decode_encsig(enc_sig_hex)?;
        match adaptor().recover_decryption_key(&y, &sig, &es) {
            Some(s) => Ok(hex::encode(s.to_bytes())),
            None => Ok(String::new()),
        }
    }

    /// Plain ECDSA signature (for the non-adaptor side of a 2-of-2). 64-byte hex.
    pub fn ecdsa_sign(signing_key_be: &str, msg32_hex: &str) -> Result<String, String> {
        let sk = secp_scalar(signing_key_be)?;
        let msg = arr32(&h2b(msg32_hex)?)?;
        let ecdsa = ECDSA::<Deterministic<Sha256>>::default();
        let sig = ecdsa.sign(&sk, &msg);
        Ok(hex::encode(sig.to_bytes()))
    }

    /// Verify a plain ECDSA signature (64 hex) against a pubkey (33 hex).
    pub fn ecdsa_verify(verify_point_hex: &str, msg32_hex: &str, sig64_hex: &str) -> Result<bool, String> {
        let vk = secp_point(verify_point_hex)?;
        let msg = arr32(&h2b(msg32_hex)?)?;
        let sig = Signature::from_bytes(arr64(&h2b(sig64_hex)?)?).ok_or("bad signature")?;
        let ecdsa = ECDSA::<Deterministic<Sha256>>::default();
        Ok(ecdsa.verify(&vk, &msg, &sig))
    }

    fn decode_encsig(hex_s: &str) -> Result<EncryptedSignature, String> {
        let bytes = h2b(hex_s)?;
        Ok(
            bincode::decode_from_slice::<bincode::serde::Compat<EncryptedSignature>, _>(&bytes, cfg())
                .map_err(|e| e.to_string())?
                .0
                 .0,
        )
    }
}

// ---------- wasm-bindgen surface ----------
#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;
    macro_rules! w {
        ($name:ident ( $($a:ident : &str),* ) -> String) => {
            #[wasm_bindgen]
            pub fn $name($($a: String),*) -> Result<String, JsValue> {
                super::api::$name($(&$a),*).map_err(|e| JsValue::from_str(&e))
            }
        };
        ($name:ident ( $($a:ident : &str),* ) -> bool) => {
            #[wasm_bindgen]
            pub fn $name($($a: String),*) -> Result<bool, JsValue> {
                super::api::$name($(&$a),*).map_err(|e| JsValue::from_str(&e))
            }
        };
    }
    w!(gen_secret_share() -> String);
    w!(ed_to_secp_scalar(ed_le_hex: &str) -> String);
    w!(secp_pubkey(scalar_be_hex: &str) -> String);
    w!(ed_pubkey(scalar_le_hex: &str) -> String);
    w!(ed_scalar_add(a_le: &str, b_le: &str) -> String);
    w!(ed_point_add(a: &str, b: &str) -> String);
    w!(dleq_prove(secret_le_hex: &str) -> String);
    w!(dleq_verify(proof_hex: &str, secp_hex: &str, ed_hex: &str) -> bool);
    w!(adaptor_encrypt(signing_key_be: &str, enc_point_hex: &str, msg32_hex: &str) -> String);
    w!(adaptor_verify(verify_point_hex: &str, enc_point_hex: &str, msg32_hex: &str, enc_sig_hex: &str) -> bool);
    w!(adaptor_decrypt(decryption_be: &str, enc_sig_hex: &str) -> String);
    w!(adaptor_recover(enc_point_hex: &str, sig64_hex: &str, enc_sig_hex: &str) -> String);
    w!(ecdsa_sign(signing_key_be: &str, msg32_hex: &str) -> String);
    w!(ecdsa_verify(verify_point_hex: &str, msg32_hex: &str, sig64_hex: &str) -> bool);
}

#[cfg(test)]
mod tests {
    use super::api;
    use super::{nums_ed, nums_secp};
    use curve25519_dalek_ng::edwards::EdwardsPoint;
    use curve25519_dalek_ng::traits::Identity;

    // U-1: the DLEQ generators must be genuine NUMS points (deterministic, valid,
    // torsion-free, not the identity), derived by hash-to-curve, not scalar*G.
    #[test]
    fn nums_generators_are_deterministic_and_clean() {
        let a = nums_ed(b"TestnetSwap/DLEQ/ed25519/H_q/v1");
        let b = nums_ed(b"TestnetSwap/DLEQ/ed25519/H_q/v1");
        assert_eq!(a.compress().to_bytes(), b.compress().to_bytes(), "ed NUMS deterministic");
        assert!(a != EdwardsPoint::identity(), "ed NUMS not identity");
        assert!(a.is_torsion_free(), "ed NUMS is in the prime-order subgroup");
        // different domain -> different point
        let c = nums_ed(b"TestnetSwap/DLEQ/ed25519/H_q/v2");
        assert_ne!(a.compress().to_bytes(), c.compress().to_bytes(), "domain separation");

        let p = nums_secp(b"TestnetSwap/DLEQ/secp256k1/H_p/v1");
        let q = nums_secp(b"TestnetSwap/DLEQ/secp256k1/H_p/v1");
        assert_eq!(p.to_bytes(), q.to_bytes(), "secp NUMS deterministic");
    }

    // L-4: dleq_prove must reject out-of-range / zero scalars with an error rather
    // than panicking (which would abort the WASM module).
    #[test]
    fn dleq_prove_rejects_out_of_range_and_zero() {
        assert!(api::dleq_prove(&"ff".repeat(32)).is_err(), "bit-252-set scalar rejected, not panic");
        assert!(api::dleq_prove(&"00".repeat(32)).is_err(), "zero scalar rejected");
        let s = api::gen_secret_share().unwrap();
        assert!(api::dleq_prove(&s).is_ok(), "a clamped share still proves");
    }

    // Replicates the atomic link using ONLY the granular JS-facing API, the way
    // the swap protocol will call it.
    #[test]
    fn api_atomic_link() {
        let s = api::gen_secret_share().unwrap(); // Monero key share (ed LE)
        let pj = api::dleq_prove(&s).unwrap();
        let get = |k: &str| {
            let pat = format!("\"{k}\":\"");
            let i = pj.find(&pat).unwrap() + pat.len();
            let j = pj[i..].find('"').unwrap();
            pj[i..i + j].to_string()
        };
        let (proof, secp, ed) = (get("proof"), get("secp"), get("ed"));
        assert!(api::dleq_verify(&proof, &secp, &ed).unwrap(), "DLEQ verify");

        // secp encryption key == DLEQ secp point
        let s_secp = api::ed_to_secp_scalar(&s).unwrap();
        assert_eq!(api::secp_pubkey(&s_secp).unwrap(), secp, "enc key matches DLEQ");
        // ed key share point == DLEQ ed point
        assert_eq!(api::ed_pubkey(&s).unwrap(), ed, "monero key share matches DLEQ");

        // adaptor flow: Bob signs encrypted under `secp`; Alice (knows s) decrypts; Bob recovers s.
        let bob = api::gen_secret_share().unwrap();
        let bob_secp = api::ed_to_secp_scalar(&bob).unwrap();
        let bob_pub = api::secp_pubkey(&bob_secp).unwrap();
        let msg = "ab".repeat(32);
        let enc = api::adaptor_encrypt(&bob_secp, &secp, &msg).unwrap();
        assert!(api::adaptor_verify(&bob_pub, &secp, &msg, &enc).unwrap(), "enc sig verify");
        let sig = api::adaptor_decrypt(&s_secp, &enc).unwrap();
        assert!(api::ecdsa_verify(&bob_pub, &msg, &sig).unwrap(), "decrypted sig is a valid ECDSA sig");
        let rec = api::adaptor_recover(&secp, &sig, &enc).unwrap();
        assert_eq!(rec, s_secp, "recovered secp scalar == s");

        // recovered scalar -> ed -> reconstructs the Monero key share point
        let mut le = hex::decode(&rec).unwrap();
        le.reverse();
        let rec_ed = hex::encode(le);
        assert_eq!(api::ed_pubkey(&rec_ed).unwrap(), ed, "recovered scalar reconstructs Monero key share");

        // share combination (Monero spend key = s_a + s_b)
        let sum = api::ed_scalar_add(&s, &bob).unwrap();
        let sum_pub = api::ed_pubkey(&sum).unwrap();
        let pt_sum = api::ed_point_add(&ed, &api::ed_pubkey(&bob).unwrap()).unwrap();
        assert_eq!(sum_pub, pt_sum, "S_a+S_b == (s_a+s_b)*G");
    }
}
