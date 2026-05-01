import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes } from "@noble/hashes/utils";

/**
 * Sender Keys — Signal-style group ratchet.
 *
 * Each (group, sender) pair holds a chain key. Each message advances the chain
 * via HKDF, deleting the previous chain key. The resulting message keys are
 * one-time use, so an attacker who steals today's chain key cannot decrypt
 * yesterday's messages (forward secrecy within a sender's chain).
 *
 * Out-of-order delivery is handled by deriving and caching skipped message
 * keys up to a bounded limit (MAX_SKIP). Beyond that we refuse to derive —
 * a deliberately replayed-or-buried message can't burn unbounded CPU/memory.
 *
 * All KDFs use HKDF-SHA256 with distinct `info` strings so the same chain
 * key never produces both a message key and the next chain key.
 */

const NONCE_LEN = 24;
const KEY_LEN = 32;
const INFO_MK = new TextEncoder().encode("p2p-group-mk");
const INFO_CK = new TextEncoder().encode("p2p-group-ck");

/**
 * Bounded ceiling on how many keys we'll derive ahead to recover from a
 * gap. Matches Signal's tunable; large enough for real reorder, small enough
 * to be a hard limit on resource use.
 */
export const MAX_SKIP = 1000;

export type SenderChainState = {
  /** 32-byte HKDF chain key. Mutates after every advance — old value is gone. */
  chainKey: Uint8Array;
  /** Next message counter to be assigned by THIS chain. Monotonic. */
  counter: number;
  /**
   * Out-of-order delivery cache: counter → message key. Bounded by MAX_SKIP
   * total entries; oldest evicted when full.
   */
  skipped: Map<number, Uint8Array>;
};

export function newChainState(seed: Uint8Array): SenderChainState {
  if (seed.length !== KEY_LEN) throw new Error("chain seed must be 32 bytes");
  return {
    chainKey: new Uint8Array(seed),
    counter: 0,
    skipped: new Map(),
  };
}

/** Generate a fresh, random chain seed for a new sender key epoch. */
export function generateChainSeed(): Uint8Array {
  return randomBytes(KEY_LEN);
}

function deriveMessageKey(chainKey: Uint8Array): Uint8Array {
  return hkdf(sha256, chainKey, undefined, INFO_MK, KEY_LEN);
}

function advanceChainKey(chainKey: Uint8Array): Uint8Array {
  return hkdf(sha256, chainKey, undefined, INFO_CK, KEY_LEN);
}

export type EncryptedMessage = {
  /** Counter the sender assigned to this message in their chain. */
  counter: number;
  /** XChaCha20 nonce (random per message). */
  nonce: Uint8Array;
  /** XChaCha20-Poly1305 ciphertext including auth tag. */
  ciphertext: Uint8Array;
};

/**
 * Encrypt with the current chain key, then advance. Caller-supplied
 * associated data (AAD) binds the ciphertext to a context — for groups
 * we bind to (groupId, senderPubkey, epoch) so a stolen ciphertext can't
 * be replayed into a different group context.
 */
export function encryptMessage(
  state: SenderChainState,
  plaintext: Uint8Array,
  aad: Uint8Array,
): EncryptedMessage {
  const messageKey = deriveMessageKey(state.chainKey);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = xchacha20poly1305(messageKey, nonce, aad);
  const ciphertext = cipher.encrypt(plaintext);
  const counter = state.counter;

  // Advance chain — this is what gives forward secrecy. The new chainKey is
  // derived from the old, but the old one is overwritten so it cannot be
  // reconstructed even with the next chainKey + the message we just sent.
  state.chainKey = advanceChainKey(state.chainKey);
  state.counter += 1;

  // Erase the message key from local memory (best-effort — the encrypt call
  // may have already retained a copy; in JS we can't truly zeroize).
  messageKey.fill(0);

  return { counter, nonce, ciphertext };
}

/**
 * Decrypt an inbound message. Handles three cases:
 *   1. counter === state.counter: derive the message key, advance, decrypt.
 *   2. counter > state.counter:   derive (and cache) skipped keys for the gap,
 *                                 then decrypt. Refuses if gap > MAX_SKIP.
 *   3. counter < state.counter:   look in skipped cache; otherwise the
 *                                 message is too old to recover.
 *
 * Throws on auth failure or recovery failure. Returns plaintext on success.
 */
export function decryptMessage(
  state: SenderChainState,
  msg: EncryptedMessage,
  aad: Uint8Array,
): Uint8Array {
  if (msg.counter < state.counter) {
    const cached = state.skipped.get(msg.counter);
    if (!cached) {
      throw new Error(`message key for counter ${msg.counter} unavailable (gone)`);
    }
    const cipher = xchacha20poly1305(cached, msg.nonce, aad);
    const pt = cipher.decrypt(msg.ciphertext);
    cached.fill(0);
    state.skipped.delete(msg.counter);
    return pt;
  }

  // Catch the chain up to msg.counter, caching skipped keys.
  const gap = msg.counter - state.counter;
  if (gap > MAX_SKIP) {
    throw new Error(
      `message counter ${msg.counter} too far ahead of chain ${state.counter} (max-skip ${MAX_SKIP})`,
    );
  }
  while (state.counter < msg.counter) {
    const skippedMessageKey = deriveMessageKey(state.chainKey);
    state.skipped.set(state.counter, skippedMessageKey);
    state.chainKey = advanceChainKey(state.chainKey);
    state.counter += 1;
    pruneSkipped(state);
  }

  // Now state.counter === msg.counter. Derive, advance, decrypt.
  const messageKey = deriveMessageKey(state.chainKey);
  state.chainKey = advanceChainKey(state.chainKey);
  state.counter += 1;
  const cipher = xchacha20poly1305(messageKey, msg.nonce, aad);
  const pt = cipher.decrypt(msg.ciphertext);
  messageKey.fill(0);
  pruneSkipped(state);
  return pt;
}

/** Keep the skipped-keys cache bounded — evict oldest entries first. */
function pruneSkipped(state: SenderChainState): void {
  while (state.skipped.size > MAX_SKIP) {
    const oldestKey = state.skipped.keys().next().value;
    if (oldestKey === undefined) break;
    const oldestVal = state.skipped.get(oldestKey);
    if (oldestVal) oldestVal.fill(0);
    state.skipped.delete(oldestKey);
  }
}

/**
 * Build the AAD for the AEAD on a group message. Binding chat content to
 * (groupId, senderPubkey, epoch, counter) prevents cross-group replay and
 * cross-epoch confusion.
 */
export function buildAad(
  groupId: string,
  senderPubkey: string,
  epoch: number,
  counter: number,
): Uint8Array {
  return new TextEncoder().encode(
    `${groupId}|${senderPubkey}|${epoch}|${counter}`,
  );
}
