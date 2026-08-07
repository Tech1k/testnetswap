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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly adaptor_decrypt: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly adaptor_encrypt: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly adaptor_recover: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly adaptor_verify: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly dleq_prove: (a: number, b: number) => [number, number, number, number];
    readonly dleq_verify: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly ecdsa_sign: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly ecdsa_verify: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly ed_point_add: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly ed_pubkey: (a: number, b: number) => [number, number, number, number];
    readonly ed_scalar_add: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly ed_to_secp_scalar: (a: number, b: number) => [number, number, number, number];
    readonly gen_secret_share: () => [number, number, number, number];
    readonly secp_pubkey: (a: number, b: number) => [number, number, number, number];
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
