import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { dataDirFor } from "../identity.js";
import { makeLogger } from "../../util/logger.js";
import {
  type SenderChainState,
  generateChainSeed,
  newChainState,
} from "./sender-keys.js";
import type {
  Group,
  StoredGroup,
  StoredGroupBook,
  StoredInvite,
  StoredSenderChain,
} from "./types.js";

const log = makeLogger("group-store");

/**
 * Per-local-user persistence for groups, sender-key state, and pending invites.
 *
 * Sender-key chain keys live in this file; treat it like the identity file
 * (mode 0600 on disk, mode 0700 on parent directory). Losing it = losing
 * the ability to read in-flight messages and forces re-issuing your own
 * sender key (compatible with normal "rotate" semantics — no data loss to
 * peers, just to yourself).
 */
export class GroupStore {
  private path: string;
  private book: StoredGroupBook = { version: 1, groups: [], pendingInvites: [] };
  /** In-memory hot copies of chain state for fast encrypt/decrypt. */
  private ownChains = new Map<string /* groupId */, SenderChainState>();
  private peerChains = new Map<
    string /* groupId */,
    Map<string /* peerPubkey */, { epoch: number; state: SenderChainState }>
  >();
  private dirty = false;
  private flushTimer?: NodeJS.Timeout;

  constructor(opts: { dataDir?: string; ownerAlias: string }) {
    this.path = join(dataDirFor(opts), "groups", `${opts.ownerAlias}.json`);
    if (existsSync(this.path)) this.load();
  }

  // ---- Group lifecycle ----

  createOwnGroup(opts: { name: string; selfPubkey: string }): Group {
    const id = bytesToHex(generateChainSeed()); // 32 random bytes hex == 64 chars
    const seed = generateChainSeed();
    const ownChain = newChainState(seed);

    const stored: StoredGroup = {
      id,
      name: opts.name,
      members: [opts.selfPubkey],
      ownEpoch: 0,
      ownChain: serializeChain(ownChain),
      peerKeys: {},
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    };
    this.book.groups.push(stored);
    this.ownChains.set(id, ownChain);
    this.peerChains.set(id, new Map());
    this.scheduleFlush();
    log.info("created group", { id: id.slice(0, 8), name: stored.name });
    return projectGroup(stored);
  }

  /** Add ourselves to a group we were invited to. Generates own sender key. */
  joinGroup(opts: {
    groupId: string;
    groupName: string;
    members: string[]; // includes inviter, may or may not include self
    selfPubkey: string;
  }): Group {
    const existing = this.findById(opts.groupId);
    if (existing) {
      log.warn("already a member of this group", { groupId: opts.groupId.slice(0, 8) });
      return projectGroup(existing);
    }
    const seed = generateChainSeed();
    const ownChain = newChainState(seed);
    const members = [...new Set([...opts.members, opts.selfPubkey])].sort();
    const stored: StoredGroup = {
      id: opts.groupId,
      name: opts.groupName,
      members,
      ownEpoch: 0,
      ownChain: serializeChain(ownChain),
      peerKeys: {},
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    };
    this.book.groups.push(stored);
    this.ownChains.set(opts.groupId, ownChain);
    this.peerChains.set(opts.groupId, new Map());
    this.scheduleFlush();
    log.info("joined group", { id: opts.groupId.slice(0, 8), members: members.length });
    return projectGroup(stored);
  }

  /** Leave a group (locally). Caller is responsible for publishing the WireLeave. */
  leaveGroup(groupId: string): boolean {
    const idx = this.book.groups.findIndex((g) => g.id === groupId);
    if (idx < 0) return false;
    this.book.groups.splice(idx, 1);
    this.ownChains.delete(groupId);
    this.peerChains.delete(groupId);
    this.scheduleFlush();
    return true;
  }

  /** Add a pubkey to an existing group's member list. Idempotent. */
  addMember(groupId: string, pubkey: string): void {
    const g = this.findById(groupId);
    if (!g) throw new Error("group not found");
    if (g.members.includes(pubkey)) return;
    g.members = [...new Set([...g.members, pubkey])].sort();
    g.updatedAt = Math.floor(Date.now() / 1000);
    this.scheduleFlush();
  }

  removeMember(groupId: string, pubkey: string): void {
    const g = this.findById(groupId);
    if (!g) throw new Error("group not found");
    g.members = g.members.filter((m) => m !== pubkey);
    delete g.peerKeys[pubkey];
    this.peerChains.get(groupId)?.delete(pubkey);
    g.updatedAt = Math.floor(Date.now() / 1000);
    this.scheduleFlush();
  }

  list(): Group[] {
    return this.book.groups.map(projectGroup);
  }

  get(groupId: string): Group | undefined {
    const g = this.findById(groupId);
    return g ? projectGroup(g) : undefined;
  }

  byName(name: string): Group | undefined {
    const g = this.book.groups.find((g) => g.name === name);
    return g ? projectGroup(g) : undefined;
  }

  members(groupId: string): string[] {
    const g = this.findById(groupId);
    return g ? [...g.members] : [];
  }

  // ---- Own sender chain ----

  /** Get the live mutable own chain — for encrypt path. */
  ownChain(groupId: string): { epoch: number; state: SenderChainState } | undefined {
    const g = this.findById(groupId);
    if (!g) return undefined;
    let state = this.ownChains.get(groupId);
    if (!state) {
      state = deserializeChain(g.ownChain);
      this.ownChains.set(groupId, state);
    }
    return { epoch: g.ownEpoch, state };
  }

  /** Reseed own sender key (after member change). Returns the new chain seed. */
  rotateOwn(groupId: string): { epoch: number; chainSeed: Uint8Array } {
    const g = this.findById(groupId);
    if (!g) throw new Error("group not found");
    const seed = generateChainSeed();
    const fresh = newChainState(seed);
    g.ownEpoch += 1;
    g.ownChain = serializeChain(fresh);
    g.updatedAt = Math.floor(Date.now() / 1000);
    this.ownChains.set(groupId, fresh);
    this.scheduleFlush();
    return { epoch: g.ownEpoch, chainSeed: seed };
  }

  /** Persist mutated own chain after an encrypt. */
  flushOwnChain(groupId: string): void {
    const g = this.findById(groupId);
    const live = this.ownChains.get(groupId);
    if (!g || !live) return;
    g.ownChain = serializeChain(live);
    g.updatedAt = Math.floor(Date.now() / 1000);
    this.scheduleFlush();
  }

  // ---- Peer sender chains ----

  /** Install or replace a peer's sender chain at a given epoch. */
  setPeerChain(opts: {
    groupId: string;
    peerPubkey: string;
    epoch: number;
    chainSeed: Uint8Array;
  }): void {
    const g = this.findById(opts.groupId);
    if (!g) throw new Error("group not found");
    const existing = g.peerKeys[opts.peerPubkey];
    if (existing && existing.epoch >= opts.epoch) {
      log.debug("ignoring older or equal peer epoch", {
        groupId: opts.groupId.slice(0, 8),
        peer: opts.peerPubkey.slice(0, 8),
        existing: existing.epoch,
        incoming: opts.epoch,
      });
      return;
    }
    const fresh = newChainState(opts.chainSeed);
    g.peerKeys[opts.peerPubkey] = {
      pubkey: opts.peerPubkey,
      epoch: opts.epoch,
      chain: serializeChain(fresh),
    };
    if (!this.peerChains.has(opts.groupId)) this.peerChains.set(opts.groupId, new Map());
    this.peerChains.get(opts.groupId)?.set(opts.peerPubkey, { epoch: opts.epoch, state: fresh });
    g.updatedAt = Math.floor(Date.now() / 1000);
    this.scheduleFlush();
    log.info("installed peer sender key", {
      groupId: opts.groupId.slice(0, 8),
      peer: opts.peerPubkey.slice(0, 8),
      epoch: opts.epoch,
    });
  }

  peerChain(
    groupId: string,
    peerPubkey: string,
  ): { epoch: number; state: SenderChainState } | undefined {
    const g = this.findById(groupId);
    if (!g) return undefined;
    let live = this.peerChains.get(groupId)?.get(peerPubkey);
    if (!live) {
      const stored = g.peerKeys[peerPubkey];
      if (!stored) return undefined;
      live = { epoch: stored.epoch, state: deserializeChain(stored.chain) };
      if (!this.peerChains.has(groupId)) this.peerChains.set(groupId, new Map());
      this.peerChains.get(groupId)?.set(peerPubkey, live);
    }
    return live;
  }

  flushPeerChain(groupId: string, peerPubkey: string): void {
    const g = this.findById(groupId);
    const live = this.peerChains.get(groupId)?.get(peerPubkey);
    if (!g || !live) return;
    const stored = g.peerKeys[peerPubkey];
    if (!stored) return;
    stored.chain = serializeChain(live.state);
    g.updatedAt = Math.floor(Date.now() / 1000);
    this.scheduleFlush();
  }

  // ---- Pending invites ----

  addInvite(invite: StoredInvite): void {
    if (this.book.pendingInvites.some((i) => i.eventId === invite.eventId)) return;
    if (this.findById(invite.groupId)) return; // already a member, ignore
    this.book.pendingInvites.push(invite);
    this.scheduleFlush();
  }

  removeInvite(eventId: string): StoredInvite | undefined {
    const idx = this.book.pendingInvites.findIndex((i) => i.eventId === eventId);
    if (idx < 0) return undefined;
    const [removed] = this.book.pendingInvites.splice(idx, 1);
    this.scheduleFlush();
    return removed;
  }

  removeInviteByGroupId(groupId: string): void {
    this.book.pendingInvites = this.book.pendingInvites.filter((i) => i.groupId !== groupId);
    this.scheduleFlush();
  }

  invites(): StoredInvite[] {
    return [...this.book.pendingInvites].sort((a, b) => b.receivedAt - a.receivedAt);
  }

  // ---- Persistence plumbing ----

  flush(): void {
    if (!this.dirty) return;
    // Flush any in-memory chain mutations into the stored shape first.
    for (const g of this.book.groups) {
      const ownLive = this.ownChains.get(g.id);
      if (ownLive) g.ownChain = serializeChain(ownLive);
      const peerMap = this.peerChains.get(g.id);
      if (peerMap) {
        for (const [peer, live] of peerMap) {
          const stored = g.peerKeys[peer];
          if (stored) stored.chain = serializeChain(live.state);
        }
      }
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(this.book, null, 2), { mode: 0o600 });
    this.dirty = false;
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flush();
  }

  private findById(id: string): StoredGroup | undefined {
    return this.book.groups.find((g) => g.id === id);
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8")) as StoredGroupBook;
      if (raw.version !== 1) {
        log.warn("unsupported group book version", { version: raw.version });
        return;
      }
      this.book = raw;
      log.info("loaded group book", {
        groups: this.book.groups.length,
        pendingInvites: this.book.pendingInvites.length,
      });
    } catch (err) {
      log.warn("failed to load group book", { err: String(err) });
    }
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

function serializeChain(state: SenderChainState): StoredSenderChain {
  const skippedHex: Record<string, string> = {};
  for (const [k, v] of state.skipped) skippedHex[String(k)] = bytesToHex(v);
  return {
    chainKeyHex: bytesToHex(state.chainKey),
    counter: state.counter,
    skippedHex,
  };
}

function deserializeChain(stored: StoredSenderChain): SenderChainState {
  const skipped = new Map<number, Uint8Array>();
  for (const [k, v] of Object.entries(stored.skippedHex)) {
    skipped.set(Number(k), hexToBytes(v));
  }
  return {
    chainKey: hexToBytes(stored.chainKeyHex),
    counter: stored.counter,
    skipped,
  };
}

function projectGroup(g: StoredGroup): Group {
  return {
    id: g.id,
    name: g.name,
    members: [...g.members],
    ownEpoch: g.ownEpoch,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}
