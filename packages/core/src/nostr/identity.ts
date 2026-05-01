import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { makeLogger } from "../util/logger.js";

const log = makeLogger("identity");

export type Identity = {
  /** Local human-readable alias (e.g. "alice"). NOT the Nostr identity itself. */
  alias: string;
  /** 32-byte secp256k1 secret. Treat as the master secret for this device. */
  secretKey: Uint8Array;
  /** 32-byte secp256k1 public key (Nostr's hex pubkey, BIP-340 x-only). */
  publicKey: string;
  /** Bech32-encoded npub form for human-friendly display. */
  npub: string;
  /** UNIX seconds when this identity was first generated. */
  createdAt: number;
};

type StoredIdentity = {
  version: 1;
  alias: string;
  pubkey: string;
  /** Hex-encoded secret. WARNING: plaintext on disk; chmod 0600. */
  secret_hex: string;
  created_at: number;
};

export type IdentityStoreOptions = {
  /** Base directory; defaults to ~/.p2p-messenger or P2P_DATA_DIR. */
  dataDir?: string;
};

export function dataDirFor(opts: IdentityStoreOptions = {}): string {
  return opts.dataDir ?? process.env.P2P_DATA_DIR ?? join(homedir(), ".p2p-messenger");
}

function pathFor(alias: string, opts: IdentityStoreOptions): string {
  return join(dataDirFor(opts), "identities", `${alias}.json`);
}

export function loadOrCreateIdentity(alias: string, opts: IdentityStoreOptions = {}): Identity {
  const path = pathFor(alias, opts);
  if (existsSync(path)) return loadIdentity(path, alias);
  return createIdentity(alias, path);
}

function loadIdentity(path: string, alias: string): Identity {
  // Permission check — fail loud if mode > 0600
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      log.warn("identity file has loose permissions, tightening", {
        path,
        mode: mode.toString(8),
      });
      chmodSync(path, 0o600);
    }
  } catch (err) {
    log.warn("could not stat identity file", { path, err: String(err) });
  }
  const stored = JSON.parse(readFileSync(path, "utf-8")) as StoredIdentity;
  if (stored.version !== 1) throw new Error(`unsupported identity version: ${stored.version}`);
  if (stored.alias !== alias) {
    log.warn("identity alias mismatch — file says different alias", {
      onDisk: stored.alias,
      requested: alias,
    });
  }
  const secretKey = hexToBytes(stored.secret_hex);
  return {
    alias: stored.alias,
    secretKey,
    publicKey: stored.pubkey,
    npub: nip19.npubEncode(stored.pubkey),
    createdAt: stored.created_at,
  };
}

function createIdentity(alias: string, path: string): Identity {
  const secretKey = generateSecretKey();
  const publicKey = getPublicKey(secretKey);
  const stored: StoredIdentity = {
    version: 1,
    alias,
    pubkey: publicKey,
    secret_hex: bytesToHex(secretKey),
    created_at: Math.floor(Date.now() / 1000),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(stored, null, 2), { mode: 0o600 });
  // Defense in depth — re-chmod in case the umask defeated the create flag
  chmodSync(path, 0o600);
  log.info("created new identity", { alias, npub: nip19.npubEncode(publicKey) });
  return {
    alias,
    secretKey,
    publicKey,
    npub: nip19.npubEncode(publicKey),
    createdAt: stored.created_at,
  };
}

/** Deterministically derive an npub from a hex pubkey. */
export function pubkeyToNpub(pubkeyHex: string): string {
  return nip19.npubEncode(pubkeyHex);
}

/** Decode npub (or pass through hex). Returns the 32-byte hex pubkey. */
export function decodePeerRef(ref: string): string {
  if (/^[0-9a-f]{64}$/i.test(ref)) return ref.toLowerCase();
  if (ref.startsWith("npub1")) {
    const decoded = nip19.decode(ref);
    if (decoded.type !== "npub") throw new Error(`expected npub, got ${decoded.type}`);
    return decoded.data;
  }
  throw new Error(`not a hex pubkey or npub: ${ref}`);
}
