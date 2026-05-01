/**
 * Regression test for the stale-signaling-replay crash.
 *
 *   1. bob dials alice; they handshake; exchange a message.
 *   2. alice's process closes — bob's PC stays in `stable`.
 *   3. while alice is gone, bob sends two offline (NIP-17) messages.
 *   4. alice restarts. The relay's gift-wrap history now contains both:
 *        a) bob's OLD offer/ICE wraps from step 1
 *        b) bob's two chat-message wraps from step 3
 *      The fix must:
 *        - DROP (a) at the signaling layer (rumor older than 5 minutes)
 *        - DELIVER (b) via OfflineMessenger (those are within freshness +
 *          they're a different inner kind anyway)
 *        - NOT CRASH the process with InvalidStateError on bob's side
 *          (i.e. alice must not send a new answer for bob's old offer).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DedupStore,
  NostrSignaling,
  OfflineMessenger,
  Peer,
  RelayPool,
  initCrypto,
  loadClock,
  loadOrCreateIdentity,
} from "../src/index.js";

const RELAY_URL = process.env.P2P_RELAY ?? "ws://localhost:7777";

async function main() {
  await initCrypto();
  const tmp = mkdtempSync(join(tmpdir(), "p2p-replay-"));

  const aliceId = loadOrCreateIdentity("alice", { dataDir: tmp });
  const bobId = loadOrCreateIdentity("bob", { dataDir: tmp });

  const bobPool = new RelayPool([RELAY_URL]);
  const bobSignal = new NostrSignaling({
    secretKey: bobId.secretKey,
    publicKey: bobId.publicKey,
    pool: bobPool,
  });
  const bob = new Peer({ transport: bobSignal });
  await bob.start();

  // ---- Round 1: alice up, full handshake, exchange one message ----
  const alicePool1 = new RelayPool([RELAY_URL]);
  const aliceSignal1 = new NostrSignaling({
    secretKey: aliceId.secretKey,
    publicKey: aliceId.publicKey,
    pool: alicePool1,
  });
  const alice1 = new Peer({ transport: aliceSignal1 });
  await alice1.start();
  await new Promise((r) => setTimeout(r, 400));

  const aliceMessages1: string[] = [];
  alice1.onMessage((_from, text) => aliceMessages1.push(text));

  await bob.connect(aliceId.publicKey);
  await Promise.race([
    new Promise<void>((res) => alice1.onConnect(() => res())),
    timeoutErr(15000, "alice (round 1) never received connection"),
  ]);
  await new Promise((r) => setTimeout(r, 200));
  bob.send(aliceId.publicKey, "round-1 hi from bob");
  await new Promise((r) => setTimeout(r, 300));

  if (!aliceMessages1.includes("round-1 hi from bob")) {
    throw new Error("round 1 message lost");
  }
  console.log("[test] round 1 handshake + message OK");

  // ---- Alice goes away ----
  await alice1.close();
  await alicePool1.close();
  await new Promise((r) => setTimeout(r, 200));

  // ---- Bob sends two offline messages while alice is gone ----
  const bobOfflineDedup = new DedupStore(join(tmp, "dedup", "bob-offline-send.json"));
  const bobClock = loadClock(join(tmp, "clock", "bob.json"), bobId.publicKey);
  const bobOffline = new OfflineMessenger({
    pool: bobPool,
    selfPubkey: bobId.publicKey,
    selfSecret: bobId.secretKey,
    dedup: bobOfflineDedup,
    clock: bobClock,
  });
  await bobOffline.start();
  await bobOffline.send(aliceId.publicKey, "offline-1: are you there?");
  await new Promise((r) => setTimeout(r, 100));
  await bobOffline.send(aliceId.publicKey, "offline-2: ping");
  await new Promise((r) => setTimeout(r, 500));
  console.log("[test] bob published 2 offline messages while alice was down");

  // ---- Round 2: alice restarts ----
  // Hook process-level errors so a crash in onSignaling shows up as a test fail.
  let crashed = false;
  const onError = (err: unknown) => {
    crashed = true;
    console.error("[test] CAUGHT process error:", err);
  };
  process.on("uncaughtException", onError);
  process.on("unhandledRejection", onError);

  const alicePool2 = new RelayPool([RELAY_URL]);
  const aliceSignal2 = new NostrSignaling({
    secretKey: aliceId.secretKey,
    publicKey: aliceId.publicKey,
    pool: alicePool2,
  });
  const alice2 = new Peer({ transport: aliceSignal2 });
  await alice2.start();

  const aliceDedup = new DedupStore(join(tmp, "dedup", "alice.json"));
  const aliceClock = loadClock(join(tmp, "clock", "alice.json"), aliceId.publicKey);
  const aliceOffline = new OfflineMessenger({
    pool: alicePool2,
    selfPubkey: aliceId.publicKey,
    selfSecret: aliceId.secretKey,
    dedup: aliceDedup,
    clock: aliceClock,
  });
  const drained: string[] = [];
  aliceOffline.on((m) => drained.push(m.text));
  await aliceOffline.start();

  // Hold for a few seconds so:
  //   - the relay replays bob's stale signaling wraps (must be dropped)
  //   - the relay delivers bob's offline wraps (must arrive)
  //   - any NEW signaling sent by alice for bob's stale offer would round-trip
  //     and could trigger bob's setRemoteDescription error
  await new Promise((r) => setTimeout(r, 3000));

  process.off("uncaughtException", onError);
  process.off("unhandledRejection", onError);

  await aliceOffline.close();
  await alice2.close();
  await alicePool2.close();
  await bobOffline.close();
  await bob.close();
  await bobPool.close();
  rmSync(tmp, { recursive: true, force: true });

  if (crashed) {
    console.error("FAIL: process emitted uncaught error during replay");
    process.exit(1);
  }
  if (!drained.includes("offline-1: are you there?") || !drained.includes("offline-2: ping")) {
    console.error("FAIL: offline messages not drained", { drained });
    process.exit(1);
  }
  console.log("[test] no crash on stale replay ✓");
  console.log("[test] both offline messages drained ✓");
  console.log("OK: restart replay handled cleanly");
  process.exit(0);
}

function timeoutErr(ms: number, msg: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
