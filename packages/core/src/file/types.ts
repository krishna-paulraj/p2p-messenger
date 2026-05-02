/**
 * Wire types for Phase 6 file transfer.
 *
 * Both transports (WebRTC SecureChannel and Nostr-relay NIP-17) carry the
 * same JSON envelope shapes; only the outer encryption + framing differs:
 *   - On WebRTC: each frame is one SecureChannel.send() call (encrypted with
 *     the X25519 session key under XChaCha20-Poly1305).
 *   - On Nostr: each frame becomes the inner content of a gift-wrapped NIP-17
 *     event, encrypted under the Double Ratchet for that peer.
 */

/**
 * Chunk size in bytes. Chosen so that one NIP-17 gift-wrapped chunk message
 * stays under NIP-44's 65535-byte plaintext limit at the wrap layer:
 *   chunk_bytes (10240) → base64 (~13652) → JSON envelope (~13800)
 *   → DR plaintext → DR ciphertext hex (~27800) → inner content (~27900)
 *   → rumor JSON (~28100) → NIP-44 padded (32768)
 *   → seal base64 (~43800) → wrap plaintext (~44100). Comfortably under 65535.
 * On WebRTC the chunk size constraint is ~64KB (SCTP); 10K is also fine there.
 */
export const FILE_CHUNK_SIZE = 10 * 1024;

/**
 * Hard limit on file size. Constrained primarily by the manifest-must-fit-in-
 * one-NIP-17-event invariant: max ~230 chunk hashes per manifest envelope.
 * 230 * 10KB = 2.3 MB. We cap a touch lower to leave headroom.
 *
 * For larger files in v2, the manifest can be split into pages or replaced
 * with a Merkle-root + per-chunk proof scheme that doesn't require listing
 * every hash up front.
 */
export const FILE_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB

export const FILE_CONTENT_TYPES = {
  MANIFEST: "p2p-file-manifest",
  CHUNK: "p2p-file-chunk",
  ACCEPT: "p2p-file-accept",
  REJECT: "p2p-file-reject",
  COMPLETE: "p2p-file-complete",
  ABORT: "p2p-file-abort",
  ACK: "p2p-file-ack",
} as const;

export type FileContentType =
  (typeof FILE_CONTENT_TYPES)[keyof typeof FILE_CONTENT_TYPES];

/** Sent first; tells receiver what to expect. */
export type WireManifest = {
  type: typeof FILE_CONTENT_TYPES.MANIFEST;
  fileId: string;
  name: string;
  size: number;
  mime?: string;
  /** Number of chunks. */
  chunks: number;
  chunkSize: number;
  /** Per-chunk BLAKE3-256 hex hash, in order. */
  hashes: string[];
  /** BLAKE3-256 of the simple binary-tree Merkle root over `hashes`. */
  root: string;
  /** UNIX seconds — used by receiver to age out abandoned transfers. */
  ts: number;
};

/** One file chunk. `data` is base64url-encoded plaintext bytes. */
export type WireChunk = {
  type: typeof FILE_CONTENT_TYPES.CHUNK;
  fileId: string;
  /** Zero-based chunk index. */
  i: number;
  data: string;
  /** BLAKE3 hash of the plaintext bytes — must match the manifest entry at index i. */
  h: string;
};

/** Receiver agrees to accept the manifest and is ready for chunks. */
export type WireAccept = {
  type: typeof FILE_CONTENT_TYPES.ACCEPT;
  fileId: string;
};

/** Receiver declines (size too big, untrusted sender, etc.). */
export type WireReject = {
  type: typeof FILE_CONTENT_TYPES.REJECT;
  fileId: string;
  reason: string;
};

/** Sender announces all chunks have been published. */
export type WireComplete = {
  type: typeof FILE_CONTENT_TYPES.COMPLETE;
  fileId: string;
};

/** Either side aborts an in-progress transfer. */
export type WireAbort = {
  type: typeof FILE_CONTENT_TYPES.ABORT;
  fileId: string;
  reason: string;
};

/**
 * Receiver-side acknowledgement of a chunk it has buffered + verified.
 * Only used on the WebRTC transport; relay path is fire-and-forget.
 */
export type WireAck = {
  type: typeof FILE_CONTENT_TYPES.ACK;
  fileId: string;
  i: number;
};

export type WireFileFrame =
  | WireManifest
  | WireChunk
  | WireAccept
  | WireReject
  | WireComplete
  | WireAbort
  | WireAck;
