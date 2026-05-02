import { dataDirFor } from "../nostr/identity.js";
import type { OfflineMessenger, IncomingFileFrame } from "../nostr/offline-queue.js";
import type { Peer, SecureChannel } from "../peer.js";
import { makeLogger } from "../util/logger.js";
import { base64ToBytes, sendFile, type SenderProgress } from "./sender.js";
import {
  FILE_CONTENT_TYPES,
  type WireAccept,
  type WireChunk,
  type WireComplete,
  type WireFileFrame,
  type WireManifest,
  type WireReject,
  type WireAbort,
} from "./types.js";
import { FileReceiver, defaultIncomingPath } from "./receiver.js";

const log = makeLogger("file-transfer");

/** Shape emitted to listeners during a transfer. */
export type TransferEvent =
  | {
      kind: "incoming-manifest";
      from: string;
      manifest: WireManifest;
      transport: "p2p" | "relay";
      /** Auto-accepted (sender is a known contact); false otherwise. */
      autoAccepted: boolean;
    }
  | {
      kind: "send-progress";
      to: string;
      progress: SenderProgress;
      transport: "p2p" | "relay";
    }
  | {
      kind: "recv-progress";
      from: string;
      fileId: string;
      received: number;
      total: number;
    }
  | { kind: "send-done"; to: string; fileId: string; chunks: number; size: number }
  | { kind: "recv-done"; from: string; fileId: string; path: string }
  | { kind: "send-failed"; to: string; fileId: string; reason: string }
  | { kind: "recv-failed"; from: string; fileId: string; reason: string };

export type FileTransferOptions = {
  peer: Peer;
  /** Required for the relay (offline) path; may be omitted to enforce P2P-only. */
  offline?: OfflineMessenger;
  /**
   * Called with each peer's hex pubkey before opening a transfer; should
   * return true if the sender is trusted enough to auto-accept incoming
   * files. Untrusted senders trigger an `incoming-manifest` event with
   * autoAccepted=false; the UI must call `accept(fileId)` to proceed.
   */
  isTrusted?: (peerId: string) => boolean;
  /** Base directory for `incoming/<fileId>__<name>` files. Defaults to data dir. */
  dataDir?: string;
  /** Throttle on relay-path chunk publishing. Defaults to 30 chunks/sec. */
  relayRatePerSecond?: number;
};

/** Per-recipient label for the WebRTC file channel. */
const FILE_CHANNEL_LABEL_PREFIX = "file:";

/** WebRTC backpressure: pause sends when this much data is buffered. */
const WEBRTC_HIGH_WATER = 1 * 1024 * 1024; // 1 MiB
const WEBRTC_LOW_WATER = 256 * 1024; // 256 KiB

/**
 * Top-level orchestrator for Phase 6 file transfer.
 *
 *   - Outgoing: `send(peerId, path)` → if peer is currently P2P-connected,
 *     opens a per-file SecureChannel and streams chunks (low latency, real
 *     backpressure, no relay rate limit). Else publishes via the relay path.
 *   - Incoming: subscribes to both Peer's onSecureChannel (P2P) and
 *     OfflineMessenger.onFileFrame (relay). Frames are dispatched to a
 *     per-fileId FileReceiver; progress + completion events fire through
 *     `on(...)`.
 *
 * The receiver-side accept policy is set by `isTrusted`. For untrusted
 * senders, the manifest fires `incoming-manifest` with `autoAccepted=false`;
 * the UI must call `accept(fileId)` (or `reject`) within 60s before the
 * receiver state is GC'd.
 */
export class FileTransferManager {
  private opts: FileTransferOptions;
  private dataDir: string;
  private listeners = new Set<(e: TransferEvent) => void>();
  /** Active receivers keyed by fileId. */
  private receivers = new Map<string, ReceiverEntry>();
  /** Active outgoing sends keyed by fileId, used for cancel. */
  private outgoing = new Map<string, OutgoingEntry>();
  /** Subscriptions to clean up on close. */
  private unsubs: Array<() => void> = [];
  /** Buffer chunks that arrive before their manifest (relay reordering). */
  private pendingChunks = new Map<string, IncomingFileFrame[]>();

  constructor(opts: FileTransferOptions) {
    this.opts = opts;
    this.dataDir = opts.dataDir ?? dataDirFor({});

    // P2P incoming: each new SecureChannel labeled "file:<fileId>" is a
    // separate file transfer.
    this.unsubs.push(
      opts.peer.onSecureChannel((peerId, channel) => {
        if (!channel.label.startsWith(FILE_CHANNEL_LABEL_PREFIX)) return;
        this.attachIncomingP2PChannel(peerId, channel);
      }),
    );

    // Relay incoming: dispatched per-frame via OfflineMessenger.
    if (opts.offline) {
      this.unsubs.push(
        opts.offline.onFileFrame((f) => this.handleRelayFrame(f)),
      );
    }
  }

  on(listener: (e: TransferEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Send a file. Prefers WebRTC if peer is connected; falls back to relay.
   * Returns the fileId so the UI can track progress.
   */
  async send(peerId: string, path: string, opts?: { mime?: string }): Promise<string> {
    const useP2P = this.opts.peer.isConnected(peerId);
    if (useP2P) return this.sendOverP2P(peerId, path, opts?.mime);
    if (!this.opts.offline) {
      throw new Error(`peer ${peerId} not P2P-connected and no relay transport available`);
    }
    return this.sendOverRelay(peerId, path, opts?.mime);
  }

  /** Manually accept an incoming transfer that was held for confirmation. */
  accept(fileId: string): void {
    const r = this.receivers.get(fileId);
    if (!r) throw new Error(`no pending file ${fileId}`);
    if (r.state !== "pending-accept") return;
    r.state = "receiving";
    if (r.transport === "p2p" && r.channel) {
      const accept: WireAccept = { type: FILE_CONTENT_TYPES.ACCEPT, fileId };
      r.channel.send(jsonBytes(accept));
    } else if (this.opts.offline) {
      const accept: WireAccept = { type: FILE_CONTENT_TYPES.ACCEPT, fileId };
      this.opts.offline.sendFileFrame(r.from, accept).catch((err) => {
        log.warn("send accept failed (relay)", { fileId, err: String(err) });
      });
    }
    // Drain any chunks that arrived ahead of the accept handshake.
    const buffered = this.pendingChunks.get(fileId);
    if (buffered) {
      this.pendingChunks.delete(fileId);
      for (const c of buffered) this.handleRelayFrame(c);
    }
  }

  reject(fileId: string, reason = "user declined"): void {
    const r = this.receivers.get(fileId);
    if (!r) return;
    const wire: WireReject = { type: FILE_CONTENT_TYPES.REJECT, fileId, reason };
    if (r.transport === "p2p" && r.channel) {
      try {
        r.channel.send(jsonBytes(wire));
        r.channel.close();
      } catch {
        // best-effort
      }
    } else if (this.opts.offline) {
      this.opts.offline.sendFileFrame(r.from, wire).catch(() => {});
    }
    r.receiver.fail(reason);
    this.receivers.delete(fileId);
    this.pendingChunks.delete(fileId);
  }

  /** Cancel an outgoing transfer. */
  cancelSend(fileId: string): void {
    const out = this.outgoing.get(fileId);
    if (!out) return;
    out.abort.abort();
    this.outgoing.delete(fileId);
  }

  /** List of currently active transfers — useful for `/files`. */
  active(): { fileId: string; direction: "send" | "recv"; peer: string; name: string; total: number; received?: number }[] {
    const out: ReturnType<FileTransferManager["active"]> = [];
    for (const [id, e] of this.outgoing) {
      out.push({ fileId: id, direction: "send", peer: e.peerId, name: e.manifestName, total: e.total });
    }
    for (const [id, e] of this.receivers) {
      out.push({
        fileId: id,
        direction: "recv",
        peer: e.from,
        name: e.receiver.manifest.name,
        total: e.receiver.manifest.chunks,
        received: e.receiver.receivedCount(),
      });
    }
    return out;
  }

  close(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    for (const e of this.receivers.values()) e.receiver.fail("manager closed");
    this.receivers.clear();
    for (const e of this.outgoing.values()) e.abort.abort();
    this.outgoing.clear();
  }

  // ---- Outgoing (P2P) ----

  private async sendOverP2P(
    peerId: string,
    path: string,
    mime: string | undefined,
  ): Promise<string> {
    const fileId = this.makeFileId();
    const channel = await this.opts.peer.openSecureChannel(
      peerId,
      `${FILE_CHANNEL_LABEL_PREFIX}${fileId}`,
    );
    const abort = new AbortController();
    const transport = {
      sendFrame: async (frame: WireFileFrame) => {
        channel.send(jsonBytes(frame));
      },
      waitForCapacity: async () => {
        if (channel.bufferedAmount() > WEBRTC_HIGH_WATER) {
          await channel.waitForDrain(WEBRTC_LOW_WATER);
        }
      },
    };
    const entry: OutgoingEntry = {
      peerId,
      abort,
      transport: "p2p",
      manifestName: "",
      total: 0,
    };
    this.outgoing.set(fileId, entry);

    let manifestSent: WireManifest | null = null;
    const wrappedSendFrame = transport.sendFrame;
    transport.sendFrame = async (frame) => {
      if (frame.type === FILE_CONTENT_TYPES.MANIFEST) {
        manifestSent = frame;
        entry.manifestName = frame.name;
        entry.total = frame.chunks;
      }
      await wrappedSendFrame(frame);
    };

    void (async () => {
      try {
        const result = await sendFile(transport, { path, mime, fileId, signal: abort.signal }, (p) =>
          this.emit({ kind: "send-progress", to: peerId, progress: p, transport: "p2p" }),
        );
        this.emit({
          kind: "send-done",
          to: peerId,
          fileId: result.fileId,
          chunks: result.chunks,
          size: result.size,
        });
        // Wait briefly for any ACK / close on the channel, then tear it down.
        setTimeout(() => channel.close(), 1000);
      } catch (err) {
        const reason = (err as Error).message ?? String(err);
        this.emit({ kind: "send-failed", to: peerId, fileId, reason });
        try {
          channel.close();
        } catch {
          // best-effort
        }
      } finally {
        this.outgoing.delete(fileId);
      }
      if (manifestSent === null) log.warn("manifest never sent", { fileId });
    })();

    return fileId;
  }

  // ---- Outgoing (Relay) ----

  private async sendOverRelay(
    peerId: string,
    path: string,
    mime: string | undefined,
  ): Promise<string> {
    const off = this.opts.offline;
    if (!off) throw new Error("relay transport not available");
    const fileId = this.makeFileId();
    const abort = new AbortController();
    const transport = {
      sendFrame: async (frame: WireFileFrame) => {
        await off.sendFileFrame(peerId, frame);
      },
      // Relay has its own pacing via `ratePerSecond` in sendFile options; no
      // additional waitForCapacity needed.
    };
    const entry: OutgoingEntry = {
      peerId,
      abort,
      transport: "relay",
      manifestName: "",
      total: 0,
    };
    this.outgoing.set(fileId, entry);

    void (async () => {
      try {
        const result = await sendFile(
          transport,
          {
            path,
            mime,
            fileId,
            signal: abort.signal,
            ratePerSecond: this.opts.relayRatePerSecond ?? 30,
          },
          (p) => {
            if (p.lastIndex === 0) {
              entry.total = p.total;
            }
            this.emit({ kind: "send-progress", to: peerId, progress: p, transport: "relay" });
          },
        );
        this.emit({
          kind: "send-done",
          to: peerId,
          fileId: result.fileId,
          chunks: result.chunks,
          size: result.size,
        });
      } catch (err) {
        const reason = (err as Error).message ?? String(err);
        this.emit({ kind: "send-failed", to: peerId, fileId, reason });
      } finally {
        this.outgoing.delete(fileId);
      }
    })();

    return fileId;
  }

  // ---- Incoming (P2P) ----

  private attachIncomingP2PChannel(peerId: string, channel: SecureChannel): void {
    let receiver: FileReceiver | null = null;
    let entry: ReceiverEntry | null = null;
    let closedByUs = false;

    channel.onMessage((bytes) => {
      let frame: WireFileFrame;
      try {
        frame = JSON.parse(new TextDecoder().decode(bytes)) as WireFileFrame;
      } catch {
        log.warn("malformed frame on file channel", { peerId });
        return;
      }
      if (frame.type === FILE_CONTENT_TYPES.MANIFEST) {
        if (receiver) {
          log.warn("duplicate manifest on file channel", {
            existing: receiver.manifest.fileId,
            incoming: frame.fileId,
          });
          return;
        }
        const path = defaultIncomingPath({
          dataDir: this.dataDir,
          fileId: frame.fileId,
          name: frame.name,
        });
        try {
          receiver = new FileReceiver({ manifest: frame, destPath: path });
        } catch (err) {
          const reason = (err as Error).message;
          log.warn("manifest rejected", { fileId: frame.fileId, reason });
          const reject: WireReject = {
            type: FILE_CONTENT_TYPES.REJECT,
            fileId: frame.fileId,
            reason,
          };
          channel.send(jsonBytes(reject));
          channel.close();
          return;
        }
        const trusted = this.opts.isTrusted?.(peerId) ?? true;
        entry = {
          fileId: frame.fileId,
          from: peerId,
          transport: "p2p",
          channel,
          receiver,
          state: trusted ? "receiving" : "pending-accept",
          createdAt: Date.now(),
        };
        this.receivers.set(frame.fileId, entry);
        this.emit({
          kind: "incoming-manifest",
          from: peerId,
          manifest: frame,
          transport: "p2p",
          autoAccepted: trusted,
        });
        if (trusted) {
          const accept: WireAccept = { type: FILE_CONTENT_TYPES.ACCEPT, fileId: frame.fileId };
          channel.send(jsonBytes(accept));
        }
        return;
      }
      if (!receiver || !entry) {
        log.debug("frame before manifest on file channel — dropping", { type: frame.type });
        return;
      }
      this.handleFrameForReceiver(entry, frame, () => {
        // After complete or fail: tear down.
        if (!closedByUs) {
          closedByUs = true;
          try {
            channel.close();
          } catch {
            // best-effort
          }
        }
      });
    });

    channel.onClose(() => {
      if (entry && entry.state !== "complete" && entry.state !== "failed") {
        const reason = "channel closed mid-transfer";
        entry.receiver.fail(reason);
        this.emit({
          kind: "recv-failed",
          from: peerId,
          fileId: entry.receiver.manifest.fileId,
          reason,
        });
        this.receivers.delete(entry.receiver.manifest.fileId);
      }
    });
  }

  // ---- Incoming (Relay) ----

  private handleRelayFrame(f: IncomingFileFrame): void {
    const frame = f.frame;
    if (frame.type === FILE_CONTENT_TYPES.MANIFEST) {
      if (this.receivers.has(frame.fileId)) return; // duplicate manifest
      const path = defaultIncomingPath({
        dataDir: this.dataDir,
        fileId: frame.fileId,
        name: frame.name,
      });
      let receiver: FileReceiver;
      try {
        receiver = new FileReceiver({ manifest: frame, destPath: path });
      } catch (err) {
        const reason = (err as Error).message;
        log.warn("relay manifest rejected", { fileId: frame.fileId, reason });
        if (this.opts.offline) {
          this.opts.offline.sendFileFrame(f.from, {
            type: FILE_CONTENT_TYPES.REJECT,
            fileId: frame.fileId,
            reason,
          }).catch(() => {});
        }
        return;
      }
      const trusted = this.opts.isTrusted?.(f.from) ?? true;
      const entry: ReceiverEntry = {
        fileId: frame.fileId,
        from: f.from,
        transport: "relay",
        receiver,
        state: trusted ? "receiving" : "pending-accept",
        createdAt: Date.now(),
      };
      this.receivers.set(frame.fileId, entry);
      this.emit({
        kind: "incoming-manifest",
        from: f.from,
        manifest: frame,
        transport: "relay",
        autoAccepted: trusted,
      });
      if (trusted && this.opts.offline) {
        this.opts.offline.sendFileFrame(f.from, {
          type: FILE_CONTENT_TYPES.ACCEPT,
          fileId: frame.fileId,
        }).catch(() => {});
        // Drain any chunks that arrived ahead of the manifest.
        const buf = this.pendingChunks.get(frame.fileId);
        if (buf) {
          this.pendingChunks.delete(frame.fileId);
          for (const c of buf) this.handleRelayFrame(c);
        }
      }
      return;
    }

    const entry = this.receivers.get(frame.fileId);
    if (!entry) {
      // Likely a chunk that arrived before the manifest (relay ordering not
      // guaranteed). Buffer it briefly; drained after manifest accept.
      if (frame.type === FILE_CONTENT_TYPES.CHUNK) {
        const buf = this.pendingChunks.get(frame.fileId) ?? [];
        buf.push(f);
        this.pendingChunks.set(frame.fileId, buf);
      }
      return;
    }

    this.handleFrameForReceiver(entry, frame);
  }

  // ---- Shared receiver-side frame handling ----

  private handleFrameForReceiver(
    entry: ReceiverEntry,
    frame: WireFileFrame,
    onTerminal?: () => void,
  ): void {
    if (entry.state === "complete" || entry.state === "failed") return;

    if (frame.type === FILE_CONTENT_TYPES.CHUNK) {
      if (entry.state === "pending-accept") {
        // Buffer until accept.
        entry.bufferedChunks ??= [];
        entry.bufferedChunks.push(frame);
        return;
      }
      this.absorbChunk(entry, frame, onTerminal);
      return;
    }

    if (frame.type === FILE_CONTENT_TYPES.COMPLETE) {
      // Sender signals end. If we already have all chunks, complete now;
      // otherwise wait — they may still be in flight on relays.
      if (entry.receiver.isReady()) {
        this.finalize(entry, onTerminal);
      } else {
        log.debug("complete received but chunks pending", {
          fileId: entry.fileId,
          missing: entry.receiver.missingIndices().length,
        });
      }
      return;
    }

    if (frame.type === FILE_CONTENT_TYPES.ABORT) {
      const reason = (frame as WireAbort).reason ?? "remote aborted";
      entry.receiver.fail(reason);
      entry.state = "failed";
      this.emit({
        kind: "recv-failed",
        from: entry.from,
        fileId: entry.fileId,
        reason,
      });
      this.receivers.delete(entry.fileId);
      onTerminal?.();
      return;
    }

    // ACK / REJECT not relevant on the receiver side beyond logging.
    log.debug("ignored frame on receiver", { type: frame.type });
  }

  private absorbChunk(
    entry: ReceiverEntry,
    frame: WireChunk,
    onTerminal?: () => void,
  ): void {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(frame.data);
    } catch (err) {
      log.warn("bad base64 in chunk", { fileId: entry.fileId, err: String(err) });
      return;
    }
    let absorbed = false;
    try {
      absorbed = entry.receiver.absorb(frame, bytes);
    } catch (err) {
      const reason = (err as Error).message;
      entry.state = "failed";
      this.emit({
        kind: "recv-failed",
        from: entry.from,
        fileId: entry.fileId,
        reason,
      });
      this.receivers.delete(entry.fileId);
      onTerminal?.();
      return;
    }
    if (!absorbed) return;

    this.emit({
      kind: "recv-progress",
      from: entry.from,
      fileId: entry.fileId,
      received: entry.receiver.receivedCount(),
      total: entry.receiver.manifest.chunks,
    });

    if (entry.receiver.isReady()) {
      this.finalize(entry, onTerminal);
    }
  }

  private finalize(entry: ReceiverEntry, onTerminal?: () => void): void {
    let path: string;
    try {
      path = entry.receiver.complete();
    } catch (err) {
      const reason = (err as Error).message;
      entry.state = "failed";
      this.emit({
        kind: "recv-failed",
        from: entry.from,
        fileId: entry.fileId,
        reason,
      });
      this.receivers.delete(entry.fileId);
      onTerminal?.();
      return;
    }
    entry.state = "complete";
    this.emit({
      kind: "recv-done",
      from: entry.from,
      fileId: entry.fileId,
      path,
    });
    // Echo a complete back to the sender so they can release any state.
    const wireComplete: WireComplete = {
      type: FILE_CONTENT_TYPES.COMPLETE,
      fileId: entry.fileId,
    };
    if (entry.transport === "p2p" && entry.channel) {
      try {
        entry.channel.send(jsonBytes(wireComplete));
      } catch {
        // best-effort
      }
    } else if (this.opts.offline) {
      this.opts.offline.sendFileFrame(entry.from, wireComplete).catch(() => {});
    }
    this.receivers.delete(entry.fileId);
    onTerminal?.();
  }

  private emit(e: TransferEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        log.error("transfer listener threw", { err: String(err) });
      }
    }
  }

  private makeFileId(): string {
    // Use crypto.randomUUID — node:crypto provides it without import in newer Node.
    return globalThis.crypto?.randomUUID?.() ?? fallbackId();
  }
}

type ReceiverEntry = {
  fileId: string;
  from: string;
  transport: "p2p" | "relay";
  channel?: SecureChannel;
  receiver: FileReceiver;
  state: "pending-accept" | "receiving" | "complete" | "failed";
  createdAt: number;
  /** Chunks received before user accepted (only when state=pending-accept). */
  bufferedChunks?: WireChunk[];
};

type OutgoingEntry = {
  peerId: string;
  transport: "p2p" | "relay";
  abort: AbortController;
  manifestName: string;
  total: number;
};

function jsonBytes(frame: WireFileFrame): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(frame));
}

function fallbackId(): string {
  // 16 random bytes hex, formatted as a UUID-ish string. Used only on
  // ancient node where globalThis.crypto.randomUUID is missing.
  const arr = new Uint8Array(16);
  for (let i = 0; i < 16; i++) arr[i] = Math.floor(Math.random() * 256);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

