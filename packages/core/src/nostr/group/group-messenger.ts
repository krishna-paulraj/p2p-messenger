import type { Event as NostrEvent } from "nostr-tools/core";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { giftUnwrap, giftWrap } from "../gift-wrap.js";
import { KINDS } from "../kinds.js";
import type { RelayPool, SubscriptionHandle } from "../relay-pool.js";
import { makeLogger } from "../../util/logger.js";
import {
  buildAad,
  decryptMessage,
  encryptMessage,
} from "./sender-keys.js";
import type { GroupStore } from "./group-store.js";
import {
  GROUP_CONTENT_TYPES,
  type Group,
  type WireGroupContent,
  type WireGroupMessage,
  type WireInvite,
  type WireLeave,
} from "./types.js";

const log = makeLogger("group");

export type IncomingGroupMessage = {
  groupId: string;
  groupName: string;
  /** Sender pubkey (hex) — verified by NIP-44 unwrap. */
  from: string;
  text: string;
  /** UNIX seconds — rumor created_at. */
  ts: number;
  /** Sender's epoch + counter, for ordering / debugging. */
  epoch: number;
  counter: number;
  fromDrain: boolean;
};

export type IncomingInvite = {
  groupId: string;
  groupName: string;
  members: string[];
  inviter: string;
  eventId: string;
  ts: number;
};

export type GroupMessengerOptions = {
  pool: RelayPool;
  selfPubkey: string;
  selfSecret: Uint8Array;
  store: GroupStore;
  /**
   * Floor for the gift-wrap subscription. Defaults to now() − 1 day; older
   * group events are unlikely to be useful and may be replays.
   */
  sinceSeconds?: number;
  /** Reject group rumors older than this many seconds. */
  freshnessSeconds?: number;
};

const DEFAULT_FRESHNESS_SECONDS = 24 * 60 * 60; // 1 day — groups care about recent state
const DEFAULT_SINCE_LOOKBACK_S = 24 * 60 * 60;
const GIFT_WRAP_BACKDATE_S = 2 * 24 * 60 * 60;
const DEDUP_RING_SIZE = 4096;

/**
 * Owns the subscription for group control + data events. Dispatches inbound
 * gift wraps by their inner content `type` discriminator. Outbound publishes
 * one wrap per recipient (necessary for sender anonymity / metadata privacy).
 */
export class GroupMessenger {
  private opts: GroupMessengerOptions;
  private sub?: SubscriptionHandle;
  private messageListeners = new Set<(msg: IncomingGroupMessage) => void>();
  private inviteListeners = new Set<(inv: IncomingInvite) => void>();
  private membershipListeners = new Set<
    (e: { groupId: string; pubkey: string; kind: "joined" | "left" }) => void
  >();
  private since: number;
  private freshness: number;
  private started = false;
  private seenEventIds: string[] = [];

  /** Drain semantics: same as OfflineMessenger — buffer until EOSE, flush. */
  private draining = true;
  private drainBufferMessages: IncomingGroupMessage[] = [];
  private drainBufferInvites: IncomingInvite[] = [];
  private drainSettleTimer?: NodeJS.Timeout;
  private drainHardTimer?: NodeJS.Timeout;

  constructor(opts: GroupMessengerOptions) {
    this.opts = opts;
    const now = Math.floor(Date.now() / 1000);
    this.since = opts.sinceSeconds ?? now - DEFAULT_SINCE_LOOKBACK_S;
    this.freshness = opts.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS;
  }

  // ---- Public API ----

  onMessage(fn: (m: IncomingGroupMessage) => void): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  onInvite(fn: (i: IncomingInvite) => void): () => void {
    this.inviteListeners.add(fn);
    return () => this.inviteListeners.delete(fn);
  }

  onMembership(
    fn: (e: { groupId: string; pubkey: string; kind: "joined" | "left" }) => void,
  ): () => void {
    this.membershipListeners.add(fn);
    return () => this.membershipListeners.delete(fn);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.draining = true;

    this.sub = this.opts.pool.subscribe(
      [
        {
          kinds: [KINDS.GIFT_WRAP],
          "#p": [this.opts.selfPubkey],
          since: this.since - GIFT_WRAP_BACKDATE_S,
        },
      ],
      {
        onevent: (event) => this.onWrap(event),
        oneose: () => {
          if (this.drainSettleTimer) clearTimeout(this.drainSettleTimer);
          this.drainSettleTimer = setTimeout(() => this.endDrain("eose"), 250);
        },
      },
    );
    this.drainHardTimer = setTimeout(() => this.endDrain("hard-timeout"), 5000);
    log.info("subscribed to group gift wraps", { pubkey: this.opts.selfPubkey.slice(0, 8) });
  }

  async close(): Promise<void> {
    if (this.drainSettleTimer) clearTimeout(this.drainSettleTimer);
    if (this.drainHardTimer) clearTimeout(this.drainHardTimer);
    if (this.draining) this.endDrain("close");
    this.sub?.close();
  }

  /** Create a new group (locally) — no remote events until invite() is called. */
  createGroup(name: string): Group {
    return this.opts.store.createOwnGroup({
      name,
      selfPubkey: this.opts.selfPubkey,
    });
  }

  /**
   * Invite a peer to a group. Sends a single NIP-17 wrap of an invite content,
   * plus our current sender key (so they can decrypt our group messages once
   * they accept). Idempotent — sending two invites doesn't create dupes locally.
   */
  async invite(opts: { groupId: string; peerPubkey: string }): Promise<void> {
    const group = this.opts.store.get(opts.groupId);
    if (!group) throw new Error("unknown group");

    const invite: WireInvite = {
      type: GROUP_CONTENT_TYPES.INVITE,
      groupId: group.id,
      groupName: group.name,
      members: group.members.filter((m) => m !== opts.peerPubkey), // exclude recipient
      inviter: this.opts.selfPubkey,
      ts: Math.floor(Date.now() / 1000),
    };
    await this.publishWire(invite, opts.peerPubkey);

    // Distribute our sender key so they can decrypt as soon as they accept.
    const own = this.opts.store.ownChain(group.id);
    if (!own) throw new Error("missing own chain");
    const seedHex = bytesToHex(own.state.chainKey);
    // NB: chainKey at counter=0 IS the seed for a fresh chain. After we send
    // our first message the chain advances; new joiners would not receive
    // back-content. That's fine — Sender Keys is forward-only by design.
    await this.publishWire(
      {
        type: GROUP_CONTENT_TYPES.SENDER_KEY,
        groupId: group.id,
        epoch: own.epoch,
        chainSeedHex: seedHex,
      },
      opts.peerPubkey,
    );

    // Optimistically add the invitee to our local member list so subsequent
    // invites (and any future state-distributing operations) include them.
    // If they decline / never respond, we'll have a phantom member — the
    // tradeoff is that without this, sequential invites see partial views.
    if (!group.members.includes(opts.peerPubkey)) {
      this.opts.store.addMember(group.id, opts.peerPubkey);
    }

    log.info("invited peer", {
      groupId: group.id.slice(0, 8),
      peer: opts.peerPubkey.slice(0, 8),
    });
  }

  /**
   * Accept a pending invite. Joins locally, then distributes our sender key
   * to all current members so they can read our messages. Existing members
   * will reciprocate on receipt by sending us their sender keys.
   */
  async accept(eventId: string): Promise<Group> {
    const invite = this.opts.store.removeInvite(eventId);
    if (!invite) throw new Error("invite not found");
    const group = this.opts.store.joinGroup({
      groupId: invite.groupId,
      groupName: invite.groupName,
      members: invite.members,
      selfPubkey: this.opts.selfPubkey,
    });

    const own = this.opts.store.ownChain(group.id);
    if (!own) throw new Error("missing own chain after join");
    const seedHex = bytesToHex(own.state.chainKey);

    // Tell every existing member about our sender key.
    for (const m of group.members) {
      if (m === this.opts.selfPubkey) continue;
      await this.publishWire(
        {
          type: GROUP_CONTENT_TYPES.SENDER_KEY,
          groupId: group.id,
          epoch: own.epoch,
          chainSeedHex: seedHex,
        },
        m,
      );
    }
    log.info("accepted invite", {
      groupId: group.id.slice(0, 8),
      members: group.members.length,
    });
    return group;
  }

  /** Send a chat message to all current group members. */
  async send(groupId: string, text: string): Promise<{ counter: number; epoch: number }> {
    const group = this.opts.store.get(groupId);
    if (!group) throw new Error("unknown group");
    const own = this.opts.store.ownChain(groupId);
    if (!own) throw new Error("no own chain — did you create or join the group?");

    const aad = buildAad(groupId, this.opts.selfPubkey, own.epoch, own.state.counter);
    const enc = encryptMessage(own.state, new TextEncoder().encode(text), aad);
    this.opts.store.flushOwnChain(groupId);

    const wire: WireGroupMessage = {
      type: GROUP_CONTENT_TYPES.MESSAGE,
      groupId,
      epoch: own.epoch,
      counter: enc.counter,
      nonceHex: bytesToHex(enc.nonce),
      ciphertextHex: bytesToHex(enc.ciphertext),
    };

    // Fan out one wrap per other member. Per-recipient gift wraps preserve
    // sender anonymity at the relay (vs a single multi-p-tag event, which
    // leaks "this user is talking to N people simultaneously").
    const recipients = group.members.filter((m) => m !== this.opts.selfPubkey);
    await Promise.all(recipients.map((r) => this.publishWire(wire, r)));
    log.debug("group send", {
      groupId: groupId.slice(0, 8),
      counter: enc.counter,
      recipients: recipients.length,
    });
    return { counter: enc.counter, epoch: own.epoch };
  }

  /**
   * Voluntarily leave a group. Notifies remaining members, removes local
   * state. Does NOT rotate keys for remaining members — they decide on
   * receipt of the LEAVE whether to rotate.
   */
  async leave(groupId: string): Promise<void> {
    const group = this.opts.store.get(groupId);
    if (!group) throw new Error("unknown group");
    const wire: WireLeave = { type: GROUP_CONTENT_TYPES.LEAVE, groupId };
    const recipients = group.members.filter((m) => m !== this.opts.selfPubkey);
    await Promise.all(recipients.map((r) => this.publishWire(wire, r)));
    this.opts.store.leaveGroup(groupId);
    log.info("left group", { groupId: groupId.slice(0, 8) });
  }

  /**
   * Rotate own sender key for a group and distribute the fresh seed to all
   * current members. Called automatically when a member leaves; can be
   * called manually for prophylactic rotation.
   */
  async rotate(groupId: string): Promise<void> {
    const group = this.opts.store.get(groupId);
    if (!group) throw new Error("unknown group");
    const { epoch, chainSeed } = this.opts.store.rotateOwn(groupId);
    const seedHex = bytesToHex(chainSeed);
    const recipients = group.members.filter((m) => m !== this.opts.selfPubkey);
    await Promise.all(
      recipients.map((r) =>
        this.publishWire(
          {
            type: GROUP_CONTENT_TYPES.SENDER_KEY,
            groupId,
            epoch,
            chainSeedHex: seedHex,
          },
          r,
        ),
      ),
    );
    log.info("rotated own sender key", { groupId: groupId.slice(0, 8), epoch });
  }

  // ---- Inbound ----

  private async publishWire(content: WireGroupContent, recipient: string): Promise<void> {
    const wrap = giftWrap({
      innerKind: KINDS.P2P_GROUP,
      innerContent: JSON.stringify(content),
      senderSecret: this.opts.selfSecret,
      recipientPubkey: recipient,
    });
    await this.opts.pool.publish(wrap);
  }

  private onWrap(event: NostrEvent): void {
    if (this.seenEventIds.includes(event.id)) return;
    this.markSeen(event.id);

    const unwrapped = giftUnwrap(event, this.opts.selfSecret);
    if (!unwrapped) return;
    if (unwrapped.innerKind !== KINDS.P2P_GROUP) return;

    const now = Math.floor(Date.now() / 1000);
    const age = now - unwrapped.rumorCreatedAt;
    if (age > this.freshness || age < -this.freshness) {
      log.debug("dropping stale group rumor", {
        from: unwrapped.senderPubkey.slice(0, 8),
        age,
      });
      return;
    }

    let parsed: WireGroupContent;
    try {
      parsed = JSON.parse(unwrapped.innerContent) as WireGroupContent;
    } catch {
      log.warn("malformed group payload", { from: unwrapped.senderPubkey.slice(0, 8) });
      return;
    }
    this.dispatch(parsed, unwrapped.senderPubkey, unwrapped.rumorCreatedAt, event.id);
  }

  private dispatch(
    wire: WireGroupContent,
    sender: string,
    rumorTs: number,
    eventId: string,
  ): void {
    if (wire.type === GROUP_CONTENT_TYPES.INVITE) {
      const invite: IncomingInvite = {
        groupId: wire.groupId,
        groupName: wire.groupName,
        members: wire.members,
        inviter: sender, // trust the unwrapped pubkey, not the wire field
        eventId,
        ts: rumorTs,
      };
      this.opts.store.addInvite({
        groupId: invite.groupId,
        groupName: invite.groupName,
        members: invite.members,
        inviter: invite.inviter,
        receivedAt: rumorTs,
        eventId,
      });
      if (this.draining) {
        this.drainBufferInvites.push(invite);
        this.bumpDrainSettle();
      } else {
        for (const l of this.inviteListeners) l(invite);
      }
      return;
    }

    if (wire.type === GROUP_CONTENT_TYPES.SENDER_KEY) {
      // Install/update peer's chain at the announced epoch.
      try {
        const g = this.opts.store.get(wire.groupId);
        if (!g) {
          log.warn("sender key for unknown group — dropping", {
            groupId: wire.groupId.slice(0, 8),
          });
          return;
        }
        const wasNewMember = !g.members.includes(sender);
        const hadAnyChainBefore =
          this.opts.store.peerChain(wire.groupId, sender) !== undefined;

        this.opts.store.setPeerChain({
          groupId: wire.groupId,
          peerPubkey: sender,
          epoch: wire.epoch,
          chainSeed: hexToBytes(wire.chainSeedHex),
        });
        if (wasNewMember) {
          this.opts.store.addMember(wire.groupId, sender);
          for (const l of this.membershipListeners)
            l({ groupId: wire.groupId, pubkey: sender, kind: "joined" });
        }

        // Closure-of-discovery: if this peer is brand new to us (we had no
        // prior chain for them), they likely don't have OUR sender key yet
        // either — push our current sender key to them so messages can flow
        // both ways without requiring a third-party relay of state.
        if (!hadAnyChainBefore) {
          const own = this.opts.store.ownChain(wire.groupId);
          if (own) {
            const seedHex = bytesToHex(own.state.chainKey);
            this.publishWire(
              {
                type: GROUP_CONTENT_TYPES.SENDER_KEY,
                groupId: wire.groupId,
                epoch: own.epoch,
                chainSeedHex: seedHex,
              },
              sender,
            ).catch((err) =>
              log.warn("reciprocal sender-key publish failed", { err: String(err) }),
            );
          }
        }
      } catch (err) {
        log.warn("could not install peer chain", {
          groupId: wire.groupId.slice(0, 8),
          err: String(err),
        });
      }
      return;
    }

    if (wire.type === GROUP_CONTENT_TYPES.MESSAGE) {
      const peer = this.opts.store.peerChain(wire.groupId, sender);
      if (!peer) {
        log.warn("group message before sender key — dropping", {
          groupId: wire.groupId.slice(0, 8),
          sender: sender.slice(0, 8),
        });
        return;
      }
      if (peer.epoch !== wire.epoch) {
        log.warn("epoch mismatch on group message", {
          groupId: wire.groupId.slice(0, 8),
          sender: sender.slice(0, 8),
          peerEpoch: peer.epoch,
          msgEpoch: wire.epoch,
        });
        return;
      }
      let plaintext: Uint8Array;
      try {
        const aad = buildAad(wire.groupId, sender, wire.epoch, wire.counter);
        plaintext = decryptMessage(
          peer.state,
          {
            counter: wire.counter,
            nonce: hexToBytes(wire.nonceHex),
            ciphertext: hexToBytes(wire.ciphertextHex),
          },
          aad,
        );
        this.opts.store.flushPeerChain(wire.groupId, sender);
      } catch (err) {
        log.warn("group message decrypt failed", {
          groupId: wire.groupId.slice(0, 8),
          sender: sender.slice(0, 8),
          err: String(err),
        });
        return;
      }
      const group = this.opts.store.get(wire.groupId);
      if (!group) return;
      const msg: IncomingGroupMessage = {
        groupId: wire.groupId,
        groupName: group.name,
        from: sender,
        text: new TextDecoder().decode(plaintext),
        ts: rumorTs,
        epoch: wire.epoch,
        counter: wire.counter,
        fromDrain: this.draining,
      };
      if (this.draining) {
        this.drainBufferMessages.push(msg);
        this.bumpDrainSettle();
      } else {
        for (const l of this.messageListeners) l(msg);
      }
      return;
    }

    if (wire.type === GROUP_CONTENT_TYPES.LEAVE) {
      this.opts.store.removeMember(wire.groupId, sender);
      for (const l of this.membershipListeners)
        l({ groupId: wire.groupId, pubkey: sender, kind: "left" });
      // Rotate own sender key after a leave so the departed member can't
      // decrypt our subsequent messages with the chain key they once held.
      // (Best-effort — fire-and-forget so the dispatch isn't blocked.)
      this.rotate(wire.groupId).catch((err) =>
        log.warn("rotation on leave failed", {
          groupId: wire.groupId.slice(0, 8),
          err: String(err),
        }),
      );
      return;
    }
  }

  private endDrain(reason: string): void {
    if (!this.draining) return;
    this.draining = false;
    if (this.drainSettleTimer) clearTimeout(this.drainSettleTimer);
    if (this.drainHardTimer) clearTimeout(this.drainHardTimer);

    // Group messages are causally ordered by (epoch, counter) per (groupId, sender).
    // Sort drain buffer using that — across senders we fall back to ts/eventId.
    this.drainBufferMessages.sort((a, b) => {
      if (a.groupId !== b.groupId) return a.groupId.localeCompare(b.groupId);
      if (a.from !== b.from) return a.from.localeCompare(b.from);
      if (a.epoch !== b.epoch) return a.epoch - b.epoch;
      return a.counter - b.counter;
    });
    log.info("group drain complete", {
      reason,
      messages: this.drainBufferMessages.length,
      invites: this.drainBufferInvites.length,
    });
    for (const inv of this.drainBufferInvites) {
      for (const l of this.inviteListeners) l(inv);
    }
    for (const msg of this.drainBufferMessages) {
      for (const l of this.messageListeners) l(msg);
    }
    this.drainBufferMessages = [];
    this.drainBufferInvites = [];
  }

  private bumpDrainSettle(): void {
    if (this.drainSettleTimer) clearTimeout(this.drainSettleTimer);
    this.drainSettleTimer = setTimeout(() => this.endDrain("event-settle"), 250);
  }

  private markSeen(id: string): void {
    this.seenEventIds.push(id);
    if (this.seenEventIds.length > DEDUP_RING_SIZE) this.seenEventIds.shift();
  }
}
