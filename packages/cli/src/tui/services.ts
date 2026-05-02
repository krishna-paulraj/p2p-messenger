/**
 * Construct the full set of core services for a TUI session. Mirrors what
 * the readline CLI sets up in its main(); broken out so the TUI's React
 * tree can consume it without owning the imperative wiring.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ContactBook,
  DedupStore,
  GroupMessenger,
  GroupStore,
  type Identity,
  Messenger,
  OfflineMessenger,
  Peer,
  PresencePublisher,
  PresenceWatcher,
  RatchetStore,
  RelayPool,
  type SignalingTransport,
  initCrypto,
  loadClock,
  publishProfile,
  saveClock,
} from "@p2p/core";
import { MessageStore } from "../storage.js";
import { buildTransport } from "../transport.js";

export type SessionOptions = {
  alias: string;
  signal: string;
  dataDir?: string;
};

export type Session = {
  alias: string;
  identity?: Identity;
  pool?: RelayPool;
  transport: SignalingTransport;
  description: string;
  peer: Peer;
  messenger: Messenger;
  offline?: OfflineMessenger;
  contacts?: ContactBook;
  presencePub?: PresencePublisher;
  presenceWatch?: PresenceWatcher;
  groupStore?: GroupStore;
  groupMessenger?: GroupMessenger;
  ratchetStore?: RatchetStore;
  messageStore: MessageStore;
  clockPath?: string;
  cleanup: () => Promise<void>;
};

export async function startSession(opts: SessionOptions): Promise<Session> {
  await initCrypto();
  const dataDir =
    opts.dataDir ?? process.env.P2P_DATA_DIR ?? join(homedir(), ".p2p-messenger");
  const messageStore = new MessageStore(join(dataDir, "history", `${opts.alias}.db`));

  const resolved = buildTransport({ alias: opts.alias, signal: opts.signal, dataDir });
  const { transport, identity, pool, description } = resolved;

  const contacts = identity ? new ContactBook({ dataDir, ownerAlias: opts.alias }) : undefined;
  const presencePub =
    identity && pool
      ? new PresencePublisher({
          pool,
          secretKey: identity.secretKey,
          publicKey: identity.publicKey,
        })
      : undefined;
  const presenceWatch = identity && pool ? new PresenceWatcher(pool) : undefined;

  const clockPath = identity ? join(dataDir, "clock", `${opts.alias}.json`) : undefined;
  const dedupPath = identity ? join(dataDir, "dedup", `${opts.alias}.json`) : undefined;
  const clock = identity && clockPath ? loadClock(clockPath, identity.publicKey) : undefined;
  const dedup = dedupPath ? new DedupStore(dedupPath) : undefined;

  const groupStore = identity ? new GroupStore({ dataDir, ownerAlias: opts.alias }) : undefined;
  const groupMessenger =
    identity && pool && groupStore
      ? new GroupMessenger({
          pool,
          selfPubkey: identity.publicKey,
          selfSecret: identity.secretKey,
          store: groupStore,
        })
      : undefined;

  const ratchetStore = identity ? new RatchetStore({ dataDir, ownerAlias: opts.alias }) : undefined;

  const offline =
    identity && pool && clock && dedup && ratchetStore
      ? new OfflineMessenger({
          pool,
          selfPubkey: identity.publicKey,
          selfSecret: identity.secretKey,
          dedup,
          clock,
          ratchetStore,
        })
      : undefined;

  const peer = new Peer({ transport });
  const messenger = new Messenger({
    peer,
    offline,
    tickClock: clock ? () => clock.tick() : undefined,
  });

  await peer.start();
  if (offline) await offline.start();
  if (groupMessenger) await groupMessenger.start();
  if (presencePub) await presencePub.start();

  if (identity && pool) {
    publishProfile({ pool, secretKey: identity.secretKey, profile: { name: opts.alias } }).catch(
      () => {
        /* best-effort */
      },
    );
  }

  const cleanup = async () => {
    await presencePub?.stop();
    presenceWatch?.close();
    if (groupMessenger) await groupMessenger.close();
    groupStore?.close();
    ratchetStore?.close();
    if (clock && clockPath) saveClock(clockPath, clock);
    dedup?.close();
    await messenger.close();
    await pool?.close();
    messageStore.close();
  };

  return {
    alias: opts.alias,
    identity,
    pool,
    transport,
    description,
    peer,
    messenger,
    offline,
    contacts,
    presencePub,
    presenceWatch,
    groupStore,
    groupMessenger,
    ratchetStore,
    messageStore,
    clockPath,
    cleanup,
  };
}
