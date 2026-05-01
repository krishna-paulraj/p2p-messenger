import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDirFor, decodePeerRef } from "./identity.js";
import { makeLogger } from "../util/logger.js";

const log = makeLogger("contacts");

export type Contact = {
  /** Local nickname — used for display + as a CLI handle. */
  alias: string;
  /** Hex-encoded x-only pubkey. */
  pubkey: string;
  /** Optional NIP-05 verification — `name@host`. */
  nip05?: string;
  /** Optional human-readable note. */
  note?: string;
  addedAt: number;
};

type StoredContacts = {
  version: 1;
  contacts: Contact[];
};

export class ContactBook {
  private byAlias = new Map<string, Contact>();
  private byPubkey = new Map<string, Contact>();
  private path: string;

  constructor(opts: { dataDir?: string; ownerAlias: string }) {
    this.path = join(dataDirFor(opts), "contacts", `${opts.ownerAlias}.json`);
    if (existsSync(this.path)) this.load();
  }

  list(): Contact[] {
    return [...this.byAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  }

  byAliasOrUndefined(alias: string): Contact | undefined {
    return this.byAlias.get(alias);
  }

  byPubkeyOrUndefined(pubkey: string): Contact | undefined {
    return this.byPubkey.get(pubkey);
  }

  add(contact: Omit<Contact, "addedAt">): Contact {
    const full: Contact = { ...contact, addedAt: Math.floor(Date.now() / 1000) };
    const existing = this.byAlias.get(full.alias);
    if (existing) this.byPubkey.delete(existing.pubkey);
    this.byAlias.set(full.alias, full);
    this.byPubkey.set(full.pubkey, full);
    this.persist();
    log.info("added contact", { alias: full.alias, pubkey: full.pubkey.slice(0, 8) });
    return full;
  }

  remove(alias: string): boolean {
    const c = this.byAlias.get(alias);
    if (!c) return false;
    this.byAlias.delete(alias);
    this.byPubkey.delete(c.pubkey);
    this.persist();
    return true;
  }

  /** All known contact pubkeys; useful for presence subscriptions. */
  pubkeys(): string[] {
    return [...this.byPubkey.keys()];
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8")) as StoredContacts;
      if (raw.version !== 1) {
        log.warn("unsupported contacts version", { version: raw.version });
        return;
      }
      for (const c of raw.contacts) {
        this.byAlias.set(c.alias, c);
        this.byPubkey.set(c.pubkey, c);
      }
      log.info("loaded contacts", { count: this.byAlias.size });
    } catch (err) {
      log.warn("failed to load contacts", { err: String(err) });
    }
  }

  private persist(): void {
    const stored: StoredContacts = {
      version: 1,
      contacts: this.list(),
    };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }
}

/**
 * Resolve a peer reference (alias | hex pubkey | npub | NIP-05 nip05@host) to a hex pubkey.
 *
 * Order:
 *   1. If it parses as hex/npub, decode directly.
 *   2. If it contains '@', try NIP-05 lookup.
 *   3. Otherwise, look up in the contact book.
 */
export async function resolvePeer(
  ref: string,
  contacts: ContactBook,
): Promise<{ pubkey: string; source: "hex" | "npub" | "nip05" | "contact" }> {
  // Hex or npub?
  try {
    const pubkey = decodePeerRef(ref);
    return { pubkey, source: ref.startsWith("npub1") ? "npub" : "hex" };
  } catch {
    // not a hex/npub
  }

  // NIP-05?
  if (ref.includes("@") && !ref.startsWith("@")) {
    const result = await lookupNip05(ref);
    if (result) return { pubkey: result, source: "nip05" };
    throw new Error(`NIP-05 lookup failed for ${ref}`);
  }

  // Local contact?
  const contact = contacts.byAliasOrUndefined(ref);
  if (contact) return { pubkey: contact.pubkey, source: "contact" };

  throw new Error(
    `cannot resolve "${ref}" — not a hex pubkey, npub, NIP-05 address, or known contact`,
  );
}

/**
 * NIP-05: fetch https://<domain>/.well-known/nostr.json?name=<name>
 * and return the matching hex pubkey, or null if not found.
 */
export async function lookupNip05(addr: string): Promise<string | null> {
  const at = addr.indexOf("@");
  if (at < 1) return null;
  const name = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || !/^[a-zA-Z0-9.-]+$/.test(domain)) return null;
  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      log.warn("nip05 non-2xx", { addr, status: res.status });
      return null;
    }
    const body = (await res.json()) as { names?: Record<string, string> };
    const hex = body.names?.[name];
    if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) return null;
    return hex.toLowerCase();
  } catch (err) {
    log.warn("nip05 fetch failed", { addr, err: String(err) });
    return null;
  }
}
