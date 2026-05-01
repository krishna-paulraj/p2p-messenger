import { wrapEvent, unwrapEvent } from "nostr-tools/nip59";
import type { Event as NostrEvent, UnsignedEvent } from "nostr-tools/core";
import { makeLogger } from "../util/logger.js";

const log = makeLogger("gift-wrap");

/**
 * Wrap a structured payload as a NIP-59 gift-wrapped event tagged for recipient.
 *
 * Layers:
 *   rumor (unsigned event with our content)
 *     → seal (kind 13, NIP-44 encrypted to recipient with sender's real key)
 *       → gift wrap (kind 1059, NIP-44 encrypted with random ephemeral key,
 *                    p-tagged to recipient — recipient knows it's for them, but
 *                    relays can't tell who sent it)
 *
 * Caller picks the inner kind. For signaling we use a custom kind; for chat
 * messages we use NIP-17 chat (kind 14).
 */
export function giftWrap(opts: {
  innerKind: number;
  innerContent: string;
  innerTags?: string[][];
  senderSecret: Uint8Array;
  recipientPubkey: string;
  /**
   * NIP-59 recommends randomizing the gift-wrap created_at within ±2 days
   * to prevent timing correlation; nostr-tools handles this in wrapEvent.
   */
}): NostrEvent {
  const inner: Partial<UnsignedEvent> = {
    kind: opts.innerKind,
    content: opts.innerContent,
    tags: opts.innerTags ?? [],
    created_at: Math.floor(Date.now() / 1000),
  };
  return wrapEvent(inner, opts.senderSecret, opts.recipientPubkey);
}

export type Unwrapped = {
  /** Real sender pubkey (from the rumor — verified by NIP-44 decryption). */
  senderPubkey: string;
  innerKind: number;
  innerContent: string;
  innerTags: string[][];
  rumorCreatedAt: number;
};

export function giftUnwrap(wrap: NostrEvent, recipientSecret: Uint8Array): Unwrapped | null {
  try {
    const rumor = unwrapEvent(wrap, recipientSecret);
    return {
      senderPubkey: rumor.pubkey,
      innerKind: rumor.kind,
      innerContent: rumor.content,
      innerTags: rumor.tags,
      rumorCreatedAt: rumor.created_at,
    };
  } catch (err) {
    log.debug("unwrap failed", { eventId: wrap.id, err: String(err) });
    return null;
  }
}
