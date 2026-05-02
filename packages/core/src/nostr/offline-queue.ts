import type { Event as NostrEvent } from "nostr-tools/core";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { giftUnwrap, giftWrap } from "./gift-wrap.js";
import { KINDS } from "./kinds.js";
import type { RelayPool, SubscriptionHandle } from "./relay-pool.js";
import { type Clock, VectorClock, compareClocks } from "./vector-clock.js";
import { DedupStore } from "./dedup.js";
import { makeLogger } from "../util/logger.js";
import type { RatchetStore } from "./ratchet/store.js";
import {
  decrypt as drDecrypt,
  encrypt as drEncrypt,
  type Header as DrHeader,
} from "./ratchet/double-ratchet.js";

const log = makeLogger("offline-queue");

export type OfflineMessage = {
  /** Sender pubkey, verified via NIP-44 unwrap. */
  from: string;
  /** Plaintext message body. */
  text: string;
  /** Sender's vector clock at send time. */
  clock: Clock;
  /** Inner rumor created_at (UNIX seconds). */
  ts: number;
  /** Underlying gift-wrap event id (used for dedup). */
  eventId: string;
  /**
   * True if this message arrived during the initial drain phase (i.e. it was
   * stored on relays before we connected). False for live messages received
   * after EOSE. UI may render these differently.
   */
  fromDrain: boolean;
};

export type OfflineMessengerOptions = {
  pool: RelayPool;
  selfPubkey: string;
  selfSecret: Uint8Array;
  /** Persistent dedup + drain cursor (typically lives at $dataDir/offline/$alias.json). */
  dedup: DedupStore;
  /** Vector clock — initialize from persisted state if available. */
  clock: VectorClock;
  /** Per-peer Double Ratchet state store. */
  ratchetStore: RatchetStore;
  /** Lookback window in seconds for the initial drain on startup. */
  drainLookbackSeconds?: number;
  /** Backstop floor for created_at filter (default 30 days). */
  maxLookbackSeconds?: number;
  /**
   * After the relay's first EOSE, wait this many ms for any in-flight events
   * to settle, then end the drain phase. Default 250ms — long enough for
   * ordered relays to deliver any final stragglers.
   */
  drainSettleMs?: number;
  /** Hard ceiling on drain duration; fallback if EOSE never arrives. */
  drainHardTimeoutMs?: number;
};

const DEFAULT_DRAIN_LOOKBACK = 7 * 24 * 60 * 60; // 7 days
const DEFAULT_MAX_LOOKBACK = 30 * 24 * 60 * 60; // 30 days
const GIFT_WRAP_BACKDATE = 2 * 24 * 60 * 60; // per NIP-59
const DEFAULT_DRAIN_SETTLE_MS = 250;
const DEFAULT_DRAIN_HARD_TIMEOUT_MS = 5000;

/**
 * OfflineMessenger: relay-backed, NIP-17 gift-wrapped messaging for store-and-forward
 * delivery when peers are offline.
 *
 * Lifecycle:
 *   1. start() opens a subscription with `since` set to drainCursor − backdate slack.
 *   2. Drain phase: messages received before the relay's first EOSE (+settle window)
 *      are accumulated in a buffer and NOT emitted to listeners yet.
 *   3. End-of-drain: buffered messages are sorted by vector clock (with `ts` and
 *      `eventId` tiebreakers) and emitted in causal order.
 *   4. Live phase: subsequent messages emit immediately on arrival.
 *
 * Why buffering: Nostr relays do not guarantee delivery order; a peer who sent
 * three messages while we were offline will see them arrive at us in arbitrary
 * order. We use the sender's attached vector clock to restore the causal order
 * the user saw on the sender side.
 */
export class OfflineMessenger {
  private opts: OfflineMessengerOptions;
  private sub?: SubscriptionHandle;
  private listeners = new Set<(msg: OfflineMessage) => void>();
  private started = false;
  private closed = false;
  private cursorMaxSeen = 0;

  /** True between start() and end-of-drain. */
  private draining = true;
  private drainBuffer: OfflineMessage[] = [];
  private drainSettleTimer?: NodeJS.Timeout;
  private drainHardTimer?: NodeJS.Timeout;

  constructor(opts: OfflineMessengerOptions) {
    this.opts = opts;
  }

  on(listener: (msg: OfflineMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.draining = true;

    const drained = this.opts.dedup.drainedAt();
    const now = Math.floor(Date.now() / 1000);
    const lookback = this.opts.drainLookbackSeconds ?? DEFAULT_DRAIN_LOOKBACK;
    const maxLookback = this.opts.maxLookbackSeconds ?? DEFAULT_MAX_LOOKBACK;
    const since =
      drained > 0
        ? Math.max(drained - GIFT_WRAP_BACKDATE, now - maxLookback)
        : now - lookback;

    log.info("draining offline queue", {
      since,
      drainedAt: drained,
      windowSeconds: now - since,
    });

    const settleMs = this.opts.drainSettleMs ?? DEFAULT_DRAIN_SETTLE_MS;
    const hardTimeoutMs = this.opts.drainHardTimeoutMs ?? DEFAULT_DRAIN_HARD_TIMEOUT_MS;

    this.sub = this.opts.pool.subscribe(
      [
        {
          kinds: [KINDS.GIFT_WRAP],
          "#p": [this.opts.selfPubkey],
          since,
        },
      ],
      {
        onevent: (event) => this.onWrap(event),
        oneose: () => {
          // First EOSE → schedule drain settle. Additional EOSEs (other relays)
          // simply re-arm the settle timer to wait the same grace period from
          // the latest EOSE, giving stragglers a chance.
          if (this.drainSettleTimer) clearTimeout(this.drainSettleTimer);
          this.drainSettleTimer = setTimeout(() => this.endDrain("eose"), settleMs);
        },
      },
    );

    // Hard ceiling — never let drain stay open forever if EOSE never arrives.
    this.drainHardTimer = setTimeout(() => this.endDrain("hard-timeout"), hardTimeoutMs);
  }

  async send(toPubkey: string, text: string): Promise<{ eventId: string; clock: Clock }> {
    if (!this.started) throw new Error("OfflineMessenger.send before start()");
    if (this.closed) throw new Error("OfflineMessenger is closed");

    const clock = this.opts.clock.tick();
    const drPlaintext = new TextEncoder().encode(JSON.stringify({ text, clock }));

    // Get or initialize the Double Ratchet for this peer; encrypt under its
    // current sending chain. Vector clock is part of the DR plaintext so it
    // gets the same FS guarantees as the message body.
    const state = this.opts.ratchetStore.getOrInit({
      selfPubkeyHex: this.opts.selfPubkey,
      selfSecret: this.opts.selfSecret,
      peerPubkeyHex: toPubkey,
    });
    const aad = makeConversationAad(this.opts.selfPubkey, toPubkey);
    const enc = drEncrypt(state, drPlaintext, aad);
    this.opts.ratchetStore.touch(toPubkey);

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
    await this.opts.pool.publish(wrap);
    log.debug("offline send published", {
      to: toPubkey.slice(0, 8),
      eventId: wrap.id,
      counter: enc.header.counter,
      clock,
    });
    return { eventId: wrap.id, clock };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.drainSettleTimer) clearTimeout(this.drainSettleTimer);
    if (this.drainHardTimer) clearTimeout(this.drainHardTimer);
    // Flush anything still in the buffer so we don't lose data on shutdown.
    if (this.draining) this.endDrain("close");
    this.sub?.close();
    if (this.cursorMaxSeen > this.opts.dedup.drainedAt()) {
      this.opts.dedup.setDrainedAt(this.cursorMaxSeen);
    }
    this.opts.dedup.flush();
  }

  private onWrap(event: NostrEvent): void {
    if (this.opts.dedup.hasSeen(event.id)) return;
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
      log.warn("malformed chat content", { from: unwrapped.senderPubkey.slice(0, 8) });
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
      log.warn("unsupported chat envelope", {
        from: unwrapped.senderPubkey.slice(0, 8),
        version: envelope.v,
      });
      return;
    }

    // Decrypt via the per-peer Double Ratchet. Bootstrap on first contact —
    // both sides derive identical initial state from static-static SK.
    const state = this.opts.ratchetStore.getOrInit({
      selfPubkeyHex: this.opts.selfPubkey,
      selfSecret: this.opts.selfSecret,
      peerPubkeyHex: unwrapped.senderPubkey,
    });
    const aad = makeConversationAad(this.opts.selfPubkey, unwrapped.senderPubkey);
    const header: DrHeader = {
      dhPub: hexToBytes(envelope.h.p),
      counter: envelope.h.n,
      prevChainCounter: envelope.h.pn,
    };
    let plaintext: Uint8Array;
    try {
      plaintext = drDecrypt(state, header, hexToBytes(envelope.c), aad);
      this.opts.ratchetStore.touch(unwrapped.senderPubkey);
    } catch (err) {
      log.warn("ratchet decrypt failed", {
        from: unwrapped.senderPubkey.slice(0, 8),
        err: String(err),
      });
      return;
    }

    let parsed: { text?: unknown; clock?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      log.warn("malformed plaintext after ratchet decrypt", {
        from: unwrapped.senderPubkey.slice(0, 8),
      });
      return;
    }
    if (typeof parsed.text !== "string") return;
    const clock: Clock =
      parsed.clock && typeof parsed.clock === "object"
        ? sanitizeClock(parsed.clock as Record<string, unknown>)
        : {};

    // Persistence-side bookkeeping is fire-and-forget — independent of when
    // we choose to surface the message to the consumer.
    this.opts.dedup.markSeen(event.id);
    if (unwrapped.rumorCreatedAt > this.cursorMaxSeen) {
      this.cursorMaxSeen = unwrapped.rumorCreatedAt;
      this.opts.dedup.setDrainedAt(this.cursorMaxSeen);
    }

    const msg: OfflineMessage = {
      from: unwrapped.senderPubkey,
      text: parsed.text,
      clock,
      ts: unwrapped.rumorCreatedAt,
      eventId: event.id,
      fromDrain: this.draining,
    };

    if (this.draining) {
      this.drainBuffer.push(msg);
      // Each new event during drain extends the settle window so a burst
      // of stragglers doesn't get split across drain/live boundaries.
      const settleMs = this.opts.drainSettleMs ?? DEFAULT_DRAIN_SETTLE_MS;
      if (this.drainSettleTimer) clearTimeout(this.drainSettleTimer);
      this.drainSettleTimer = setTimeout(() => this.endDrain("event-settle"), settleMs);
      log.debug("buffered during drain", {
        from: msg.from.slice(0, 8),
        eventId: msg.eventId,
      });
      return;
    }

    // Live message — observe & emit immediately.
    this.opts.clock.observe(clock);
    log.debug("offline received (live)", {
      from: msg.from.slice(0, 8),
      ts: msg.ts,
      eventId: msg.eventId,
    });
    this.emit(msg);
  }

  private endDrain(reason: string): void {
    if (!this.draining) return;
    this.draining = false;
    if (this.drainSettleTimer) clearTimeout(this.drainSettleTimer);
    if (this.drainHardTimer) clearTimeout(this.drainHardTimer);

    if (this.drainBuffer.length === 0) {
      log.info("drain complete (empty)", { reason });
      return;
    }

    // Causal sort: a < b iff a happens-before b.
    // Tiebreakers (deterministic): rumor ts, then eventId — so two peers seeing
    // the same drain set produce the same display order.
    this.drainBuffer.sort((a, b) => {
      const cmp = compareClocks(a.clock, b.clock);
      if (cmp === "before") return -1;
      if (cmp === "after") return 1;
      if (a.ts !== b.ts) return a.ts - b.ts;
      return a.eventId.localeCompare(b.eventId);
    });

    log.info("drain complete — flushing in causal order", {
      reason,
      count: this.drainBuffer.length,
    });
    for (const msg of this.drainBuffer) {
      this.opts.clock.observe(msg.clock);
      this.emit(msg);
    }
    this.drainBuffer = [];
  }

  private emit(msg: OfflineMessage): void {
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch (err) {
        log.error("listener threw", { err: String(err) });
      }
    }
  }
}

function sanitizeClock(raw: Record<string, unknown>): Clock {
  const out: Clock = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && /^[0-9a-f]{64}$/i.test(k)) {
      out[k.toLowerCase()] = Math.floor(v);
    }
  }
  return out;
}

/**
 * Conversation-binding AAD: stable across both peers (sorted pubkey pair).
 * Used as additional authenticated data on the AEAD so a stolen ciphertext
 * can't be decrypted in the context of any other conversation.
 */
function makeConversationAad(selfPubkey: string, peerPubkey: string): Uint8Array {
  const [a, b] = [selfPubkey, peerPubkey].sort();
  return new TextEncoder().encode(`${a}|${b}`);
}
