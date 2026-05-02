/**
 * Double Ratchet — Signal-style forward secrecy + post-compromise security
 * for our 1:1 offline (NIP-17) path.
 *
 * Combines two ratchets:
 *
 *   1. Symmetric (chain) ratchet — within a single sending or receiving chain,
 *      each message advances chainKey via HKDF and derives a one-time message
 *      key. The previous chainKey is overwritten, so an attacker who steals
 *      today's chainKey cannot decrypt yesterday's messages from that chain.
 *
 *   2. Diffie–Hellman ratchet — every time the conversation flips direction,
 *      both sides rotate to fresh ephemeral X25519 keypairs. The new shared
 *      secret feeds into the next pair of chain keys via KDF_RK. After a
 *      ratchet step, even an attacker who held the previous chain keys can
 *      no longer derive the new ones — post-compromise security.
 *
 * Bootstrap: this implementation does NOT use one-time prekeys (Signal's
 * X3DH). The very first chains are derived deterministically on both sides
 * from a long-term secp256k1 ECDH between the two Nostr identity keys.
 * That means messages sent BEFORE the first DH ratchet step (i.e. before
 * the recipient replies) only have the protection of the static-static
 * shared secret — if either long-term key leaks before that point, those
 * specific ciphertexts can be decrypted retrospectively. From the second
 * chain onward (i.e. starting with the recipient's first reply), full
 * Signal-grade FS + PCS apply.
 *
 * Out-of-order delivery: when a message arrives ahead of expected counter,
 * we derive and cache the keys for skipped counters up to MAX_SKIP. When a
 * message arrives from a previous chain (i.e. with an older peer DH pub),
 * we look it up in skippedMessageKeys keyed by (peerDhPub, counter).
 */

import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { randomBytes, bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { nip44 } from "nostr-tools";

// ---- Constants ----

const KEY_LEN = 32;
const NONCE_LEN = 24;
const INFO_INIT_RK = utf8("p2p-dr/init/rk");
const INFO_RESPONDER_DH = utf8("p2p-dr/init/responder-dh");
const INFO_RESPONDER_INIT_CHAIN = utf8("p2p-dr/init/responder-init-chain");
const INFO_KDF_RK = utf8("p2p-dr/kdf-rk");
const INFO_MK = utf8("p2p-dr/mk");
const INFO_CK = utf8("p2p-dr/ck");

/** Cap on how many skipped message keys we'll derive in a single chain catch-up. */
export const MAX_SKIP = 1000;

// ---- Types ----

export type X25519KeyPair = {
  publicKey: Uint8Array; // 32B
  privateKey: Uint8Array; // 32B
};

export type Chain = {
  chainKey: Uint8Array;
  /** Next counter to assign (for sending) or expect (for receiving). */
  counter: number;
};

/**
 * Per-peer ratchet state. Mutates after every encrypt/decrypt — caller is
 * responsible for persistence between operations.
 */
export type RatchetState = {
  /** 32-byte root key. */
  rootKey: Uint8Array;
  /** Our current ephemeral DH keypair — included in outgoing message headers. */
  selfDhKeyPair: X25519KeyPair;
  /**
   * Last peer DH public key we observed. null until we see one. Used to
   * detect direction-flips that trigger a DH ratchet step.
   */
  peerDhPub: Uint8Array | null;
  sendingChain: Chain;
  receivingChain: Chain;
  /** Counter of the LAST message we sent in the previous sending chain (for header.prevChainCounter). */
  prevSendingChainCounter: number;
  /**
   * Skipped message keys, keyed by `${peerDhPubHex}:${counter}`. Bounded by
   * MAX_SKIP across all entries; oldest evicted when full.
   */
  skipped: Map<string, Uint8Array>;
};

export type Header = {
  /** Sender's current ephemeral DH public key (32B). */
  dhPub: Uint8Array;
  /** This message's counter inside the sender's current sending chain. */
  counter: number;
  /** Number of messages the sender produced in their PREVIOUS sending chain — needed by the receiver to compute how many to skip if a direction-flip happened mid-flight. */
  prevChainCounter: number;
};

export type Encrypted = {
  header: Header;
  /** XChaCha20-Poly1305 ciphertext + auth tag, prefixed with 24-byte nonce. */
  ciphertext: Uint8Array;
};

// ---- Init ----

/**
 * Bootstrap a fresh ratchet state for a peer.
 *
 * Both sides call this with their own long-term Nostr secret + the peer's
 * long-term pubkey. Role (initiator vs responder) is decided
 * deterministically by lexicographic comparison of pubkeys so both sides
 * agree without any negotiation.
 *
 * Bootstrap design (this is the part that diverges from textbook Signal,
 * since we don't have one-time prekeys published in advance):
 *
 *   - Both sides compute a 32-byte shared secret SK from static-static
 *     secp256k1 ECDH (via nostr-tools' nip44.getConversationKey).
 *   - Both sides DETERMINISTICALLY derive a "responder DH keypair" from SK
 *     via HKDF. This keypair acts as the responder's initial DH key — the
 *     stand-in for what would be Bob's signed prekey in Signal X3DH.
 *   - Initiator (Alice): generates a fresh DH keypair AS IF she had just
 *     ratcheted from receiving a message with the responder DH pub. She
 *     immediately runs a DH ratchet step at init → seeds sendingChain.
 *     receivingChain is empty until she receives a real reply.
 *   - Responder (Bob): adopts the deterministic DH keypair as his selfDH.
 *     peerDhPub is null until he sees Alice's first message; on receive he
 *     runs a normal DH ratchet step. Because his self_dh_priv is the
 *     deterministic responder priv, Alice's at-init ratchet output and
 *     Bob's at-receive ratchet output produce the same chain keys.
 *
 * Security note: SK is reused for the very first chain. If either long-term
 * key leaks before the first DH ratchet step (i.e. before Bob's first
 * reply), the initial-chain ciphertexts are recoverable. Every chain after
 * that has full Signal-grade FS + PCS.
 */
export function initRatchet(opts: {
  selfPubkeyHex: string;
  selfSecret: Uint8Array; // secp256k1, 32B
  peerPubkeyHex: string;
}): RatchetState {
  const sharedSecret = nip44.v2.utils.getConversationKey(opts.selfSecret, opts.peerPubkeyHex);
  const rkInit = hkdf(sha256, sharedSecret, undefined, INFO_INIT_RK, KEY_LEN);

  // Responder's deterministic DH keypair — derived from SK, identical on
  // both sides. Used as the seed for the at-init DH ratchet step.
  const responderDhPriv = hkdf(sha256, sharedSecret, undefined, INFO_RESPONDER_DH, KEY_LEN);
  const responderDhPub = x25519.getPublicKey(responderDhPriv);

  // Responder's deterministic init chain — used when the responder happens
  // to be the FIRST one to send (before any DH ratchet step has occurred).
  // Both sides install it in the slot that aligns with that flow:
  //   responder ➜ sendingChain    (he encrypts under it)
  //   initiator ➜ receivingChain  (she decrypts under it)
  // Once any DH ratchet step runs (typically on the receiver's first receive
  // of a fresh peer DH), this chain is overwritten by a ratchet-derived one.
  const responderInitChain = hkdf(
    sha256,
    rkInit,
    undefined,
    INFO_RESPONDER_INIT_CHAIN,
    KEY_LEN,
  );

  const isInitiator = opts.selfPubkeyHex < opts.peerPubkeyHex;

  if (isInitiator) {
    // Initiator: generate fresh DH, run a DH ratchet step at init using her
    // fresh priv + responder's deterministic pub. This produces the
    // sendingChain she'll use for her first batch of sends. Her initial
    // receivingChain matches what the responder would send under
    // responderInitChain — handles the responder-sends-first case.
    const selfDhKeyPair = generateX25519();
    const dh1 = x25519.getSharedSecret(selfDhKeyPair.privateKey, responderDhPub);
    const [rk1, sendingCk] = kdfRk(rkInit, dh1);
    return {
      rootKey: rk1,
      selfDhKeyPair,
      peerDhPub: responderDhPub,
      sendingChain: { chainKey: sendingCk, counter: 0 },
      receivingChain: { chainKey: responderInitChain, counter: 0 },
      prevSendingChainCounter: 0,
      skipped: new Map(),
    };
  }

  // Responder: adopt the deterministic DH keypair. sendingChain installed so
  // he can send first if he wants; if he sends first, those messages have
  // only static-static SK protection. Once he receives the initiator's first
  // (fresh-DH-bearing) message, dhRatchetStep replaces both chains with
  // ratchet-derived ones for full FS + PCS thereafter.
  return {
    rootKey: rkInit,
    selfDhKeyPair: { publicKey: responderDhPub, privateKey: responderDhPriv },
    peerDhPub: null,
    sendingChain: { chainKey: responderInitChain, counter: 0 },
    receivingChain: { chainKey: new Uint8Array(KEY_LEN), counter: 0 },
    prevSendingChainCounter: 0,
    skipped: new Map(),
  };
}

// ---- Encrypt / decrypt ----

/**
 * Encrypt a plaintext under the current sending chain. Mutates state:
 * advances the chain counter and overwrites chainKey. Returns the wire
 * header and ciphertext.
 */
export function encrypt(
  state: RatchetState,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
): Encrypted {
  const messageKey = deriveMessageKey(state.sendingChain.chainKey);
  const nonce = randomBytes(NONCE_LEN);

  const header: Header = {
    dhPub: state.selfDhKeyPair.publicKey,
    counter: state.sendingChain.counter,
    prevChainCounter: state.prevSendingChainCounter,
  };
  const aad = composeAad(header, associatedData);
  const ciphertext = xchacha20poly1305(messageKey, nonce, aad).encrypt(plaintext);

  // Advance — old chain key is overwritten in place.
  state.sendingChain.chainKey = advanceChainKey(state.sendingChain.chainKey);
  state.sendingChain.counter += 1;
  messageKey.fill(0);

  // Prefix nonce so the wire format is self-contained.
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return { header, ciphertext: out };
}

/**
 * Decrypt a received message. Mutates state:
 *   - performs a DH ratchet step if header.dhPub differs from state.peerDhPub
 *   - derives & stores skipped keys for any gap
 *   - advances or looks up in skipped cache
 * Throws on auth failure or unrecoverable counter ordering.
 */
export function decrypt(
  state: RatchetState,
  header: Header,
  wireCiphertext: Uint8Array,
  associatedData: Uint8Array,
): Uint8Array {
  // 1. Try the skipped-keys cache first (covers messages from prior chains).
  const skippedKey = composeSkippedKey(header.dhPub, header.counter);
  const cachedMk = state.skipped.get(skippedKey);
  if (cachedMk) {
    state.skipped.delete(skippedKey);
    const pt = decryptWith(cachedMk, wireCiphertext, header, associatedData);
    cachedMk.fill(0);
    return pt;
  }

  // 2. Direction flip? Run DH ratchet step.
  if (
    state.peerDhPub === null ||
    !bytesEqual(header.dhPub, state.peerDhPub)
  ) {
    // Cache any remaining keys in our current receiving chain so messages
    // we hadn't yet decrypted from the prior chain stay decryptable.
    skipMessageKeys(
      state,
      state.peerDhPub,
      state.receivingChain,
      header.prevChainCounter,
    );
    dhRatchetStep(state, header.dhPub);
  }

  // 3. Catch up the receiving chain to header.counter, caching skipped keys.
  skipMessageKeys(state, state.peerDhPub, state.receivingChain, header.counter);

  // 4. Derive the message key for header.counter and advance.
  if (state.receivingChain.counter !== header.counter) {
    throw new Error(
      `receiving chain counter ${state.receivingChain.counter} ≠ header.counter ${header.counter} after catch-up`,
    );
  }
  const mk = deriveMessageKey(state.receivingChain.chainKey);
  state.receivingChain.chainKey = advanceChainKey(state.receivingChain.chainKey);
  state.receivingChain.counter += 1;

  const pt = decryptWith(mk, wireCiphertext, header, associatedData);
  mk.fill(0);
  return pt;
}

// ---- Internal helpers ----

function dhRatchetStep(state: RatchetState, peerDhPub: Uint8Array): void {
  // First leg: derive new RK + receiving chain from old DH key + new peer DH.
  const dh1 = x25519.getSharedSecret(state.selfDhKeyPair.privateKey, peerDhPub);
  const [newRk1, newRecvCk] = kdfRk(state.rootKey, dh1);
  state.rootKey = newRk1;
  state.receivingChain = { chainKey: newRecvCk, counter: 0 };
  state.peerDhPub = peerDhPub.slice();

  // Roll our own DH keypair for the next chain.
  state.prevSendingChainCounter = state.sendingChain.counter;
  state.selfDhKeyPair = generateX25519();

  // Second leg: derive new RK + sending chain from new DH key + same peer DH.
  const dh2 = x25519.getSharedSecret(state.selfDhKeyPair.privateKey, peerDhPub);
  const [newRk2, newSendCk] = kdfRk(state.rootKey, dh2);
  state.rootKey = newRk2;
  state.sendingChain = { chainKey: newSendCk, counter: 0 };
}

/**
 * Walk `chain` forward to `untilCounter`, caching each derived message key
 * keyed by (peerDhPub, counter). Bounded by MAX_SKIP.
 */
function skipMessageKeys(
  state: RatchetState,
  peerDhPub: Uint8Array | null,
  chain: Chain,
  untilCounter: number,
): void {
  if (untilCounter < chain.counter) return;
  if (untilCounter - chain.counter > MAX_SKIP) {
    throw new Error(
      `header counter ${untilCounter} too far ahead of chain counter ${chain.counter} (max-skip ${MAX_SKIP})`,
    );
  }
  if (!peerDhPub) {
    // Should not happen in practice — caller only invokes with a known peer
    // DH pub or before a ratchet step (in which case `chain` is empty). Be
    // defensive: just advance without caching, since we can't address them.
    chain.counter = untilCounter;
    chain.chainKey = advanceChainBy(chain.chainKey, untilCounter - chain.counter);
    return;
  }
  while (chain.counter < untilCounter) {
    const mk = deriveMessageKey(chain.chainKey);
    state.skipped.set(composeSkippedKey(peerDhPub, chain.counter), mk);
    chain.chainKey = advanceChainKey(chain.chainKey);
    chain.counter += 1;
    pruneSkipped(state);
  }
}

function pruneSkipped(state: RatchetState): void {
  while (state.skipped.size > MAX_SKIP) {
    const oldest = state.skipped.keys().next().value;
    if (oldest === undefined) break;
    const v = state.skipped.get(oldest);
    if (v) v.fill(0);
    state.skipped.delete(oldest);
  }
}

function deriveMessageKey(chainKey: Uint8Array): Uint8Array {
  return hkdf(sha256, chainKey, undefined, INFO_MK, KEY_LEN);
}

function advanceChainKey(chainKey: Uint8Array): Uint8Array {
  return hkdf(sha256, chainKey, undefined, INFO_CK, KEY_LEN);
}

function advanceChainBy(chainKey: Uint8Array, n: number): Uint8Array {
  let ck = chainKey;
  for (let i = 0; i < n; i++) ck = advanceChainKey(ck);
  return ck;
}

/**
 * KDF_RK: combine the current root key with a freshly-computed DH shared
 * secret to derive (newRootKey, newChainKey).
 */
function kdfRk(rootKey: Uint8Array, dhSecret: Uint8Array): [Uint8Array, Uint8Array] {
  const okm = hkdf(sha256, dhSecret, rootKey, INFO_KDF_RK, KEY_LEN * 2);
  return [okm.slice(0, KEY_LEN), okm.slice(KEY_LEN)];
}

function decryptWith(
  messageKey: Uint8Array,
  wireCiphertext: Uint8Array,
  header: Header,
  associatedData: Uint8Array,
): Uint8Array {
  const nonce = wireCiphertext.subarray(0, NONCE_LEN);
  const ct = wireCiphertext.subarray(NONCE_LEN);
  const aad = composeAad(header, associatedData);
  return xchacha20poly1305(messageKey, nonce, aad).decrypt(ct);
}

function composeAad(header: Header, extra: Uint8Array): Uint8Array {
  // AAD binds: dhPub | counter | prevChainCounter | caller-supplied extra.
  // Caller supplies (alice_pk | bob_pk) so a stolen ciphertext can't be
  // replayed across conversations.
  const counterBytes = u32be(header.counter);
  const prevBytes = u32be(header.prevChainCounter);
  const out = new Uint8Array(
    header.dhPub.length + counterBytes.length + prevBytes.length + extra.length,
  );
  let o = 0;
  out.set(header.dhPub, o);
  o += header.dhPub.length;
  out.set(counterBytes, o);
  o += counterBytes.length;
  out.set(prevBytes, o);
  o += prevBytes.length;
  out.set(extra, o);
  return out;
}

function composeSkippedKey(peerDhPub: Uint8Array, counter: number): string {
  return `${bytesToHex(peerDhPub)}:${counter}`;
}

function generateX25519(): X25519KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (n >>> 24) & 0xff;
  out[1] = (n >>> 16) & 0xff;
  out[2] = (n >>> 8) & 0xff;
  out[3] = n & 0xff;
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ---- (De)serialization for persistence ----

export type SerializedHeader = {
  dhPub: string;
  counter: number;
  prevChainCounter: number;
};

export type SerializedState = {
  version: 1;
  rootKey: string;
  selfDhKeyPair: { publicKey: string; privateKey: string };
  peerDhPub: string | null;
  sendingChain: { chainKey: string; counter: number };
  receivingChain: { chainKey: string; counter: number };
  prevSendingChainCounter: number;
  skipped: Record<string, string>;
};

export function serializeHeader(h: Header): SerializedHeader {
  return {
    dhPub: bytesToHex(h.dhPub),
    counter: h.counter,
    prevChainCounter: h.prevChainCounter,
  };
}

export function deserializeHeader(s: SerializedHeader): Header {
  return {
    dhPub: hexToBytes(s.dhPub),
    counter: s.counter,
    prevChainCounter: s.prevChainCounter,
  };
}

export function serializeState(state: RatchetState): SerializedState {
  const skipped: Record<string, string> = {};
  for (const [k, v] of state.skipped) skipped[k] = bytesToHex(v);
  return {
    version: 1,
    rootKey: bytesToHex(state.rootKey),
    selfDhKeyPair: {
      publicKey: bytesToHex(state.selfDhKeyPair.publicKey),
      privateKey: bytesToHex(state.selfDhKeyPair.privateKey),
    },
    peerDhPub: state.peerDhPub ? bytesToHex(state.peerDhPub) : null,
    sendingChain: {
      chainKey: bytesToHex(state.sendingChain.chainKey),
      counter: state.sendingChain.counter,
    },
    receivingChain: {
      chainKey: bytesToHex(state.receivingChain.chainKey),
      counter: state.receivingChain.counter,
    },
    prevSendingChainCounter: state.prevSendingChainCounter,
    skipped,
  };
}

export function deserializeState(s: SerializedState): RatchetState {
  const skipped = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(s.skipped)) skipped.set(k, hexToBytes(v));
  return {
    rootKey: hexToBytes(s.rootKey),
    selfDhKeyPair: {
      publicKey: hexToBytes(s.selfDhKeyPair.publicKey),
      privateKey: hexToBytes(s.selfDhKeyPair.privateKey),
    },
    peerDhPub: s.peerDhPub ? hexToBytes(s.peerDhPub) : null,
    sendingChain: {
      chainKey: hexToBytes(s.sendingChain.chainKey),
      counter: s.sendingChain.counter,
    },
    receivingChain: {
      chainKey: hexToBytes(s.receivingChain.chainKey),
      counter: s.receivingChain.counter,
    },
    prevSendingChainCounter: s.prevSendingChainCounter,
    skipped,
  };
}
