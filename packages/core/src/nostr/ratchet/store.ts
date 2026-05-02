import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDirFor } from "../identity.js";
import { makeLogger } from "../../util/logger.js";
import {
  type RatchetState,
  type SerializedState,
  deserializeState,
  initRatchet,
  serializeState,
} from "./double-ratchet.js";

const log = makeLogger("ratchet-store");

type StoredBook = {
  version: 1;
  /** peerPubkeyHex → SerializedState. */
  ratchets: Record<string, SerializedState>;
};

/**
 * Per-local-user persistence for Double Ratchet states, one per remote peer.
 *
 * Treat the on-disk file like the identity file (mode 0600 / 0700 dir).
 * Losing it means losing the ability to decrypt in-flight messages from
 * peers — peers can recover by re-bootstrapping (next message from them
 * re-runs the static-static init derivation, advancing both sides into a
 * fresh ratchet).
 *
 * In-memory: a Map<peerPubkey, RatchetState> holds live state, mutated by
 * encrypt/decrypt. Debounced flush back to disk after every change keeps
 * the persisted copy reasonably current without blocking on every keystroke.
 */
export class RatchetStore {
  private path: string;
  private states = new Map<string, RatchetState>();
  private dirty = false;
  private flushTimer?: NodeJS.Timeout;

  constructor(opts: { dataDir?: string; ownerAlias: string }) {
    this.path = join(dataDirFor(opts), "ratchet", `${opts.ownerAlias}.json`);
    if (existsSync(this.path)) this.load();
  }

  /**
   * Get (or lazily initialize) the ratchet state for a peer. Initialization
   * runs the deterministic static-static bootstrap — both peers, given each
   * other's long-term keys, will derive identical RK / chain seeds.
   */
  getOrInit(opts: {
    selfPubkeyHex: string;
    selfSecret: Uint8Array;
    peerPubkeyHex: string;
  }): RatchetState {
    let state = this.states.get(opts.peerPubkeyHex);
    if (state) return state;
    state = initRatchet(opts);
    this.states.set(opts.peerPubkeyHex, state);
    this.scheduleFlush();
    log.info("initialized ratchet", {
      peer: opts.peerPubkeyHex.slice(0, 8),
      isInitiator: opts.selfPubkeyHex < opts.peerPubkeyHex,
    });
    return state;
  }

  /** Mark the live state for `peerPubkeyHex` as dirty so the next flush serializes it. */
  touch(peerPubkeyHex: string): void {
    if (!this.states.has(peerPubkeyHex)) return;
    this.scheduleFlush();
  }

  /**
   * Drop a peer's ratchet state — used for "reset conversation" affordances
   * if state ever gets desynced. Subsequent encrypts/decrypts will trigger
   * a fresh bootstrap from static-static SK.
   */
  forget(peerPubkeyHex: string): void {
    if (!this.states.delete(peerPubkeyHex)) return;
    this.scheduleFlush();
  }

  flush(): void {
    if (!this.dirty) return;
    const book: StoredBook = { version: 1, ratchets: {} };
    for (const [peer, state] of this.states) {
      book.ratchets[peer] = serializeState(state);
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(book, null, 2), { mode: 0o600 });
    this.dirty = false;
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flush();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8")) as StoredBook;
      if (raw.version !== 1) {
        log.warn("unsupported ratchet book version", { version: raw.version });
        return;
      }
      for (const [peer, ser] of Object.entries(raw.ratchets)) {
        this.states.set(peer, deserializeState(ser));
      }
      log.info("loaded ratchet states", { count: this.states.size });
    } catch (err) {
      log.warn("failed to load ratchet states", { err: String(err) });
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 250);
  }
}
