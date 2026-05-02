/**
 * Browser-safe entry point. Re-exports the subset of `@p2p/core` that does
 * NOT touch Node-only APIs (fs, path, crypto.randomUUID via node:crypto, etc).
 *
 * Web package imports from "@p2p/core/browser" instead of "@p2p/core" to
 * avoid bundling fs-using modules like file/chunker, file/receiver,
 * file/transfer, nostr/identity, nostr/contacts, nostr/group/group-store, etc.
 *
 * Includes:
 *   - pure crypto helpers (encryptBytes / decryptBytes / kx etc.)
 *   - Double Ratchet primitives (init / encrypt / decrypt / serialize)
 *   - Gift wrap (NIP-44 + NIP-59) helpers
 *   - Event-kind constants
 *   - Vector clock primitives
 *   - File-frame wire types (constants only — no fs)
 */
export {
  encryptBytes,
  decryptBytes,
  encrypt,
  decrypt,
  deriveSessionKeys,
  generateKeyPair,
  initCrypto,
  toBase64,
  fromBase64,
  type KeyPair,
  type SessionKeys,
} from "./crypto.js";

export {
  initRatchet,
  encrypt as drEncrypt,
  decrypt as drDecrypt,
  serializeState as serializeRatchetState,
  deserializeState as deserializeRatchetState,
  type RatchetState,
  type Header as DrHeader,
  type SerializedState,
} from "./nostr/ratchet/double-ratchet.js";

export { giftWrap, giftUnwrap, type Unwrapped } from "./nostr/gift-wrap.js";
export { KINDS, PRESENCE_D_TAG } from "./nostr/kinds.js";

export {
  VectorClock,
  compareClocks,
  type Clock,
  type ClockOrder,
} from "./nostr/vector-clock.js";

export {
  FILE_CHUNK_SIZE,
  FILE_MAX_BYTES,
  FILE_CONTENT_TYPES,
  type WireManifest,
  type WireChunk,
  type WireFileFrame,
  type FileContentType,
} from "./file/types.js";
