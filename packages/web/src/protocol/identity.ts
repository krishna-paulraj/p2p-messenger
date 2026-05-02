import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  clearIdentity,
  loadIdentity,
  saveIdentity,
  type StoredIdentity,
} from "../db/store";

/** In-memory representation used by the rest of the protocol stack. */
export type WebIdentity = {
  alias: string;
  publicKey: string; // hex
  secretKey: Uint8Array;
  npub: string;
  createdAt: number;
};

export async function getOrCreateIdentity(alias: string): Promise<WebIdentity> {
  const existing = await loadIdentity();
  if (existing) return rehydrate(existing);

  const secretKey = generateSecretKey();
  const publicKey = getPublicKey(secretKey);
  const stored: StoredIdentity = {
    alias,
    publicHex: publicKey,
    secretHex: bytesToHex(secretKey),
    npub: nip19.npubEncode(publicKey),
    createdAt: Math.floor(Date.now() / 1000),
  };
  await saveIdentity(stored);
  return rehydrate(stored);
}

/**
 * Import an existing private key (nsec1… bech32 OR 64-char hex) under a
 * local alias. Replaces any persisted identity — caller is expected to have
 * confirmed this destructive choice.
 */
export async function importIdentity(opts: {
  alias: string;
  secret: string;
}): Promise<WebIdentity> {
  const secretKey = decodeSecret(opts.secret);
  const publicKey = getPublicKey(secretKey);
  // Drop any prior identity + its derived state (contacts, ratchets, etc.).
  // Without this the new keypair would inherit the old peer's encrypted
  // history that it can't decrypt.
  await clearIdentity();
  const stored: StoredIdentity = {
    alias: opts.alias,
    publicHex: publicKey,
    secretHex: bytesToHex(secretKey),
    npub: nip19.npubEncode(publicKey),
    createdAt: Math.floor(Date.now() / 1000),
  };
  await saveIdentity(stored);
  return rehydrate(stored);
}

function decodeSecret(input: string): Uint8Array {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("private key required");
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return hexToBytes(trimmed.toLowerCase());
  }
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") {
      throw new Error(`expected nsec, got ${decoded.type}`);
    }
    return decoded.data as Uint8Array;
  }
  throw new Error("not a valid nsec1… or 64-char hex private key");
}

export function decodePeerRef(ref: string): string {
  const trimmed = ref.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub") {
      throw new Error(`expected npub, got ${decoded.type}`);
    }
    return decoded.data;
  }
  throw new Error(`not a hex pubkey or npub: ${trimmed}`);
}

export function npubFor(hexPubkey: string): string {
  return nip19.npubEncode(hexPubkey);
}

/** Bech32-encoded private key (`nsec1…`). Treat the result like a password. */
export function nsecFor(secretKey: Uint8Array): string {
  return nip19.nsecEncode(secretKey);
}

function rehydrate(stored: StoredIdentity): WebIdentity {
  return {
    alias: stored.alias,
    publicKey: stored.publicHex,
    secretKey: hexToBytes(stored.secretHex),
    npub: stored.npub,
    createdAt: stored.createdAt,
  };
}
