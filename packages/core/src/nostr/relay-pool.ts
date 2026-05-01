import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import type { Event as NostrEvent } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import WebSocket from "ws";
import { makeLogger } from "../util/logger.js";

useWebSocketImplementation(WebSocket as unknown as typeof globalThis.WebSocket);

const log = makeLogger("relay-pool");

export type RelayUrl = string;

export type SubscriptionHandle = {
  close(): void;
};

export type SubscribeOptions = {
  onevent: (event: NostrEvent, fromRelay: RelayUrl) => void;
  oneose?: () => void;
  onclose?: (reasons: string[]) => void;
};

export type PublishOutcome = {
  url: RelayUrl;
  ok: boolean;
  reason?: string;
};

export class RelayPool {
  private pool = new SimplePool();
  private urls: RelayUrl[];
  private closed = false;

  constructor(urls: RelayUrl[]) {
    if (urls.length === 0) throw new Error("RelayPool requires at least one relay url");
    this.urls = [...new Set(urls)];
  }

  get relays(): readonly RelayUrl[] {
    return this.urls;
  }

  /**
   * Publish to all relays. Returns per-relay outcomes; succeeds overall if at least
   * one relay accepts. Throws only if every relay rejects.
   */
  async publish(event: NostrEvent): Promise<PublishOutcome[]> {
    if (this.closed) throw new Error("relay pool is closed");
    const promises = this.pool.publish(this.urls, event);
    const outcomes = await Promise.all(
      promises.map(async (p, i) => {
        const url = this.urls[i];
        try {
          await p;
          return { url, ok: true } satisfies PublishOutcome;
        } catch (err) {
          return { url, ok: false, reason: String(err) } satisfies PublishOutcome;
        }
      }),
    );
    const okCount = outcomes.filter((o) => o.ok).length;
    if (okCount === 0) {
      log.error("publish failed on every relay", {
        eventId: event.id,
        outcomes,
      });
      throw new Error(`publish rejected by all ${this.urls.length} relays`);
    }
    log.debug("published", {
      eventId: event.id,
      kind: event.kind,
      ok: okCount,
      total: this.urls.length,
    });
    return outcomes;
  }

  /**
   * Subscribe across all relays, dedup events by id so the consumer sees each event
   * once even when multiple relays carry it. Accepts an array of filters (OR semantics);
   * each is opened as a separate subscription against the pool.
   */
  subscribe(filters: Filter[], opts: SubscribeOptions): SubscriptionHandle {
    if (this.closed) throw new Error("relay pool is closed");
    // Per-subscription dedup so the same event-id seen across N relays is only emitted
    // once to this caller. Subscriptions are independent of each other.
    const seenInThisSub = new LRUSet<string>(2000);
    const subClosers = filters.map((filter) =>
      this.pool.subscribeMany(this.urls, filter, {
        onevent: (event) => {
          if (seenInThisSub.has(event.id)) return;
          seenInThisSub.add(event.id);
          opts.onevent(event, "<deduped>");
        },
        oneose: () => opts.oneose?.(),
        onclose: (reasons) => opts.onclose?.(reasons),
      }),
    );
    return {
      close: () => {
        for (const c of subClosers) c.close();
      },
    };
  }

  /**
   * One-shot fetch: return all matching events from any relay until EOSE on each.
   * Useful for profile/presence lookups.
   */
  async fetch(filters: Filter[], timeoutMs = 3000): Promise<NostrEvent[]> {
    if (this.closed) throw new Error("relay pool is closed");
    const events: NostrEvent[] = [];
    const seen = new Set<string>();
    return new Promise((resolve) => {
      let pending = filters.length;
      const handles = filters.map((filter) =>
        this.pool.subscribeMany(this.urls, filter, {
          onevent: (e) => {
            if (seen.has(e.id)) return;
            seen.add(e.id);
            events.push(e);
          },
          oneose: () => {
            pending -= 1;
            if (pending <= 0) {
              for (const h of handles) h.close();
              resolve(events);
            }
          },
        }),
      );
      setTimeout(() => {
        for (const h of handles) h.close();
        resolve(events);
      }, timeoutMs);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pool.close(this.urls);
  }
}

class LRUSet<T> {
  private map = new Map<T, true>();
  constructor(private max: number) {}
  has(v: T): boolean {
    return this.map.has(v);
  }
  add(v: T): void {
    if (this.map.has(v)) {
      this.map.delete(v);
    } else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(v, true);
  }
}
