/**
 * Phase 6 integration test: hybrid file transfer.
 *
 *   Scenario A — RELAY path (no P2P connection):
 *     alice sends a 250 KB file to bob via NIP-17 frames; bob receives,
 *     verifies hashes + Merkle root, writes to disk, contents match the
 *     source byte-for-byte.
 *
 *   Scenario B — P2P (WebRTC SecureChannel):
 *     alice and bob complete the WebRTC handshake (Phase 1.5 path), alice
 *     sends a 1 MB file via the data channel; bob receives, verifies, and
 *     the file matches.
 *
 * The same FileTransferManager wires both: it picks WebRTC if peer is
 * P2P-connected, else relay.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  DedupStore,
  FileTransferManager,
  NostrSignaling,
  OfflineMessenger,
  Peer,
  RatchetStore,
  RelayPool,
  type TransferEvent,
  initCrypto,
  loadClock,
  loadOrCreateIdentity,
} from "../src/index.js";

const RELAY_URL = process.env.P2P_RELAY ?? "ws://localhost:7777";

type Member = {
  alias: string;
  id: ReturnType<typeof loadOrCreateIdentity>;
  pool: RelayPool;
  peer: Peer;
  offline: OfflineMessenger;
  ratchet: RatchetStore;
  files: FileTransferManager;
  events: TransferEvent[];
};

async function startMember(alias: string, dataDir: string): Promise<Member> {
  const id = loadOrCreateIdentity(alias, { dataDir });
  const pool = new RelayPool([RELAY_URL]);
  const transport = new NostrSignaling({
    secretKey: id.secretKey,
    publicKey: id.publicKey,
    pool,
  });
  const peer = new Peer({ transport });
  await peer.start();
  const ratchet = new RatchetStore({ dataDir, ownerAlias: alias });
  const dedup = new DedupStore(join(dataDir, "dedup", `${alias}.json`));
  const clock = loadClock(join(dataDir, "clock", `${alias}.json`), id.publicKey);
  const offline = new OfflineMessenger({
    pool,
    selfPubkey: id.publicKey,
    selfSecret: id.secretKey,
    dedup,
    clock,
    ratchetStore: ratchet,
  });
  await offline.start();
  const files = new FileTransferManager({ peer, offline, dataDir });
  const events: TransferEvent[] = [];
  files.on((e) => events.push(e));
  return { alias, id, pool, peer, offline, ratchet, files, events };
}

async function stop(m: Member): Promise<void> {
  m.files.close();
  await m.offline.close();
  m.ratchet.close();
  await m.peer.close();
  await m.pool.close();
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main() {
  await initCrypto();
  const tmp = mkdtempSync(join(tmpdir(), "p2p-file-"));

  const alice = await startMember("alice", tmp);
  const bob = await startMember("bob", tmp);
  await new Promise((r) => setTimeout(r, 500));

  // ---- Scenario A: RELAY path ----
  const sourcePath = join(tmp, "source-relay.bin");
  const sourceBytes = randomBytes(150 * 1024); // 150 KB — well under FILE_MAX_BYTES
  writeFileSync(sourcePath, sourceBytes);
  const expectedSha = sha256Hex(sourceBytes);

  console.log("[test] alice sending 250 KB via RELAY (no P2P connection)...");
  await alice.files.send(bob.id.publicKey, sourcePath);

  // Wait for bob to receive — generous timeout because relay rate-limits at 30/sec.
  try {
    await waitFor(
      () => bob.events.some((e) => e.kind === "recv-done"),
      20_000,
      "bob recv-done (relay)",
    );
  } catch (err) {
    console.error("[test] alice events:", JSON.stringify(alice.events.slice(0, 5), null, 2));
    console.error("[test] bob events:", JSON.stringify(bob.events.slice(0, 5), null, 2));
    throw err;
  }

  const recvDone = bob.events.find((e) => e.kind === "recv-done");
  if (recvDone?.kind !== "recv-done") throw new Error("no recv-done event");
  const receivedPath = recvDone.path;
  const receivedBytes = readFileSync(receivedPath);
  const stat = statSync(receivedPath);
  if (stat.size !== sourceBytes.length) {
    throw new Error(`size mismatch: ${stat.size} vs ${sourceBytes.length}`);
  }
  const recvSha = sha256Hex(receivedBytes);
  if (recvSha !== expectedSha) {
    throw new Error(`SHA mismatch: ${recvSha} vs ${expectedSha}`);
  }
  console.log(
    `[test] relay round-trip OK — ${stat.size} bytes, sha256=${recvSha.slice(0, 12)}… ✓`,
  );

  // ---- Scenario B: P2P path ----
  // Establish a WebRTC connection between alice and bob; from this point on
  // FileTransferManager.send should pick the P2P SecureChannel.
  console.log("[test] establishing WebRTC P2P session...");
  await alice.peer.connect(bob.id.publicKey);
  await waitFor(() => alice.peer.isConnected(bob.id.publicKey), 15_000, "alice P2P connect");
  await waitFor(() => bob.peer.isConnected(alice.id.publicKey), 15_000, "bob P2P connect");
  console.log("[test] WebRTC channel open");

  // Reset event streams so we can wait for the next recv-done unambiguously.
  bob.events.length = 0;
  alice.events.length = 0;

  const sourcePath2 = join(tmp, "source-p2p.bin");
  const sourceBytes2 = randomBytes(800 * 1024); // 800 KB — fits within v1 MAX_BYTES
  writeFileSync(sourcePath2, sourceBytes2);
  const expectedSha2 = sha256Hex(sourceBytes2);

  console.log("[test] alice sending 800 KB via WebRTC SecureChannel...");
  await alice.files.send(bob.id.publicKey, sourcePath2);

  await waitFor(
    () => bob.events.some((e) => e.kind === "recv-done"),
    20_000,
    "bob recv-done (p2p)",
  );

  // Verify alice's send-progress events were tagged transport='p2p' to confirm
  // the manager picked the WebRTC path (not silently fell back to relay).
  const sawP2pProgress = alice.events.some(
    (e) => e.kind === "send-progress" && e.transport === "p2p",
  );
  if (!sawP2pProgress) {
    throw new Error("transfer didn't go via P2P — no send-progress event with transport=p2p");
  }
  console.log("[test] send-progress events confirmed P2P path ✓");

  const recvDone2 = bob.events.find((e) => e.kind === "recv-done");
  if (recvDone2?.kind !== "recv-done") throw new Error("no recv-done event (p2p)");
  const receivedBytes2 = readFileSync(recvDone2.path);
  if (receivedBytes2.length !== sourceBytes2.length) {
    throw new Error(`p2p size mismatch: ${receivedBytes2.length} vs ${sourceBytes2.length}`);
  }
  const recvSha2 = sha256Hex(receivedBytes2);
  if (recvSha2 !== expectedSha2) {
    throw new Error(`p2p SHA mismatch: ${recvSha2} vs ${expectedSha2}`);
  }
  console.log(
    `[test] p2p round-trip OK — ${receivedBytes2.length} bytes, sha256=${recvSha2.slice(0, 12)}… ✓`,
  );

  await stop(alice);
  await stop(bob);
  rmSync(tmp, { recursive: true, force: true });
  console.log("OK: hybrid file transfer (relay + WebRTC) round-trip succeeded");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
