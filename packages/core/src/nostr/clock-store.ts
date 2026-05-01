import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Clock, VectorClock } from "./vector-clock.js";

type StoredClock = {
  version: 1;
  self: string;
  clock: Clock;
};

/** Load a vector clock from disk, or return a fresh one if missing. */
export function loadClock(path: string, selfPubkey: string): VectorClock {
  if (!existsSync(path)) return new VectorClock(selfPubkey);
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as StoredClock;
    if (raw.version !== 1 || raw.self !== selfPubkey) return new VectorClock(selfPubkey);
    return new VectorClock(selfPubkey, raw.clock);
  } catch {
    return new VectorClock(selfPubkey);
  }
}

/** Persist a vector clock atomically (write file with mode 0600). */
export function saveClock(path: string, clock: VectorClock): void {
  const stored: StoredClock = {
    version: 1,
    self: clock.self,
    clock: clock.snapshot(),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(stored, null, 2), { mode: 0o600 });
}
