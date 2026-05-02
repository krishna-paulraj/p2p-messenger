/**
 * Browser-flavored chat messenger over Nostr relays.
 *
 * Reuses the pure crypto + protocol modules from `@p2p/core` (gift-wrap,
 * Double Ratchet, kinds) but talks to nostr-tools' SimplePool directly and
 * persists state to IndexedDB instead of fs.
 *
 * Two inner-kind-discriminated paths share the same gift-wrap envelope:
 *   - kind 14 (CHAT_MESSAGE) → DR-encrypted chat plaintext, emitted via
 *     `onMessage`. This is the relay fallback path.
 *   - kind 21059 (P2P_SIGNAL) → JSON-encoded WebRTC signaling payload,
 *     emitted via `onSignal`. Used by WebPeer to bootstrap a browser-side
 *     P2P data channel; identical wire format to the CLI's NostrSignaling
 *     so a CLI alice and a browser bob can complete a handshake.
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

/**
 * WebRTC signaling payload arriving from the relay. Emitted to listeners
 * registered via `onSignal` — opaque to the messenger; consumed by WebPeer.
 */
export type IncomingSignal = {
  from: string;
  payload: unknown;
  ts: number;
  eventId: string;
};

/**
 * Reject WebRTC signaling rumors older than this many seconds. Five minutes
 * is generous for clock skew + relay latency while reliably ignoring replays
 * from prior sessions (NIP-59 randomizes the gift-wrap created_at by ±2 days
 * for unlinkability, but the inner rumor preserves the real send time).
 */
const SIGNAL_FRESHNESS_SECONDS = 5 * 60;

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
  private signalListeners = new Set<(s: IncomingSignal) => void>();
  private signalSeenIds = new Set<string>();
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

    this.subscribeNow(since);

    // Eagerly connect to all relays so the user sees an honest 1/1 (or 3/3)
    // status indicator straight away rather than 0/N for the first ~second.
    void this.warmConnections().then(() => this.broadcastRelayStatus());

    // Poll periodically so disconnects + reconnects are reflected.
    setInterval(() => this.broadcastRelayStatus(), 3000);
    this.broadcastRelayStatus();
  }

  /** Current relay set (read-only snapshot). */
  relays(): RelayUrl[] {
    return [...this.opts.relays];
  }

  /**
   * Add a relay at runtime. Resubscribes so the new relay receives historical
   * gift wraps p-tagged for us and live events going forward. No-op if the
   * URL is already present.
   */
  async addRelay(url: string): Promise<void> {
    if (this.opts.relays.includes(url)) return;
    this.opts.relays = [...this.opts.relays, url];
    await this.warmConnections();
    this.resubscribe();
    this.broadcastRelayStatus();
  }

  /** Remove a relay at runtime. Closes its connection on this pool. */
  async removeRelay(url: string): Promise<void> {
    if (!this.opts.relays.includes(url)) return;
    this.opts.relays = this.opts.relays.filter((u) => u !== url);
    try {
      this.pool.close([url]);
    } catch {
      // best-effort
    }
    this.resubscribe();
    this.broadcastRelayStatus();
  }

  private resubscribe(): void {
    this.subCloser?.close();
    const now = Math.floor(Date.now() / 1000);
    const since =
      this.dedup.drainedAt > 0
        ? Math.max(this.dedup.drainedAt - GIFT_WRAP_BACKDATE, now - MAX_LOOKBACK)
        : now - DEFAULT_LOOKBACK;
    this.subscribeNow(since);
  }

  private subscribeNow(since: number): void {
    if (this.opts.relays.length === 0) {
      this.subCloser = undefined;
      return;
    }
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
  }

  onMessage(fn: (msg: IncomingMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onRelayStatus(fn: (open: number, total: number) => void): () => void {
    this.connectListeners.add(fn);
    return () => this.connectListeners.delete(fn);
  }

  onSignal(fn: (s: IncomingSignal) => void): () => void {
    this.signalListeners.add(fn);
    return () => this.signalListeners.delete(fn);
  }

  /**
   * Publish a WebRTC signaling payload (offer / answer / ICE) to the peer
   * via a NIP-59 gift-wrapped kind-21059 (P2P_SIGNAL) event. Same envelope
   * that the CLI's NostrSignaling uses, so a CLI peer can decrypt and
   * dispatch to its own Peer state machine.
   */
  async sendSignal(toPubkey: string, payload: unknown): Promise<SendResult> {
    const wrap = giftWrap({
      innerKind: KINDS.P2P_SIGNAL,
      innerContent: JSON.stringify(payload),
      senderSecret: this.opts.selfSecret,
      recipientPubkey: toPubkey,
    });
    const results = await Promise.allSettled(
      this.pool.publish(this.opts.relays, wrap),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    if (ok === 0) {
      throw new Error(
        `signal publish rejected by all ${this.opts.relays.length} relays`,
      );
    }
    return { eventId: wrap.id };
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

    // Dispatch by inner kind. P2P_SIGNAL flows out to WebPeer (live, never
    // touches DR / chat path); CHAT_MESSAGE continues into the chat pipeline.
    if (unwrapped.innerKind === KINDS.P2P_SIGNAL) {
      this.handleSignalRumor(event.id, unwrapped.senderPubkey, unwrapped.innerContent, unwrapped.rumorCreatedAt);
      return;
    }
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

  /**
   * Handle a P2P_SIGNAL inner rumor. Three layers of defense against
   * replays from a previous browser session: in-memory id ring, a freshness
   * window on the rumor's real created_at (NIP-59 randomizes the wrap's
   * outer ts by ±2 days for unlinkability — only the rumor preserves truth),
   * and per-handler defensive try/catch so signaling errors never crash
   * the messenger.
   */
  private handleSignalRumor(
    eventId: string,
    sender: string,
    innerContent: string,
    rumorTs: number,
  ): void {
    if (this.signalSeenIds.has(eventId)) return;
    this.signalSeenIds.add(eventId);
    if (this.signalSeenIds.size > 1024) {
      // Trim oldest by reconstructing — Set preserves insertion order in JS.
      const trimmed = Array.from(this.signalSeenIds).slice(-512);
      this.signalSeenIds = new Set(trimmed);
    }

    const now = Math.floor(Date.now() / 1000);
    const age = now - rumorTs;
    if (age > SIGNAL_FRESHNESS_SECONDS || age < -SIGNAL_FRESHNESS_SECONDS) {
      return; // stale or future-dated — drop
    }

    let payload: unknown;
    try {
      payload = JSON.parse(innerContent);
    } catch {
      return;
    }
    const signal: IncomingSignal = { from: sender, payload, ts: rumorTs, eventId };
    for (const l of this.signalListeners) {
      try {
        l(signal);
      } catch (err) {
        console.warn("[WebMessenger] signal listener error:", err);
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
    // Use SimplePool's public listConnectionStatus() — returns Map<url,
    // connected>. nostr-tools normalizes URLs (adds default scheme, appends
    // trailing slash) so our raw config strings won't match the map keys
    // by strict equality. Match on the normalized form instead.
    let open = 0;
    try {
      const status = this.pool.listConnectionStatus();
      const wanted = new Set(this.opts.relays.map(normalizeRelayUrl));
      for (const [url, connected] of status) {
        if (!wanted.has(normalizeRelayUrl(url))) continue;
        if (connected) open += 1;
      }
    } catch {
      // listConnectionStatus may throw on older builds; fall back to 0.
    }
    for (const l of this.connectListeners) {
      try {
        l(open, this.opts.relays.length);
      } catch {
        // listener errors are isolated
      }
    }
  }

  /**
   * Eagerly establish connections to every configured relay so the user sees
   * an honest status indicator (open/total) before the first send. Without
   * this the pool only connects lazily on subscribe/publish and the badge
   * spends ~hundreds of ms reading 0/N.
   */
  private async warmConnections(): Promise<void> {
    await Promise.allSettled(
      this.opts.relays.map((url) =>
        this.pool.ensureRelay(url).then((r) => r.connect()).catch(() => undefined),
      ),
    );
  }
}

function makeConversationAad(selfPubkey: string, peerPubkey: string): Uint8Array {
  const [a, b] = [selfPubkey, peerPubkey].sort();
  return new TextEncoder().encode(`${a}|${b}`);
}

/**
 * Mirror nostr-tools' relay-URL normalization (default scheme, lowercased
 * host, collapsed slashes, trailing slash on root). Without this, our raw
 * "ws://localhost:7777" never matches the pool's stored
 * "ws://localhost:7777/".
 */
function normalizeRelayUrl(input: string): string {
  let s = input.trim();
  if (!s.includes("://")) s = `wss://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol === "http:") u.protocol = "ws:";
    else if (u.protocol === "https:") u.protocol = "wss:";
    u.pathname = u.pathname.replace(/\/+/g, "/");
    if (u.pathname === "/") u.pathname = "";
    return `${u.protocol}//${u.host}${u.pathname}${u.pathname ? "" : "/"}`;
  } catch {
    return s;
  }
}
