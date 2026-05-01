/**
 * Lamport-vector clock for messaging causality.
 *
 *   clock = { peerId: counter, ... }
 *
 * On send: increment self counter, attach current clock to message.
 * On receive: merge per-peer max, then increment self by max(localSelf, remoteSelf) + 1.
 *
 * Compare(A, B):
 *   - "equal"      iff A and B have identical entries
 *   - "before"     iff every B[k] >= A[k] and at least one B[k] > A[k]
 *   - "after"      iff every A[k] >= B[k] and at least one A[k] > B[k]
 *   - "concurrent" otherwise
 *
 * For 1:1 chat this collapses to a Lamport scalar in practice, but the data shape
 * is the same one we'll use for groups in Phase 4 — so we build it once now.
 */
export type Clock = Record<string, number>;

export type ClockOrder = "before" | "after" | "equal" | "concurrent";

export class VectorClock {
  private clock: Clock;
  constructor(
    public readonly self: string,
    initial: Clock = {},
  ) {
    this.clock = { ...initial };
  }

  snapshot(): Clock {
    return { ...this.clock };
  }

  get(peer: string): number {
    return this.clock[peer] ?? 0;
  }

  /** Increment self before producing an outgoing message. Returns the new clock. */
  tick(): Clock {
    this.clock[this.self] = (this.clock[this.self] ?? 0) + 1;
    return this.snapshot();
  }

  /** Merge an incoming clock and advance self past it. */
  observe(incoming: Clock): void {
    for (const [peer, ctr] of Object.entries(incoming)) {
      this.clock[peer] = Math.max(this.clock[peer] ?? 0, ctr);
    }
    this.clock[this.self] = (this.clock[this.self] ?? 0) + 1;
  }
}

export function compareClocks(a: Clock, b: Clock): ClockOrder {
  let aHasGreater = false;
  let bHasGreater = false;
  const peers = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const p of peers) {
    const av = a[p] ?? 0;
    const bv = b[p] ?? 0;
    if (av > bv) aHasGreater = true;
    else if (bv > av) bHasGreater = true;
  }
  if (!aHasGreater && !bHasGreater) return "equal";
  if (aHasGreater && bHasGreater) return "concurrent";
  return aHasGreater ? "after" : "before";
}
