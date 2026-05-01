/**
 * Phase 2 integration test: presence + contact resolution.
 *   - alice publishes presence
 *   - bob subscribes to alice's presence pubkey via PresenceWatcher
 *   - bob sees alice come online and uses that to dial
 *   - bob's contact book resolves "alice" alias to her pubkey
 *   - exchange a message after the dial completes
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContactBook,
  NostrSignaling,
  Peer,
  PresencePublisher,
  PresenceWatcher,
  RelayPool,
  initCrypto,
  loadOrCreateIdentity,
  resolvePeer,
} from "../src/index.js";

const RELAY_URL = process.env.P2P_RELAY ?? "ws://localhost:7777";

async function main() {
  await initCrypto();

  const tmp = mkdtempSync(join(tmpdir(), "p2p-discovery-"));

  const aliceId = loadOrCreateIdentity("alice", { dataDir: tmp });
  const bobId = loadOrCreateIdentity("bob", { dataDir: tmp });

  const alicePool = new RelayPool([RELAY_URL]);
  const bobPool = new RelayPool([RELAY_URL]);

  const aliceTransport = new NostrSignaling({
    secretKey: aliceId.secretKey,
    publicKey: aliceId.publicKey,
    pool: alicePool,
  });
  const bobTransport = new NostrSignaling({
    secretKey: bobId.secretKey,
    publicKey: bobId.publicKey,
    pool: bobPool,
  });

  const alice = new Peer({ transport: aliceTransport });
  const bob = new Peer({ transport: bobTransport });

  // Bob's contact book — alice is a known contact
  const bobContacts = new ContactBook({ dataDir: tmp, ownerAlias: "bob" });
  bobContacts.add({ alias: "alice", pubkey: aliceId.publicKey });

  // Verify alias resolution works
  const resolved = await resolvePeer("alice", bobContacts);
  if (resolved.pubkey !== aliceId.publicKey) {
    throw new Error(`alias resolution failed: ${resolved.pubkey} !== ${aliceId.publicKey}`);
  }
  console.log("[test] alias resolution OK");

  // Bob watches alice's presence
  const bobWatcher = new PresenceWatcher(bobPool);
  let aliceCameOnline = false;
  bobWatcher.on((snap) => {
    if (snap.pubkey === aliceId.publicKey && snap.status === "online") {
      aliceCameOnline = true;
    }
  });
  bobWatcher.watch([aliceId.publicKey]);

  // Alice publishes presence
  const alicePresence = new PresencePublisher({
    pool: alicePool,
    secretKey: aliceId.secretKey,
    publicKey: aliceId.publicKey,
    heartbeatMs: 10_000,
  });

  const received: { who: string; from: string; text: string }[] = [];
  alice.onMessage((from, text) => received.push({ who: "alice", from, text }));
  bob.onMessage((from, text) => received.push({ who: "bob", from, text }));

  await alice.start();
  await bob.start();
  await alicePresence.start();
  await new Promise((r) => setTimeout(r, 1000));

  if (!aliceCameOnline) throw new Error("bob never saw alice's presence");
  console.log("[test] bob saw alice come online ✓");

  if (!bobWatcher.isOnline(aliceId.publicKey)) {
    throw new Error("PresenceWatcher.isOnline returned false for fresh online event");
  }
  console.log("[test] PresenceWatcher.isOnline ✓");

  // Bob dials alice using the alias resolution
  await bob.connect(resolved.pubkey);

  await Promise.race([
    new Promise<void>((resolve) => alice.onConnect(() => resolve())),
    timeoutErr(15000, "alice never received connection"),
  ]);
  await new Promise((r) => setTimeout(r, 200));

  bob.send(aliceId.publicKey, "discovered you via presence!");
  alice.send(bobId.publicKey, "found by alias resolution!");

  await new Promise((r) => setTimeout(r, 500));

  await alicePresence.stop();
  bobWatcher.close();
  await alice.close();
  await bob.close();
  await alicePool.close();
  await bobPool.close();
  rmSync(tmp, { recursive: true, force: true });

  const ok =
    received.find(
      (m) => m.who === "alice" && m.text === "discovered you via presence!",
    ) &&
    received.find(
      (m) => m.who === "bob" && m.text === "found by alias resolution!",
    );

  if (!ok) {
    console.error("FAIL", received);
    process.exit(1);
  }
  console.log("OK: discovery + alias resolution + WebRTC handshake all succeeded");
  process.exit(0);
}

function timeoutErr(ms: number, msg: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
