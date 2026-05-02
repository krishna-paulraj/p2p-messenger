import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes } from "@noble/hashes/utils";

export type KeyPair = { publicKey: Uint8Array; privateKey: Uint8Array };
export type SessionKeys = { tx: Uint8Array; rx: Uint8Array };

export function initCrypto(): Promise<void> {
  return Promise.resolve();
}

export function generateKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/**
 * Derive symmetric session keys via X25519 + HKDF-SHA256.
 * The two roles (client/server) get swapped tx/rx so each peer encrypts with the
 * other peer's decrypt key. Convention: lexicographically smaller peerId is "client".
 */
export function deriveSessionKeys(
  self: KeyPair,
  peerPublicKey: Uint8Array,
  isClient: boolean,
): SessionKeys {
  const shared = x25519.getSharedSecret(self.privateKey, peerPublicKey);
  const okm = hkdf(sha256, shared, undefined, "p2p-messenger-v1", 64);
  const k1 = okm.slice(0, 32);
  const k2 = okm.slice(32, 64);
  return isClient ? { tx: k1, rx: k2 } : { tx: k2, rx: k1 };
}

const NONCE_LEN = 24;

/**
 * Encrypt arbitrary bytes under an XChaCha20-Poly1305 key. Wire layout is
 * `nonce || ciphertext+tag` — the receiver knows the nonce length is always
 * NONCE_LEN. Callers should treat each call's nonce as one-shot; never reuse
 * (nonce, key) tuples.
 */
export function encryptBytes(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = xchacha20poly1305(key, nonce);
  const ct = cipher.encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

export function decryptBytes(payload: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = payload.subarray(0, NONCE_LEN);
  const ct = payload.subarray(NONCE_LEN);
  const cipher = xchacha20poly1305(key, nonce);
  return cipher.decrypt(ct);
}

export function encrypt(plaintext: string, key: Uint8Array): Uint8Array {
  return encryptBytes(new TextEncoder().encode(plaintext), key);
}

export function decrypt(payload: Uint8Array, key: Uint8Array): string {
  return new TextDecoder().decode(decryptBytes(payload, key));
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}
