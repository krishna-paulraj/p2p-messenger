import type { Event as NostrEvent } from "nostr-tools/core";
import type {
  IncomingSignal,
  SignalHandler,
  SignalPayload,
  SignalingTransport,
} from "../transport.js";
import { makeLogger } from "../util/logger.js";
import { giftUnwrap, giftWrap } from "./gift-wrap.js";
import { KINDS } from "./kinds.js";
import type { RelayPool, SubscriptionHandle } from "./relay-pool.js";

const log = makeLogger("nostr-signaling");

/**
 * Default freshness: signaling rumors older than this (by their inner created_at)
 * are dropped. Five minutes is generous for clock skew + relay latency while still
 * reliably ignoring replays from previous sessions.
 *
 * IMPORTANT: this uses the rumor's created_at, NOT the gift wrap's. NIP-59
 * randomizes the wrap's created_at within ±2 days for unlinkability; only the
 * rumor preserves the real send time.
 */
const DEFAULT_FRESHNESS_SECONDS = 5 * 60;

const DEDUP_RING_SIZE = 1024;

export type NostrSignalingOptions = {
  /** Long-term Nostr secret. Used to sign seals and unwrap incoming gift wraps. */
  secretKey: Uint8Array;
  /** Public key matching secretKey (hex). Becomes our selfId. */
  publicKey: string;
  /** Relay pool to publish/subscribe through. */
  pool: RelayPool;
  /**
   * Floor for accepting events (UNIX seconds). Defaults to now() − 60s on start
   * to skip stale wrap events from previous sessions.
   */
  sinceSeconds?: number;
  /** Reject signals whose inner rumor is older than this many seconds. */
  freshnessSeconds?: number;
};

export class NostrSignaling implements SignalingTransport {
  readonly selfId: string;
  private secret: Uint8Array;
  private pool: RelayPool;
  private sub?: SubscriptionHandle;
  private handlers = new Set<SignalHandler>();
  private since: number;
  private freshness: number;
  private started = false;
  private closed = false;
  /** Recently processed gift-wrap event ids (in-memory LRU). */
  private seenIds: string[] = [];

  constructor(opts: NostrSignalingOptions) {
    this.selfId = opts.publicKey;
    this.secret = opts.secretKey;
    this.pool = opts.pool;
    this.since = opts.sinceSeconds ?? Math.floor(Date.now() / 1000) - 60;
    this.freshness = opts.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Subscribe to gift wraps tagged for our pubkey. NIP-59 randomizes wrap
    // created_at by up to ±2 days for unlinkability, so we widen the window.
    // Stale rumors from earlier sessions are filtered out at receive time
    // using their real (rumor) created_at.
    this.sub = this.pool.subscribe(
      [
        {
          kinds: [KINDS.GIFT_WRAP],
          "#p": [this.selfId],
          since: this.since - 2 * 24 * 60 * 60,
        },
      ],
      {
        onevent: (event) => this.onWrap(event),
      },
    );
    log.info("subscribed to gift wraps", {
      pubkey: this.selfId,
      freshnessSeconds: this.freshness,
    });
  }

  async send(toPeerId: string, payload: SignalPayload): Promise<void> {
    if (!this.started) throw new Error("NostrSignaling.send before start()");
    if (this.closed) throw new Error("NostrSignaling is closed");
    const wrap = giftWrap({
      innerKind: KINDS.P2P_SIGNAL,
      innerContent: JSON.stringify(payload),
      senderSecret: this.secret,
      recipientPubkey: toPeerId,
    });
    log.debug("sending signal", { kind: payload.kind, to: toPeerId.slice(0, 8) });
    await this.pool.publish(wrap);
  }

  onSignal(handler: SignalHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.sub?.close();
  }

  private onWrap(event: NostrEvent): void {
    // Idempotent: never process the same gift wrap twice within this session.
    if (this.seenIds.includes(event.id)) return;
    this.markSeen(event.id);

    const unwrapped = giftUnwrap(event, this.secret);
    if (!unwrapped) return; // not for us, or malformed
    if (unwrapped.innerKind !== KINDS.P2P_SIGNAL) {
      // Not a signaling rumor — silently ignore (could be a chat message
      // destined for OfflineMessenger).
      return;
    }

    // Freshness gate using the inner rumor's created_at (truthful timestamp,
    // unlike the gift wrap's randomized one). This is what prevents replayed
    // signaling from prior sessions reaching the Peer state machine.
    const now = Math.floor(Date.now() / 1000);
    const ageSeconds = now - unwrapped.rumorCreatedAt;
    if (ageSeconds > this.freshness) {
      log.debug("dropping stale signaling rumor", {
        from: unwrapped.senderPubkey.slice(0, 8),
        ageSeconds,
        freshness: this.freshness,
      });
      return;
    }
    if (ageSeconds < -this.freshness) {
      log.debug("dropping future-dated signaling rumor", {
        from: unwrapped.senderPubkey.slice(0, 8),
        ageSeconds,
      });
      return;
    }

    let payload: SignalPayload;
    try {
      payload = JSON.parse(unwrapped.innerContent) as SignalPayload;
    } catch {
      log.warn("malformed signaling payload", { from: unwrapped.senderPubkey.slice(0, 8) });
      return;
    }
    const inbound: IncomingSignal = { from: unwrapped.senderPubkey, payload };
    for (const h of this.handlers) {
      try {
        h(inbound);
      } catch (err) {
        log.error("handler threw on signal", { err: String(err) });
      }
    }
  }

  private markSeen(id: string): void {
    this.seenIds.push(id);
    if (this.seenIds.length > DEDUP_RING_SIZE) this.seenIds.shift();
  }
}
