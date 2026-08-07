/* tslint:disable */
/* eslint-disable */

export function adaptor_decrypt(decryption_be: string, enc_sig_hex: string): string;

export function adaptor_encrypt(signing_key_be: string, enc_point_hex: string, msg32_hex: string): string;

export function adaptor_recover(enc_point_hex: string, sig64_hex: string, enc_sig_hex: string): string;

export function adaptor_verify(verify_point_hex: string, enc_point_hex: string, msg32_hex: string, enc_sig_hex: string): boolean;

export function dleq_prove(secret_le_hex: string): string;

export function dleq_verify(proof_hex: string, secp_hex: string, ed_hex: string): boolean;

export function ecdsa_sign(signing_key_be: string, msg32_hex: string): string;

export function ecdsa_verify(verify_point_hex: string, msg32_hex: string, sig64_hex: string): boolean;

export function ed_point_add(a: string, b: string): string;

export function ed_pubkey(scalar_le_hex: string): string;

export function ed_scalar_add(a_le: string, b_le: string): string;

export function ed_to_secp_scalar(ed_le_hex: string): string;

export function gen_secret_share(): string;

export function secp_pubkey(scalar_be_hex: string): string;
