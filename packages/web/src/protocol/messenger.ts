/**
 * Browser-flavored chat messenger over Nostr relays.
 *
 * Reuses the pure crypto + protocol modules from `@p2p/core` (gift-wrap,
 * Double Ratchet, kinds) but talks to nostr-tools' SimplePool directly and
 * persists state to IndexedDB instead of fs.
 *
 * Two paths today:
 *   - send(toPubkey, text): DR-encrypts → NIP-17 gift-wrap → publish.
 *   - subscribe → unwrap kind-1059 events → DR-decrypt → emit messages.
 *
 * No WebRTC P2P in v1 (browser-to-browser data channels deferred to v2).
 */

import { SimplePool } from "nostr-tools/pool";
import type { Event as NostrEvent } from "nostr-tools/core";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  drDecrypt,
  drEncrypt,
  KINDS,
  giftUnwrap,
  giftWrap,
  initRatchet,
  serializeRatchetState,
  deserializeRatchetState,
  type DrHeader,
  type RatchetState,
  type SerializedState,
} from "@p2p/core/browser";
import {
  loadDedup,
  loadRatchets,
  saveDedup,
  saveRatchets,
  type StoredDedup,
} from "../db/store";

export type RelayUrl = string;

export type IncomingMessage = {
  /** Sender hex pubkey. */
  from: string;
  text: string;
  /** Inner rumor created_at (UNIX seconds). */
  ts: number;
  /** Underlying gift-wrap event id. */
  eventId: string;
  /** Was this drained from the historical relay window vs received live? */
  fromDrain: boolean;
};

export type MessengerOptions = {
  relays: RelayUrl[];
  selfPubkey: string;
  selfSecret: Uint8Array;
};

export type SendResult = { eventId: string };

const GIFT_WRAP_BACKDATE = 2 * 24 * 60 * 60;
const DEFAULT_LOOKBACK = 7 * 24 * 60 * 60;
const MAX_LOOKBACK = 30 * 24 * 60 * 60;
const DEDUP_RING_MAX = 4096;

export class WebMessenger {
  private pool: SimplePool;
  private opts: MessengerOptions;
  /** In-memory ratchet states; mirrored to IDB on flush. */
  private ratchets = new Map<string, RatchetState>();
  /** Persisted dedup state (drainedAt cursor + recent event ids). */
  private dedup: StoredDedup = { drainedAt: 0, recentIds: [] };
  private dedupSeen = new Set<string>();
  private subCloser?: { close: () => void };
  private listeners = new Set<(msg: IncomingMessage) => void>();
  private connectListeners = new Set<(open: number, total: number) => void>();
  private cursorMaxSeen = 0;
  private flushTimer?: number;

  constructor(opts: MessengerOptions) {
    this.opts = opts;
    this.pool = new SimplePool();
  }

  async start(): Promise<void> {
    // Hydrate persisted state.
    this.dedup = await loadDedup();
    this.dedupSeen = new Set(this.dedup.recentIds);
    const persistedRatchets = await loadRatchets();
    for (const [peer, serialized] of Object.entries(persistedRatchets)) {
      this.ratchets.set(peer, deserializeRatchetState(serialized));
    }

    // Subscribe to gift wraps p-tagged for our pubkey, since the last drain
    // cursor (with NIP-59's ±2-day backdate slack).
    const now = Math.floor(Date.now() / 1000);
    const since =
      this.dedup.drainedAt > 0
        ? Math.max(this.dedup.drainedAt - GIFT_WRAP_BACKDATE, now - MAX_LOOKBACK)
        : now - DEFAULT_LOOKBACK;

    this.subCloser = this.pool.subscribeMany(
      this.opts.relays,
      {
        kinds: [KINDS.GIFT_WRAP],
        "#p": [this.opts.selfPubkey],
        since,
      },
      {
        onevent: (event) => this.onWrap(event),
      },
    );

    // Best-effort relay status polling — we don't have first-class connection
    // events from SimplePool, so periodically check ensureRelay readyState.
    setInterval(() => this.broadcastRelayStatus(), 5000);
    this.broadcastRelayStatus();
  }

  onMessage(fn: (msg: IncomingMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onRelayStatus(fn: (open: number, total: number) => void): () => void {
    this.connectListeners.add(fn);
    return () => this.connectListeners.delete(fn);
  }

  async send(toPubkey: string, text: string): Promise<SendResult> {
    // DR-encrypt the chat plaintext (text + minimal metadata) under the
    // per-peer ratchet. Mirrors the OfflineMessenger v=2 envelope so a CLI
    // user can decrypt browser-sent messages and vice versa.
    const drPlaintext = new TextEncoder().encode(JSON.stringify({ text }));
    const ratchet = this.ensureRatchet(toPubkey);
    const aad = makeConversationAad(this.opts.selfPubkey, toPubkey);
    const enc = drEncrypt(ratchet, drPlaintext, aad);
    this.scheduleRatchetFlush();

    const innerContent = JSON.stringify({
      v: 2,
      h: {
        p: bytesToHex(enc.header.dhPub),
        n: enc.header.counter,
        pn: enc.header.prevChainCounter,
      },
      c: bytesToHex(enc.ciphertext),
    });

    const wrap = giftWrap({
      innerKind: KINDS.CHAT_MESSAGE,
      innerContent,
      innerTags: [["p", toPubkey]],
      senderSecret: this.opts.selfSecret,
      recipientPubkey: toPubkey,
    });

    // Publish to all relays — at least one must accept.
    const results = await Promise.allSettled(this.pool.publish(this.opts.relays, wrap));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    if (ok === 0) {
      throw new Error(`publish rejected by all ${this.opts.relays.length} relays`);
    }
    return { eventId: wrap.id };
  }

  async close(): Promise<void> {
    this.subCloser?.close();
    this.pool.close(this.opts.relays);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await this.flushAll();
  }

  // ---- Internal ----

  private async onWrap(event: NostrEvent): Promise<void> {
    if (this.dedupSeen.has(event.id)) return;
    const unwrapped = giftUnwrap(event, this.opts.selfSecret);
    if (!unwrapped) return;
    if (unwrapped.innerKind !== KINDS.CHAT_MESSAGE) return;

    let envelope: {
      v?: unknown;
      h?: { p?: unknown; n?: unknown; pn?: unknown };
      c?: unknown;
    };
    try {
      envelope = JSON.parse(unwrapped.innerContent);
    } catch {
      return;
    }
    if (
      envelope.v !== 2 ||
      !envelope.h ||
      typeof envelope.h.p !== "string" ||
      typeof envelope.h.n !== "number" ||
      typeof envelope.h.pn !== "number" ||
      typeof envelope.c !== "string"
    ) {
      return;
    }

    const ratchet = this.ensureRatchet(unwrapped.senderPubkey);
    const aad = makeConversationAad(this.opts.selfPubkey, unwrapped.senderPubkey);
    const header: DrHeader = {
      dhPub: hexToBytes(envelope.h.p),
      counter: envelope.h.n,
      prevChainCounter: envelope.h.pn,
    };
    let plaintext: Uint8Array;
    try {
      plaintext = drDecrypt(ratchet, header, hexToBytes(envelope.c), aad);
    } catch {
      // Bad MAC, replay, or out-of-window — drop silently.
      return;
    }
    this.scheduleRatchetFlush();

    let parsed: { text?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      return;
    }
    if (typeof parsed.text !== "string") return;

    // Mark as seen + advance drain cursor.
    this.markSeen(event.id);
    if (unwrapped.rumorCreatedAt > this.cursorMaxSeen) {
      this.cursorMaxSeen = unwrapped.rumorCreatedAt;
      this.dedup.drainedAt = this.cursorMaxSeen;
      this.scheduleDedupFlush();
    }

    const fromDrain =
      unwrapped.rumorCreatedAt < Math.floor(Date.now() / 1000) - 30;
    const msg: IncomingMessage = {
      from: unwrapped.senderPubkey,
      text: parsed.text,
      ts: unwrapped.rumorCreatedAt,
      eventId: event.id,
      fromDrain,
    };
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch {
        // listener errors are isolated
      }
    }
  }

  private ensureRatchet(peerPubkey: string): RatchetState {
    let r = this.ratchets.get(peerPubkey);
    if (r) return r;
    r = initRatchet({
      selfPubkeyHex: this.opts.selfPubkey,
      selfSecret: this.opts.selfSecret,
      peerPubkeyHex: peerPubkey,
    });
    this.ratchets.set(peerPubkey, r);
    return r;
  }

  private markSeen(eventId: string): void {
    if (this.dedupSeen.has(eventId)) return;
    this.dedupSeen.add(eventId);
    this.dedup.recentIds.push(eventId);
    while (this.dedup.recentIds.length > DEDUP_RING_MAX) this.dedup.recentIds.shift();
    this.scheduleDedupFlush();
  }

  private scheduleDedupFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushAll();
    }, 500);
  }

  private scheduleRatchetFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushAll();
    }, 500);
  }

  private async flushAll(): Promise<void> {
    const serialized: Record<string, SerializedState> = {};
    for (const [peer, state] of this.ratchets) {
      serialized[peer] = serializeRatchetState(state);
    }
    await Promise.all([saveRatchets(serialized), saveDedup(this.dedup)]);
  }

  private broadcastRelayStatus(): void {
    // SimplePool exposes `ensureRelay`; check `connected` on each.
    let open = 0;
    for (const url of this.opts.relays) {
      try {
        const relay = (this.pool as unknown as { relays: Map<string, { connected: boolean }> })
          .relays?.get(url);
        if (relay?.connected) open += 1;
      } catch {
        // ignore probing errors
      }
    }
    for (const l of this.connectListeners) {
      try {
        l(open, this.opts.relays.length);
      } catch {
        // listener errors are isolated
      }
    }
  }
}

function makeConversationAad(selfPubkey: string, peerPubkey: string): Uint8Array {
  const [a, b] = [selfPubkey, peerPubkey].sort();
  return new TextEncoder().encode(`${a}|${b}`);
}
