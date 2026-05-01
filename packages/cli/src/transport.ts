import {
  type Identity,
  NostrSignaling,
  RelayPool,
  type SignalingTransport,
  WebSocketSignaling,
  loadOrCreateIdentity,
  pubkeyToNpub,
} from "@p2p/core";

export type ResolvedTransport = {
  transport: SignalingTransport;
  /** Present when using Nostr; absent when using WS. */
  identity?: Identity;
  /** Present when using Nostr; cleanup hook for the relay pool. */
  pool?: RelayPool;
  /** Human-readable summary for log lines. */
  description: string;
};

/**
 * Parse the --signal flag and build the matching transport.
 *
 *   ws://host:port            → WebSocketSignaling, selfId = alias
 *   nostr://relay1[,relay2]   → NostrSignaling over RelayPool, selfId = pubkey
 *
 * The `alias` is always a local handle for UX (DB filename, prompt label, etc).
 * The transport's selfId is what remote peers actually address us by on the wire.
 */
export function buildTransport(opts: {
  alias: string;
  signal: string;
  dataDir?: string;
}): ResolvedTransport {
  const { alias, signal } = opts;

  if (signal.startsWith("ws://") || signal.startsWith("wss://")) {
    const transport = new WebSocketSignaling({ url: signal, selfId: alias });
    return {
      transport,
      description: `ws://${new URL(signal).host} as ${alias}`,
    };
  }

  if (signal.startsWith("nostr://")) {
    const identity = loadOrCreateIdentity(alias, { dataDir: opts.dataDir });
    const relayList = parseNostrRelays(signal);
    const pool = new RelayPool(relayList);
    const transport = new NostrSignaling({
      secretKey: identity.secretKey,
      publicKey: identity.publicKey,
      pool,
    });
    return {
      transport,
      identity,
      pool,
      description: `nostr (${relayList.length} relay${
        relayList.length === 1 ? "" : "s"
      }) as ${alias} ${shortNpub(identity.npub)}`,
    };
  }

  throw new Error(
    `unsupported --signal scheme: ${signal} (expected ws://, wss://, or nostr://)`,
  );
}

/**
 * `nostr://relay1.example,relay2.example/path` → ["wss://relay1.example", "wss://relay2.example/path"]
 *
 * Hosts may be comma-separated. If a host contains "://" it's used verbatim;
 * otherwise it's prefixed with wss:// (or ws:// for localhost).
 */
function parseNostrRelays(signal: string): string[] {
  const tail = signal.slice("nostr://".length);
  const hosts = tail
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hosts.length === 0) {
    throw new Error("nostr:// signal needs at least one relay host");
  }
  return hosts.map((h) => {
    if (h.includes("://")) return h;
    if (h.startsWith("localhost") || h.startsWith("127.")) return `ws://${h}`;
    return `wss://${h}`;
  });
}

export function shortNpub(npub: string): string {
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
}

export function shortPubkey(hex: string): string {
  if (/^[0-9a-f]{64}$/i.test(hex)) {
    return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
  }
  return hex;
}

export { pubkeyToNpub };
