/**
 * Stable color hashing for peer names — same input always lands on the same
 * palette slot. Used to color-code messages, avatars, etc.
 */
const PALETTE = [
  "text-peer-1",
  "text-peer-2",
  "text-peer-3",
  "text-peer-4",
  "text-peer-5",
  "text-peer-6",
  "text-peer-7",
  "text-peer-8",
] as const;

export function peerColorClass(seed: string): string {
  if (!seed) return PALETTE[0];
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

export function shortPubkey(hex: string): string {
  if (/^[0-9a-f]{64}$/i.test(hex)) {
    return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
  }
  return hex;
}

export function shortNpub(npub: string): string {
  if (npub.startsWith("npub1") && npub.length > 20) {
    return `${npub.slice(0, 12)}…${npub.slice(-4)}`;
  }
  return npub;
}

export function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
