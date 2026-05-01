import { createHash } from "node:crypto";

/**
 * Consistent peer color via a simple hash → palette index. Same peer always
 * gets the same color across sessions and across the room.
 */
const PALETTE = [
  "cyan",
  "magenta",
  "yellow",
  "green",
  "blue",
  "redBright",
  "greenBright",
  "yellowBright",
  "blueBright",
  "magentaBright",
  "cyanBright",
] as const;

export type PaletteColor = (typeof PALETTE)[number];

export function colorFor(seed: string): PaletteColor {
  if (!seed) return PALETTE[0];
  const digest = createHash("sha256").update(seed).digest();
  const idx = digest[0] % PALETTE.length;
  return PALETTE[idx];
}

export function shortPubkey(hex: string): string {
  if (/^[0-9a-f]{64}$/i.test(hex)) return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
  return hex;
}

export function timeFmt(ts: number): string {
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
