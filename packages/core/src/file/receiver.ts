import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import { merkleRoot, validateManifest } from "./chunker.js";
import type { WireChunk, WireManifest } from "./types.js";
import { makeLogger } from "../util/logger.js";

const log = makeLogger("file-recv");

export type ReceiverOptions = {
  manifest: WireManifest;
  /** Final destination path. Parent directory is created if missing. */
  destPath: string;
};

export type ReceiverProgress = {
  fileId: string;
  received: number;
  total: number;
  /** Most recently absorbed chunk index. */
  lastIndex: number;
};

/**
 * Stateful receiver for one file. Caller pushes chunks via `absorb` as they
 * arrive (in any order). Each chunk's hash is verified against the manifest
 * BEFORE it's written to the temp file. On `complete()`, the Merkle root is
 * recomputed and the temp file is atomically renamed to destPath.
 *
 * Persistence: writes go to a single sparse file at `<destPath>.partial.<fileId>`
 * with each chunk placed at its byte offset. We don't persist the bitmap of
 * received indices across runs — interrupted transfers must restart in v1.
 */
export class FileReceiver {
  readonly manifest: WireManifest;
  private destPath: string;
  private partialPath: string;
  private fd: number;
  private receivedSet = new Set<number>();
  private bytesReceived = 0;
  private done = false;
  private progressListeners = new Set<(p: ReceiverProgress) => void>();
  private completeListeners = new Set<() => void>();
  private failListeners = new Set<(reason: string) => void>();

  constructor(opts: ReceiverOptions) {
    const validationErr = validateManifest(opts.manifest);
    if (validationErr) throw new Error(`invalid manifest: ${validationErr}`);
    this.manifest = opts.manifest;
    this.destPath = opts.destPath;
    this.partialPath = `${opts.destPath}.partial.${opts.manifest.fileId}`;
    mkdirSync(dirname(opts.destPath), { recursive: true });
    // Allocate the partial file as sparse so we can write chunks at their
    // byte offset directly.
    this.fd = openSync(this.partialPath, "w+");
    if (opts.manifest.size > 0) {
      ftruncateSync(this.fd, opts.manifest.size);
    }
  }

  onProgress(fn: (p: ReceiverProgress) => void): () => void {
    this.progressListeners.add(fn);
    return () => this.progressListeners.delete(fn);
  }

  onComplete(fn: () => void): () => void {
    this.completeListeners.add(fn);
    return () => this.completeListeners.delete(fn);
  }

  onFail(fn: (reason: string) => void): () => void {
    this.failListeners.add(fn);
    return () => this.failListeners.delete(fn);
  }

  /**
   * Absorb a single chunk. Returns true if it was newly written, false if
   * it was a duplicate. Throws on integrity failure (caller should treat
   * as fatal — manifest specified a hash that doesn't match the bytes).
   */
  absorb(chunk: WireChunk, plaintext: Uint8Array): boolean {
    if (this.done) return false;
    if (chunk.fileId !== this.manifest.fileId) {
      throw new Error(`chunk fileId mismatch: ${chunk.fileId}`);
    }
    if (chunk.i < 0 || chunk.i >= this.manifest.chunks) {
      throw new Error(`chunk index out of range: ${chunk.i}`);
    }
    if (this.receivedSet.has(chunk.i)) return false;

    // Verify hash against manifest. The chunk's wire `h` is sender-supplied;
    // we trust the MANIFEST (which receiver may have additionally checked
    // out-of-band) so we use that as ground truth.
    const expected = this.manifest.hashes[chunk.i].toLowerCase();
    const actual = bytesToHex(blake3(plaintext));
    if (actual !== expected) {
      const reason = `chunk ${chunk.i} hash mismatch (expected ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}…)`;
      this.fail(reason);
      throw new Error(reason);
    }
    if (chunk.h && chunk.h.toLowerCase() !== expected) {
      // Chunk's self-declared hash disagrees with the manifest. Could indicate
      // a bug or a tampered envelope; reject to be safe.
      const reason = `chunk ${chunk.i} self-hash disagrees with manifest`;
      this.fail(reason);
      throw new Error(reason);
    }

    // Write at offset.
    const offset = chunk.i * this.manifest.chunkSize;
    const expectedLen =
      chunk.i === this.manifest.chunks - 1
        ? this.manifest.size - offset
        : this.manifest.chunkSize;
    if (plaintext.length !== expectedLen) {
      const reason = `chunk ${chunk.i} wrong size: expected ${expectedLen}, got ${plaintext.length}`;
      this.fail(reason);
      throw new Error(reason);
    }
    writeSync(this.fd, plaintext, 0, plaintext.length, offset);
    this.receivedSet.add(chunk.i);
    this.bytesReceived += plaintext.length;
    for (const l of this.progressListeners) {
      try {
        l({
          fileId: this.manifest.fileId,
          received: this.receivedSet.size,
          total: this.manifest.chunks,
          lastIndex: chunk.i,
        });
      } catch {
        // listener errors are isolated
      }
    }
    return true;
  }

  /** True if all chunks have been absorbed. */
  isReady(): boolean {
    return this.receivedSet.size === this.manifest.chunks;
  }

  /**
   * Finalize: verify Merkle root from the chunk hashes we received, fsync,
   * close fd, atomic-rename to destPath. Idempotent.
   */
  complete(): string {
    if (this.done) return this.destPath;
    if (!this.isReady()) {
      throw new Error(
        `cannot complete: ${this.receivedSet.size}/${this.manifest.chunks} chunks received`,
      );
    }
    // Cross-check Merkle root one more time against what the manifest claims.
    const computedRoot = bytesToHex(merkleRoot(this.manifest.hashes));
    if (computedRoot !== this.manifest.root.toLowerCase()) {
      const reason = `merkle root mismatch on completion`;
      this.fail(reason);
      throw new Error(reason);
    }
    closeSync(this.fd);
    renameSync(this.partialPath, this.destPath);
    this.done = true;
    log.info("file complete", {
      fileId: this.manifest.fileId,
      name: this.manifest.name,
      bytes: this.bytesReceived,
      path: this.destPath,
    });
    for (const l of this.completeListeners) {
      try {
        l();
      } catch {
        // listener errors are isolated
      }
    }
    return this.destPath;
  }

  /** Discard partial state — used on hash failure, peer abort, or user cancel. */
  fail(reason: string): void {
    if (this.done) return;
    try {
      closeSync(this.fd);
    } catch {
      // closeSync may throw if already closed; ignore
    }
    try {
      unlinkSync(this.partialPath);
    } catch {
      // partial file may not exist; ignore
    }
    this.done = true;
    log.warn("file transfer failed", { fileId: this.manifest.fileId, reason });
    for (const l of this.failListeners) {
      try {
        l(reason);
      } catch {
        // listener errors are isolated
      }
    }
  }

  /** Outstanding chunk indices (used to ask for retransmits or report state). */
  missingIndices(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.manifest.chunks; i++) {
      if (!this.receivedSet.has(i)) out.push(i);
    }
    return out;
  }

  receivedCount(): number {
    return this.receivedSet.size;
  }

  bytesWritten(): number {
    return this.bytesReceived;
  }
}

/** Default destination path: `<dataDir>/incoming/<fileId>__<sanitized-name>`. */
export function defaultIncomingPath(opts: {
  dataDir: string;
  fileId: string;
  name: string;
}): string {
  const sanitized = opts.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(opts.dataDir, "incoming", `${opts.fileId}__${sanitized}`);
}
