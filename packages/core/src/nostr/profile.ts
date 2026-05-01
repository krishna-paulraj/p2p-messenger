import { finalizeEvent } from "nostr-tools/pure";
import type { Event as NostrEvent } from "nostr-tools/core";
import { KINDS } from "./kinds.js";
import type { RelayPool } from "./relay-pool.js";
import { makeLogger } from "../util/logger.js";

const log = makeLogger("profile");

export type Profile = {
  pubkey: string;
  name?: string;
  about?: string;
  picture?: string;
  /** UNIX seconds — when the profile was last updated. */
  updatedAt: number;
};

/** Publish a kind 0 profile metadata event. Replaces any prior. */
export async function publishProfile(opts: {
  pool: RelayPool;
  secretKey: Uint8Array;
  profile: { name?: string; about?: string; picture?: string };
}): Promise<NostrEvent> {
  const content = JSON.stringify(opts.profile);
  const event = finalizeEvent(
    {
      kind: KINDS.PROFILE,
      content,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    },
    opts.secretKey,
  );
  await opts.pool.publish(event);
  log.info("published profile", { pubkey: event.pubkey, name: opts.profile.name });
  return event;
}

/** Fetch profiles for a list of pubkeys. Returns most recent per pubkey. */
export async function fetchProfiles(
  pool: RelayPool,
  pubkeys: string[],
  timeoutMs = 3000,
): Promise<Map<string, Profile>> {
  if (pubkeys.length === 0) return new Map();
  const events = await pool.fetch(
    [{ kinds: [KINDS.PROFILE], authors: pubkeys, limit: pubkeys.length * 2 }],
    timeoutMs,
  );
  const out = new Map<string, Profile>();
  for (const ev of events) {
    let parsed: { name?: string; about?: string; picture?: string };
    try {
      parsed = JSON.parse(ev.content);
    } catch {
      continue;
    }
    const prev = out.get(ev.pubkey);
    if (prev && prev.updatedAt >= ev.created_at) continue;
    out.set(ev.pubkey, {
      pubkey: ev.pubkey,
      name: parsed.name,
      about: parsed.about,
      picture: parsed.picture,
      updatedAt: ev.created_at,
    });
  }
  return out;
}
