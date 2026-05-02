/**
 * Chunk-and-hash a file. Streaming: never holds the whole file in memory.
 * Computes a per-chunk BLAKE3 hash plus a simple binary-tree Merkle root
 * that the receiver can verify after assembly.
 */

import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import { randomUUID } from "node:crypto";
import { FILE_CHUNK_SIZE, FILE_MAX_BYTES, type WireManifest } from "./types.js";
import { FILE_CONTENT_TYPES } from "./types.js";

export type ReadyChunk = {
  index: number;
  bytes: Uint8Array;
  hash: string; // hex
};

export type PreparedFile = {
  manifest: WireManifest;
  /**
   * Async iterator that yields each chunk in order with its hash. The bytes
   * are NOT encrypted — that happens at the transport layer (SecureChannel
   * or NIP-17 wrap).
   */
  iterator: AsyncIterableIterator<ReadyChunk>;
};

/**
 * Pre-scan a file to compute manifest (size, per-chunk hashes, Merkle root),
 * then return an iterator that re-streams the chunks. Two-pass — slower than
 * single-pass but lets us send the manifest BEFORE any chunk hits the wire,
 * so the receiver can pre-allocate, sanity-check size, and reject early.
 */
export async function prepareFile(opts: {
  path: string;
  mime?: string;
  chunkSize?: number;
}): Promise<PreparedFile> {
  const stat = statSync(opts.path);
  if (!stat.isFile()) throw new Error(`not a regular file: ${opts.path}`);
  if (stat.size > FILE_MAX_BYTES) {
    throw new Error(
      `file too large: ${stat.size} > ${FILE_MAX_BYTES} (FILE_MAX_BYTES)`,
    );
  }
  const chunkSize = opts.chunkSize ?? FILE_CHUNK_SIZE;
  const fileId = randomUUID();

  // Pass 1: compute hashes only.
  const hashes: string[] = [];
  for await (const c of streamChunks(opts.path, chunkSize)) {
    hashes.push(bytesToHex(blake3(c)));
  }
  const root = bytesToHex(merkleRoot(hashes));

  const manifest: WireManifest = {
    type: FILE_CONTENT_TYPES.MANIFEST,
    fileId,
    name: basename(opts.path),
    size: stat.size,
    mime: opts.mime,
    chunks: hashes.length,
    chunkSize,
    hashes,
    root,
    ts: Math.floor(Date.now() / 1000),
  };

  // Pass 2: stream chunks again with hashes attached.
  const iterator = (async function* (): AsyncIterableIterator<ReadyChunk> {
    let i = 0;
    for await (const bytes of streamChunks(opts.path, chunkSize)) {
      yield { index: i, bytes, hash: hashes[i] };
      i += 1;
    }
  })();

  return { manifest, iterator };
}

/**
 * Verify a manifest is internally consistent. Returns null on success;
 * an error string on failure. Used by the receiver before accepting a
 * transfer.
 */
export function validateManifest(m: WireManifest): string | null {
  if (typeof m.fileId !== "string" || !m.fileId) return "missing fileId";
  if (typeof m.name !== "string" || !m.name) return "missing name";
  if (m.size < 0) return "negative size";
  if (m.size > FILE_MAX_BYTES) return `size ${m.size} exceeds limit ${FILE_MAX_BYTES}`;
  if (!Number.isInteger(m.chunks) || m.chunks < 0) return "invalid chunk count";
  if (!Number.isInteger(m.chunkSize) || m.chunkSize <= 0) return "invalid chunkSize";
  if (m.chunks !== m.hashes.length) return "chunks count != hashes length";
  // chunks * chunkSize should be >= size (last chunk may be partial).
  const minBytes = (m.chunks - 1) * m.chunkSize;
  if (m.size > 0 && m.size < minBytes) return "manifest size inconsistent with chunks";
  if (m.size > 0 && m.size > m.chunks * m.chunkSize) return "manifest size > chunks*chunkSize";
  for (const h of m.hashes) {
    if (typeof h !== "string" || !/^[0-9a-f]{64}$/i.test(h)) return "bad chunk hash";
  }
  if (typeof m.root !== "string" || !/^[0-9a-f]{64}$/i.test(m.root)) return "bad root";
  // Recompute Merkle root from listed hashes — protects against a sender
  // sending a manifest with a tampered root.
  const expected = bytesToHex(merkleRoot(m.hashes));
  if (expected !== m.root.toLowerCase()) return "root mismatch";
  return null;
}

/**
 * Simple binary-tree Merkle root over BLAKE3 leaf hashes.
 * If the level has an odd number of nodes, duplicate the last one (Bitcoin
 * convention — keeps the implementation small).
 */
export function merkleRoot(leafHashesHex: string[]): Uint8Array {
  if (leafHashesHex.length === 0) {
    return blake3(new Uint8Array(0));
  }
  let level = leafHashesHex.map((h) => hexToBytes(h));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      const concat = new Uint8Array(left.length + right.length);
      concat.set(left, 0);
      concat.set(right, left.length);
      next.push(blake3(concat));
    }
    level = next;
  }
  return level[0];
}

async function* streamChunks(
  path: string,
  chunkSize: number,
): AsyncIterableIterator<Uint8Array> {
  // Use a fixed highWaterMark so node fills our chunks neatly without us
  // having to glue undersized reads together.
  const stream = createReadStream(path, { highWaterMark: chunkSize });
  let buf = new Uint8Array(0);
  for await (const data of stream as AsyncIterable<Buffer>) {
    if (buf.length === 0 && data.length === chunkSize) {
      yield new Uint8Array(data);
      continue;
    }
    const merged = new Uint8Array(buf.length + data.length);
    merged.set(buf, 0);
    merged.set(data, buf.length);
    buf = merged;
    while (buf.length >= chunkSize) {
      yield buf.slice(0, chunkSize);
      buf = buf.slice(chunkSize);
    }
  }
  if (buf.length > 0) yield buf;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
