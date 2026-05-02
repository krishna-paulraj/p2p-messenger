import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
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

function rehydrate(stored: StoredIdentity): WebIdentity {
  return {
    alias: stored.alias,
    publicKey: stored.publicHex,
    secretKey: hexToBytes(stored.secretHex),
    npub: stored.npub,
    createdAt: stored.createdAt,
  };
}
