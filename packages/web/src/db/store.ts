/**
 * Browser persistence layer. Mirrors what the Node CLI's fs-backed stores do
 * (identity, contacts, vector clock, dedup, ratchet states), but in IndexedDB.
 * Keyed simply via idb-keyval to avoid pulling in a heavier ORM.
 *
 * Schema (all under one IndexedDB database, four object stores):
 *   identity   ⇒ { secretHex, publicHex, npub, alias, createdAt } | undefined
 *   contacts   ⇒ Record<alias, { alias, pubkey, addedAt, note? }>
 *   clock      ⇒ Record<peerHex, number>
 *   dedup      ⇒ { drainedAt, recentIds: string[] }
 *   ratchets   ⇒ Record<peerHex, SerializedRatchetState>
 *   messages   ⇒ Record<peerHex, StoredMessage[]>
 *
 * The reads return strongly-typed records. Writes are best-effort flushed
 * with idb-keyval which writes one key at a time.
 */
import { createStore, get, set, del } from "idb-keyval";
import type { SerializedState as SerializedRatchet } from "@p2p/core/browser";

const DB_NAME = "p2p-messenger";
const STORE_NAME = "kv";
const ydb = createStore(DB_NAME, STORE_NAME);

const KEYS = {
  identity: "identity",
  contacts: "contacts",
  clock: "clock",
  dedup: "dedup",
  ratchets: "ratchets",
  messages: "messages",
  relays: "relays",
} as const;

export type StoredIdentity = {
  alias: string;
  publicHex: string;
  /** Hex-encoded 32-byte secp256k1 secret. Stored locally in IDB. */
  secretHex: string;
  npub: string;
  createdAt: number;
};

export type StoredContact = {
  alias: string;
  pubkey: string;
  npub: string;
  addedAt: number;
  note?: string;
};

export type StoredMessage = {
  /** Sender pubkey (hex) for inbound, recipient pubkey for outbound. */
  peer: string;
  direction: "in" | "out";
  text: string;
  /** UNIX seconds. */
  ts: number;
  /** Origin: 'relay' for NIP-17, 'live' for messages we just sent. */
  source: "relay" | "live";
};

export type StoredDedup = {
  drainedAt: number;
  recentIds: string[];
};

// ---- Identity ----

export async function loadIdentity(): Promise<StoredIdentity | undefined> {
  return get<StoredIdentity>(KEYS.identity, ydb);
}

export async function saveIdentity(id: StoredIdentity): Promise<void> {
  await set(KEYS.identity, id, ydb);
}

export async function clearIdentity(): Promise<void> {
  await del(KEYS.identity, ydb);
  // Also clear conversation state — a new identity means we can't decrypt
  // anything from the old one anyway.
  await del(KEYS.clock, ydb);
  await del(KEYS.dedup, ydb);
  await del(KEYS.ratchets, ydb);
  await del(KEYS.messages, ydb);
}

// ---- Contacts ----

export async function loadContacts(): Promise<Record<string, StoredContact>> {
  return (await get<Record<string, StoredContact>>(KEYS.contacts, ydb)) ?? {};
}

export async function saveContacts(c: Record<string, StoredContact>): Promise<void> {
  await set(KEYS.contacts, c, ydb);
}

// ---- Vector clock (per-peer counter) ----

export async function loadClock(): Promise<Record<string, number>> {
  return (await get<Record<string, number>>(KEYS.clock, ydb)) ?? {};
}

export async function saveClock(c: Record<string, number>): Promise<void> {
  await set(KEYS.clock, c, ydb);
}

// ---- Dedup (event-id ring + drain cursor) ----

export async function loadDedup(): Promise<StoredDedup> {
  return (
    (await get<StoredDedup>(KEYS.dedup, ydb)) ?? { drainedAt: 0, recentIds: [] }
  );
}

export async function saveDedup(d: StoredDedup): Promise<void> {
  await set(KEYS.dedup, d, ydb);
}

// ---- Ratchet states (per-peer DR) ----

export async function loadRatchets(): Promise<Record<string, SerializedRatchet>> {
  return (
    (await get<Record<string, SerializedRatchet>>(KEYS.ratchets, ydb)) ?? {}
  );
}

export async function saveRatchets(
  r: Record<string, SerializedRatchet>,
): Promise<void> {
  await set(KEYS.ratchets, r, ydb);
}

// ---- Relay list ----

export async function loadRelays(): Promise<string[] | undefined> {
  return get<string[]>(KEYS.relays, ydb);
}

export async function saveRelays(urls: string[]): Promise<void> {
  await set(KEYS.relays, urls, ydb);
}

// ---- Message history ----

export async function loadMessages(): Promise<Record<string, StoredMessage[]>> {
  return (await get<Record<string, StoredMessage[]>>(KEYS.messages, ydb)) ?? {};
}

export async function saveMessages(
  m: Record<string, StoredMessage[]>,
): Promise<void> {
  await set(KEYS.messages, m, ydb);
}
