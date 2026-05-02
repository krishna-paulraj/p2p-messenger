import { prepareFile } from "./chunker.js";
import { FILE_CONTENT_TYPES, type WireChunk, type WireFileFrame } from "./types.js";
import { makeLogger } from "../util/logger.js";

const log = makeLogger("file-send");

/**
 * Transport-shaped callbacks used by FileSender. The orchestrator wires
 * these to either a SecureChannel (WebRTC) or the OfflineMessenger
 * (NIP-17 relay).
 */
export type SenderTransport = {
  /** Send one envelope — caller serializes JSON, encrypts, etc. */
  sendFrame(frame: WireFileFrame): Promise<void>;
  /**
   * Optional. If provided, sender awaits it between chunks once a
   * downstream backpressure threshold is exceeded. Implementations should
   * resolve when it's safe to keep sending.
   */
  waitForCapacity?(): Promise<void>;
};

export type SenderProgress = {
  fileId: string;
  sent: number;
  total: number;
  lastIndex: number;
};

export type SendOptions = {
  path: string;
  mime?: string;
  /** Optional pre-known fileId to use instead of generating one. */
  fileId?: string;
  /**
   * Cap on chunks-per-second to a single recipient. 0 disables. Default 0
   * (no rate-limit) on WebRTC, ~50 on relay (set by the orchestrator).
   */
  ratePerSecond?: number;
};

/**
 * Stream a file through the given transport. Sends manifest first, then
 * each chunk in order. Awaits the transport's `waitForCapacity` between
 * chunks for backpressure on WebRTC.
 *
 * Cancellation: pass an AbortSignal in `signal` to stop mid-stream. The
 * transfer is aborted by sending a WireAbort frame on the wire.
 */
export async function sendFile(
  transport: SenderTransport,
  opts: SendOptions & { signal?: AbortSignal },
  onProgress?: (p: SenderProgress) => void,
): Promise<{ fileId: string; chunks: number; size: number }> {
  const prepared = await prepareFile({
    path: opts.path,
    mime: opts.mime,
    chunkSize: undefined,
  });
  const manifest = opts.fileId
    ? { ...prepared.manifest, fileId: opts.fileId }
    : prepared.manifest;
  const fileId = manifest.fileId;

  log.info("sending manifest", {
    fileId,
    name: manifest.name,
    size: manifest.size,
    chunks: manifest.chunks,
  });
  await transport.sendFrame(manifest);

  const minIntervalMs =
    opts.ratePerSecond && opts.ratePerSecond > 0 ? 1000 / opts.ratePerSecond : 0;
  let lastSendTs = 0;

  let sentIndex = 0;
  for await (const chunk of prepared.iterator) {
    if (opts.signal?.aborted) {
      log.info("send aborted by caller", { fileId });
      try {
        await transport.sendFrame({
          type: FILE_CONTENT_TYPES.ABORT,
          fileId,
          reason: "sender aborted",
        });
      } catch {
        // abort send is best-effort
      }
      throw new Error("aborted");
    }

    if (transport.waitForCapacity) {
      await transport.waitForCapacity();
    }
    if (minIntervalMs > 0) {
      const now = Date.now();
      const wait = lastSendTs + minIntervalMs - now;
      if (wait > 0) await sleep(wait);
      lastSendTs = Date.now();
    }

    const wire: WireChunk = {
      type: FILE_CONTENT_TYPES.CHUNK,
      fileId,
      i: chunk.index,
      data: bytesToBase64(chunk.bytes),
      h: chunk.hash,
    };
    await transport.sendFrame(wire);
    sentIndex = chunk.index;
    onProgress?.({
      fileId,
      sent: chunk.index + 1,
      total: manifest.chunks,
      lastIndex: chunk.index,
    });
  }

  await transport.sendFrame({ type: FILE_CONTENT_TYPES.COMPLETE, fileId });
  log.info("sender finished publishing", {
    fileId,
    chunks: manifest.chunks,
    lastIndex: sentIndex,
  });
  return { fileId, chunks: manifest.chunks, size: manifest.size };
}

function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

export function base64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
