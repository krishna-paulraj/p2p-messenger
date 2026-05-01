import { finalizeEvent } from "nostr-tools/pure";
import type { Event as NostrEvent } from "nostr-tools/core";
import { KINDS, PRESENCE_D_TAG } from "./kinds.js";
import type { RelayPool, SubscriptionHandle } from "./relay-pool.js";
import { makeLogger } from "../util/logger.js";

const log = makeLogger("presence");

export type PresenceSnapshot = {
  pubkey: string;
  status: "online" | "offline";
  /** UNIX seconds, from event.created_at — used for freshness. */
  ts: number;
  capabilities: string[];
};

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_FRESHNESS_MS = 75_000;

export type PresenceOptions = {
  pool: RelayPool;
  secretKey: Uint8Array;
  publicKey: string;
  /** ms between heartbeats. */
  heartbeatMs?: number;
  /** Capabilities advertised; e.g. ["webrtc"]. */
  capabilities?: string[];
};

/**
 * PresencePublisher: keeps publishing kind 30078 PRE events until stopped, then
 * publishes a final "offline" event on stop.
 */
export class PresencePublisher {
  private interval?: NodeJS.Timeout;
  private opts: Required<PresenceOptions>;
  private running = false;

  constructor(opts: PresenceOptions) {
    this.opts = {
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      capabilities: ["webrtc"],
      ...opts,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.publish("online");
    this.interval = setInterval(() => {
      this.publish("online").catch((err) =>
        log.warn("heartbeat failed", { err: String(err) }),
      );
    }, this.opts.heartbeatMs);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    try {
      await this.publish("offline");
    } catch (err) {
      log.warn("offline publish failed", { err: String(err) });
    }
  }

  private async publish(status: "online" | "offline"): Promise<NostrEvent> {
    const event = finalizeEvent(
      {
        kind: KINDS.P2P_PRESENCE,
        content: JSON.stringify({
          status,
          capabilities: this.opts.capabilities,
        }),
        tags: [
          ["d", PRESENCE_D_TAG],
          ["status", status],
        ],
        created_at: Math.floor(Date.now() / 1000),
      },
      this.opts.secretKey,
    );
    await this.opts.pool.publish(event);
    log.debug("presence", { status, pubkey: event.pubkey.slice(0, 8) });
    return event;
  }
}

/**
 * PresenceWatcher: subscribes to PRE events for a watchlist, exposes per-pubkey
 * last-seen snapshots and a freshness check.
 */
export class PresenceWatcher {
  private latest = new Map<string, PresenceSnapshot>();
  private listeners = new Set<(snapshot: PresenceSnapshot) => void>();
  private sub?: SubscriptionHandle;
  private freshnessMs: number;

  constructor(
    private pool: RelayPool,
    freshness = DEFAULT_FRESHNESS_MS,
  ) {
    this.freshnessMs = freshness;
  }

  on(listener: (snapshot: PresenceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  watch(pubkeys: string[]): void {
    this.sub?.close();
    if (pubkeys.length === 0) return;
    this.sub = this.pool.subscribe(
      [
        {
          kinds: [KINDS.P2P_PRESENCE],
          authors: pubkeys,
          "#d": [PRESENCE_D_TAG],
        },
      ],
      {
        onevent: (event) => this.absorb(event),
      },
    );
    log.info("watching presence", { count: pubkeys.length });
  }

  /** Snapshot of who we believe is online right now. */
  online(): PresenceSnapshot[] {
    const now = Math.floor(Date.now() / 1000);
    const out: PresenceSnapshot[] = [];
    for (const snap of this.latest.values()) {
      if (snap.status === "online" && now - snap.ts <= this.freshnessMs / 1000) {
        out.push(snap);
      }
    }
    return out;
  }

  isOnline(pubkey: string): boolean {
    const snap = this.latest.get(pubkey);
    if (!snap || snap.status !== "online") return false;
    const now = Math.floor(Date.now() / 1000);
    return now - snap.ts <= this.freshnessMs / 1000;
  }

  lastSeen(pubkey: string): PresenceSnapshot | undefined {
    return this.latest.get(pubkey);
  }

  close(): void {
    this.sub?.close();
  }

  private absorb(event: NostrEvent): void {
    let parsed: { status?: string; capabilities?: string[] };
    try {
      parsed = JSON.parse(event.content);
    } catch {
      return;
    }
    if (parsed.status !== "online" && parsed.status !== "offline") return;
    const prev = this.latest.get(event.pubkey);
    if (prev && prev.ts >= event.created_at) return; // stale
    const snapshot: PresenceSnapshot = {
      pubkey: event.pubkey,
      status: parsed.status,
      ts: event.created_at,
      capabilities: parsed.capabilities ?? [],
    };
    this.latest.set(event.pubkey, snapshot);
    for (const l of this.listeners) l(snapshot);
  }
}
