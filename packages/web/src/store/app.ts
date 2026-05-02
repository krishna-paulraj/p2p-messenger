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
  saveContacts,
  saveMessages,
  type StoredContact,
  type StoredMessage,
} from "../db/store";
import { decodePeerRef, getOrCreateIdentity, npubFor, type WebIdentity } from "../protocol/identity";
import { WebMessenger, type IncomingMessage } from "../protocol/messenger";

const DEFAULT_RELAYS = ["ws://localhost:7777"];

let messengerRef: WebMessenger | undefined;

export type AppState = {
  ready: boolean;
  identity?: WebIdentity;
  contacts: Record<string, StoredContact>;
  messages: Record<string, StoredMessage[]>;
  activePeer?: string;
  relayUrls: string[];
  relayOpen: number;

  init(opts: { alias: string; relayUrls?: string[] }): Promise<void>;
  setActivePeer(pubkey: string | undefined): void;
  addContact(alias: string, ref: string, note?: string): Promise<StoredContact>;
  removeContact(alias: string): Promise<void>;
  send(text: string): Promise<void>;
  resetIdentity(): Promise<void>;
};

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  identity: undefined,
  contacts: {},
  messages: {},
  activePeer: undefined,
  relayUrls: DEFAULT_RELAYS,
  relayOpen: 0,

  async init({ alias, relayUrls }) {
    if (messengerRef) return; // already initialized in a prior mount
    const identity = await getOrCreateIdentity(alias);
    const contacts = await loadContacts();
    const messages = await loadMessages();
    const relays = relayUrls ?? get().relayUrls;
    set({ identity, contacts, messages, relayUrls: relays });

    messengerRef = new WebMessenger({
      relays,
      selfPubkey: identity.publicKey,
      selfSecret: identity.secretKey,
    });

    messengerRef.onMessage((msg) => onIncoming(msg, set, get));
    messengerRef.onRelayStatus((open) => set({ relayOpen: open }));
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

    await messenger.send(peer, text);
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

  async resetIdentity() {
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
}
