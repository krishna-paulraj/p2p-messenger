/**
 * Central app state — minimal Zustand store. Holds:
 *   - identity (after login)
 *   - contacts (alias → record)
 *   - per-peer message log
 *   - active conversation pubkey
 *   - relay status counters
 *
 * Side-effecting actions (init, send, addContact, etc.) live alongside the
 * state. The single live `WebMessenger` instance is created lazily on
 * first init() and held in a module-scoped ref so React StrictMode's
 * double-mount doesn't spawn two of them.
 */

import { create } from "zustand";
import {
  clearIdentity,
  loadContacts,
  loadMessages,
  loadRelays,
  saveContacts,
  saveMessages,
  saveRelays,
  type StoredContact,
  type StoredMessage,
} from "../db/store";
import {
  decodePeerRef,
  getOrCreateIdentity,
  importIdentity,
  npubFor,
  type WebIdentity,
} from "../protocol/identity";
import { WebMessenger, type IncomingMessage } from "../protocol/messenger";
import { WebPeer, type SignalPayload } from "../protocol/peer";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

let messengerRef: WebMessenger | undefined;
let peerRef: WebPeer | undefined;

export type AppState = {
  ready: boolean;
  identity?: WebIdentity;
  contacts: Record<string, StoredContact>;
  messages: Record<string, StoredMessage[]>;
  activePeer?: string;
  relayUrls: string[];
  relayOpen: number;
  /** Pubkeys we are currently P2P-connected to via WebRTC. */
  p2pConnected: Set<string>;
  /** Pubkeys we are currently dialing (post-offer, pre-data-channel-open). */
  p2pDialing: Set<string>;

  init(opts: {
    alias: string;
    relayUrls?: string[];
    /** When set, import this private key (nsec1… or 64-char hex) instead of
     *  generating a fresh one. Replaces any pre-existing identity. */
    importSecret?: string;
  }): Promise<void>;
  setActivePeer(pubkey: string | undefined): void;
  addContact(alias: string, ref: string, note?: string): Promise<StoredContact>;
  removeContact(alias: string): Promise<void>;
  send(text: string): Promise<void>;
  resetIdentity(): Promise<void>;
  addRelay(url: string): Promise<void>;
  removeRelay(url: string): Promise<void>;
  /** Open a WebRTC P2P connection to a peer (browser ↔ browser/CLI). */
  dial(pubkey: string): Promise<void>;
  /** Tear down a WebRTC P2P connection (without removing the contact). */
  hangup(pubkey: string): Promise<void>;
};

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  identity: undefined,
  contacts: {},
  messages: {},
  activePeer: undefined,
  relayUrls: DEFAULT_RELAYS,
  relayOpen: 0,
  p2pConnected: new Set<string>(),
  p2pDialing: new Set<string>(),

  async init({ alias, relayUrls, importSecret }) {
    if (messengerRef) return; // already initialized in a prior mount
    const identity = importSecret
      ? await importIdentity({ alias, secret: importSecret })
      : await getOrCreateIdentity(alias);
    const contacts = await loadContacts();
    const messages = await loadMessages();
    // Persisted relay list (set in past sessions) wins over the LoginPanel
    // default; the LoginPanel value only applies for first-run identity
    // creation when the IDB key is absent.
    const persistedRelays = await loadRelays();
    const relays = persistedRelays ?? relayUrls ?? get().relayUrls;
    if (!persistedRelays) await saveRelays(relays);
    set({ identity, contacts, messages, relayUrls: relays });

    messengerRef = new WebMessenger({
      relays,
      selfPubkey: identity.publicKey,
      selfSecret: identity.secretKey,
    });

    messengerRef.onMessage((msg) => onIncoming(msg, set, get));
    messengerRef.onRelayStatus((open) => set({ relayOpen: open }));

    // WebPeer drives the WebRTC handshake. The messenger is its signaling
    // courier — outbound signals fan out via gift-wrapped kind 21059 events,
    // inbound P2P_SIGNAL rumors are dispatched here into the peer's state
    // machine. Wire format matches the CLI exactly so a CLI alice and a
    // browser bob can complete a handshake.
    peerRef = new WebPeer({
      selfId: identity.publicKey,
      sendSignal: async (toPeerId, payload) => {
        if (!messengerRef) throw new Error("messenger gone");
        await messengerRef.sendSignal(toPeerId, payload);
      },
    });
    peerRef.onConnect((p) => {
      const next = new Set(get().p2pConnected);
      next.add(p);
      const dialing = new Set(get().p2pDialing);
      dialing.delete(p);
      set({ p2pConnected: next, p2pDialing: dialing });
      // Surface as a small system line in the conversation.
      const log = get().messages[p] ?? [];
      const sysEntry: StoredMessage = {
        peer: p,
        direction: "in",
        text: "[p2p connection open]",
        ts: Math.floor(Date.now() / 1000),
        source: "live",
      };
      const nextMessages = { ...get().messages, [p]: [...log, sysEntry] };
      set({ messages: nextMessages });
      void saveMessages(nextMessages);
    });
    peerRef.onDisconnect((p) => {
      const next = new Set(get().p2pConnected);
      next.delete(p);
      const dialing = new Set(get().p2pDialing);
      dialing.delete(p);
      set({ p2pConnected: next, p2pDialing: dialing });
    });
    peerRef.onMessage((from, text) => {
      const log = get().messages[from] ?? [];
      const entry: StoredMessage = {
        peer: from,
        direction: "in",
        text,
        ts: Math.floor(Date.now() / 1000),
        // Tag p2p-delivered messages distinctly from relay-drained ones.
        source: "live",
      };
      const nextLog = [...log, entry];
      const nextMessages = { ...get().messages, [from]: nextLog };
      set({ messages: nextMessages });
      void saveMessages(nextMessages);
    });
    messengerRef.onSignal((s) => {
      const payload = s.payload as SignalPayload;
      if (
        payload &&
        typeof payload === "object" &&
        "kind" in payload &&
        (payload.kind === "offer" || payload.kind === "answer" || payload.kind === "ice")
      ) {
        peerRef?.handleSignal(s.from, payload).catch((err) => {
          console.warn("[app] handleSignal error:", err);
        });
      }
    });

    await messengerRef.start();
    set({ ready: true });
  },

  setActivePeer(pubkey) {
    set({ activePeer: pubkey });
  },

  async addContact(alias, ref, note) {
    const pubkey = decodePeerRef(ref);
    const next: StoredContact = {
      alias,
      pubkey,
      npub: npubFor(pubkey),
      addedAt: Math.floor(Date.now() / 1000),
      note,
    };
    const merged = { ...get().contacts, [alias]: next };
    await saveContacts(merged);
    set({ contacts: merged });
    return next;
  },

  async removeContact(alias) {
    const next = { ...get().contacts };
    delete next[alias];
    await saveContacts(next);
    set({ contacts: next });
  },

  async send(text) {
    const peer = get().activePeer;
    const messenger = messengerRef;
    if (!peer || !messenger) throw new Error("no active peer");

    // Hybrid routing: WebRTC P2P channel if connected (instant, encrypted
    // with the per-session XChaCha20 key), otherwise fall back to the
    // NIP-17 + Double Ratchet relay path.
    if (peerRef && peerRef.isConnected(peer)) {
      peerRef.send(peer, text);
    } else {
      await messenger.send(peer, text);
    }

    const ts = Math.floor(Date.now() / 1000);
    const entry: StoredMessage = {
      peer,
      direction: "out",
      text,
      ts,
      source: "live",
    };
    const log = get().messages[peer] ?? [];
    const nextLog = [...log, entry];
    const nextMessages = { ...get().messages, [peer]: nextLog };
    set({ messages: nextMessages });
    void saveMessages(nextMessages);
  },

  async dial(pubkey) {
    if (!peerRef) throw new Error("not initialized");
    if (peerRef.isConnected(pubkey)) return;
    const dialing = new Set(get().p2pDialing);
    dialing.add(pubkey);
    set({ p2pDialing: dialing });
    try {
      await peerRef.dial(pubkey);
    } catch (err) {
      const next = new Set(get().p2pDialing);
      next.delete(pubkey);
      set({ p2pDialing: next });
      throw err;
    }
  },

  async hangup(pubkey) {
    if (!peerRef) return;
    peerRef.disconnect(pubkey);
    const next = new Set(get().p2pConnected);
    next.delete(pubkey);
    const dialing = new Set(get().p2pDialing);
    dialing.delete(pubkey);
    set({ p2pConnected: next, p2pDialing: dialing });
  },

  async addRelay(url: string) {
    const trimmed = url.trim();
    if (!trimmed) throw new Error("relay url required");
    if (!/^wss?:\/\//.test(trimmed)) {
      throw new Error("relay url must start with ws:// or wss://");
    }
    const current = get().relayUrls;
    if (current.includes(trimmed)) return;
    const next = [...current, trimmed];
    await saveRelays(next);
    set({ relayUrls: next });
    if (messengerRef) await messengerRef.addRelay(trimmed);
  },

  async removeRelay(url: string) {
    const current = get().relayUrls;
    if (!current.includes(url)) return;
    const next = current.filter((u) => u !== url);
    await saveRelays(next);
    set({ relayUrls: next });
    if (messengerRef) await messengerRef.removeRelay(url);
  },

  async resetIdentity() {
    if (peerRef) {
      peerRef.close();
      peerRef = undefined;
    }
    if (messengerRef) {
      await messengerRef.close();
      messengerRef = undefined;
    }
    await clearIdentity();
    set({
      ready: false,
      identity: undefined,
      contacts: {},
      messages: {},
      activePeer: undefined,
      relayOpen: 0,
      p2pConnected: new Set(),
      p2pDialing: new Set(),
    });
  },
}));

function onIncoming(
  msg: IncomingMessage,
  set: (partial: Partial<AppState>) => void,
  get: () => AppState,
): void {
  const entry: StoredMessage = {
    peer: msg.from,
    direction: "in",
    text: msg.text,
    ts: msg.ts,
    source: "relay",
  };
  const log = get().messages[msg.from] ?? [];
  // Skip exact duplicates by (ts, text) — defends against the same drained
  // message arriving twice on rapid reconnects.
  if (
    log.length > 0 &&
    log[log.length - 1].direction === "in" &&
    log[log.length - 1].text === entry.text &&
    log[log.length - 1].ts === entry.ts
  ) {
    return;
  }
  const nextLog = [...log, entry];
  const nextMessages = { ...get().messages, [msg.from]: nextLog };
  set({ messages: nextMessages });
  void saveMessages(nextMessages);

  // Auto-add the sender to contacts on first inbound. Without this, the
  // ContactList sidebar (which iterates the contacts map) wouldn't render
  // a conversation row for unknown senders and the message would be
  // invisible despite being decrypted + stored.
  const existing = Object.values(get().contacts).find((c) => c.pubkey === msg.from);
  if (!existing) {
    const baseAlias = `peer-${msg.from.slice(0, 6)}`;
    let alias = baseAlias;
    let n = 1;
    const taken = get().contacts;
    while (alias in taken) {
      n += 1;
      alias = `${baseAlias}-${n}`;
    }
    const newContact: StoredContact = {
      alias,
      pubkey: msg.from,
      npub: npubFor(msg.from),
      addedAt: Math.floor(Date.now() / 1000),
      note: "auto-added on first inbound message",
    };
    const nextContacts = { ...get().contacts, [alias]: newContact };
    set({ contacts: nextContacts });
    void saveContacts(nextContacts);
  }
}
