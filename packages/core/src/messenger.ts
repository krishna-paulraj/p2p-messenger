import { type Clock } from "./nostr/vector-clock.js";
import { OfflineMessenger, type OfflineMessage } from "./nostr/offline-queue.js";
import { Peer } from "./peer.js";
import { makeLogger } from "./util/logger.js";

const log = makeLogger("messenger");

export type MessengerSource = "webrtc" | "offline";

export type IncomingMessage = {
  from: string;
  text: string;
  source: MessengerSource;
  /** UNIX seconds — wall-clock ts of the message origin (best estimate). */
  ts: number;
  /** Sender's vector clock (only present for offline messages). */
  clock?: Clock;
  /**
   * True if this message was delivered as part of an initial offline drain
   * (i.e. backlog from before we connected). False for live messages. Useful
   * for the UI to tag delivered-while-away messages distinctly.
   */
  fromDrain?: boolean;
};

export type SendResult = {
  source: MessengerSource;
  /** Underlying gift-wrap event id, only present for offline. */
  eventId?: string;
};

export type MessengerOptions = {
  peer: Peer;
  /** Optional offline messenger; if absent, send falls back to throwing when not connected. */
  offline?: OfflineMessenger;
  /** UI-supplied clock for tagging WebRTC sends (so offline drains stay consistent). */
  tickClock?: () => Clock;
};

/**
 * Messenger: glue layer that picks WebRTC if connected to peer, otherwise the offline
 * NIP-17 path. Presents a single `send()` API and a unified `onMessage` stream.
 */
export class Messenger {
  private peer: Peer;
  private offline?: OfflineMessenger;
  private listeners = new Set<(msg: IncomingMessage) => void>();
  private connectListeners = new Set<(peerId: string) => void>();
  private tickClock?: () => Clock;
  private offUnsub?: () => void;
  private peerUnsubMessage?: () => void;
  private peerUnsubConnect?: () => void;

  constructor(opts: MessengerOptions) {
    this.peer = opts.peer;
    this.offline = opts.offline;
    this.tickClock = opts.tickClock;

    this.peerUnsubMessage = this.peer.onMessage((from, text) => {
      const msg: IncomingMessage = {
        from,
        text,
        source: "webrtc",
        ts: Math.floor(Date.now() / 1000),
      };
      for (const l of this.listeners) l(msg);
    });
    this.peerUnsubConnect = this.peer.onConnect((id) => {
      for (const l of this.connectListeners) l(id);
    });

    if (this.offline) {
      this.offUnsub = this.offline.on((m: OfflineMessage) => {
        const msg: IncomingMessage = {
          from: m.from,
          text: m.text,
          source: "offline",
          ts: m.ts,
          clock: m.clock,
          fromDrain: m.fromDrain,
        };
        for (const l of this.listeners) l(msg);
      });
    }
  }

  get selfId(): string {
    return this.peer.selfId;
  }

  onMessage(fn: (msg: IncomingMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onConnect(fn: (peerId: string) => void): () => void {
    this.connectListeners.add(fn);
    return () => this.connectListeners.delete(fn);
  }

  isConnected(peerId: string): boolean {
    return this.peer.isConnected(peerId);
  }

  connectedPeers(): string[] {
    return this.peer.connectedPeers();
  }

  async dial(peerId: string): Promise<void> {
    return this.peer.connect(peerId);
  }

  async send(toPeerId: string, text: string): Promise<SendResult> {
    if (this.peer.isConnected(toPeerId)) {
      this.peer.send(toPeerId, text);
      // Tick the clock so the next offline send sees the right successor counter.
      this.tickClock?.();
      return { source: "webrtc" };
    }
    if (!this.offline) {
      throw new Error(`not connected to ${toPeerId} and no offline transport configured`);
    }
    const result = await this.offline.send(toPeerId, text);
    log.info("sent via offline", {
      to: toPeerId.slice(0, 8),
      eventId: result.eventId,
    });
    return { source: "offline", eventId: result.eventId };
  }

  async close(): Promise<void> {
    this.peerUnsubMessage?.();
    this.peerUnsubConnect?.();
    this.offUnsub?.();
    if (this.offline) await this.offline.close();
    await this.peer.close();
  }
}
