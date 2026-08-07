/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const adaptor_decrypt: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const adaptor_encrypt: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
export const adaptor_recover: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
export const adaptor_verify: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
export const dleq_prove: (a: number, b: number) => [number, number, number, number];
export const dleq_verify: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
export const ecdsa_sign: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const ecdsa_verify: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
export const ed_point_add: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const ed_pubkey: (a: number, b: number) => [number, number, number, number];
export const ed_scalar_add: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const ed_to_secp_scalar: (a: number, b: number) => [number, number, number, number];
export const gen_secret_share: () => [number, number, number, number];
export const secp_pubkey: (a: number, b: number) => [number, number, number, number];
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_start: () => void;
