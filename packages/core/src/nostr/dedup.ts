import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { makeLogger } from "../util/logger.js";

const log = makeLogger("dedup");

type StoredState = {
  version: 1;
  /** Last drained UNIX-seconds cursor — we don't need to refetch wraps older than this. */
  drained_at: number;
  /** Ring of recently-applied event ids (event.id of gift wraps we've consumed). */
  recent_ids: string[];
};

const RING_SIZE = 4096;

export class DedupStore {
  private path: string;
  private state: StoredState;
  private dirty = false;
  private flushTimer?: NodeJS.Timeout;

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as StoredState;
        this.state = raw.version === 1 ? raw : this.empty();
      } catch (err) {
        log.warn("failed to load dedup state, starting fresh", { err: String(err) });
        this.state = this.empty();
      }
    } else {
      this.state = this.empty();
    }
  }

  /** Cursor: floor for offline-queue refetch on startup. */
  drainedAt(): number {
    return this.state.drained_at;
  }

  /** Bump the drain cursor; defer flush. */
  setDrainedAt(seconds: number): void {
    if (seconds <= this.state.drained_at) return;
    this.state.drained_at = seconds;
    this.scheduleFlush();
  }

  hasSeen(eventId: string): boolean {
    return this.state.recent_ids.includes(eventId);
  }

  markSeen(eventId: string): void {
    if (this.state.recent_ids.includes(eventId)) return;
    this.state.recent_ids.push(eventId);
    while (this.state.recent_ids.length > RING_SIZE) this.state.recent_ids.shift();
    this.scheduleFlush();
  }

  flush(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    this.dirty = false;
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flush();
  }

  private empty(): StoredState {
    return { version: 1, drained_at: 0, recent_ids: [] };
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
