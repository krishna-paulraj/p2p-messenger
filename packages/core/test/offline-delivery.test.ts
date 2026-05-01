/**
 * Phase 3 integration test: offline delivery via NIP-17 + drain on restart.
 *
 * Flow:
 *   1. Alice + bob each create identities (persisted to a tmp dataDir).
 *   2. Bob is NEVER actually online during the sends — alice publishes 3
 *      gift-wrapped chat events to the relay.
 *   3. Bob wakes up, opens an OfflineMessenger, and drains the queue.
 *   4. Verify all 3 messages arrive, in order, with correct vector clocks.
 *   5. Restart bob a second time and confirm dedup — no replay.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DedupStore,
  OfflineMessenger,
  RelayPool,
  compareClocks,
  initCrypto,
  loadClock,
  loadOrCreateIdentity,
  saveClock,
} from "../src/index.js";

const RELAY_URL = process.env.P2P_RELAY ?? "ws://localhost:7777";

async function main() {
  await initCrypto();
  const tmp = mkdtempSync(join(tmpdir(), "p2p-offline-"));
  console.log("[test] tmp dir:", tmp);

  const aliceId = loadOrCreateIdentity("alice", { dataDir: tmp });
  const bobId = loadOrCreateIdentity("bob", { dataDir: tmp });

  // ---- Alice sends 3 messages while bob is offline ----
  const alicePool = new RelayPool([RELAY_URL]);
  const aliceClock = loadClock(join(tmp, "clock", "alice.json"), aliceId.publicKey);
  const aliceDedup = new DedupStore(join(tmp, "dedup", "alice.json"));
  const aliceOffline = new OfflineMessenger({
    pool: alicePool,
    selfPubkey: aliceId.publicKey,
    selfSecret: aliceId.secretKey,
    dedup: aliceDedup,
    clock: aliceClock,
  });
  await aliceOffline.start();

  const sent: string[] = [];
  for (const text of ["msg-1: hi bob", "msg-2: are you there?", "msg-3: ping"]) {
    const r = await aliceOffline.send(bobId.publicKey, text);
    sent.push(r.eventId);
    console.log(
      `[alice] sent "${text}" eventId=${r.eventId.slice(0, 8)} clock=${JSON.stringify(r.clock)}`,
    );
    await new Promise((res) => setTimeout(res, 100));
  }
  saveClock(join(tmp, "clock", "alice.json"), aliceClock);
  await aliceOffline.close();
  await alicePool.close();

  // Give relay a moment to fully persist
  await new Promise((res) => setTimeout(res, 500));

  // ---- Bob comes online for the first time and drains ----
  console.log("[test] bob waking up, draining offline queue...");
  const bobPool = new RelayPool([RELAY_URL]);
  const bobClockPath = join(tmp, "clock", "bob.json");
  const bobDedupPath = join(tmp, "dedup", "bob.json");
  let bobClock = loadClock(bobClockPath, bobId.publicKey);
  const bobDedup1 = new DedupStore(bobDedupPath);
  const bobOffline1 = new OfflineMessenger({
    pool: bobPool,
    selfPubkey: bobId.publicKey,
    selfSecret: bobId.secretKey,
    dedup: bobDedup1,
    clock: bobClock,
  });

  const received1: { from: string; text: string; ts: number; clock: Record<string, number> }[] =
    [];
  bobOffline1.on((m) => {
    received1.push({ from: m.from, text: m.text, ts: m.ts, clock: m.clock });
    console.log(
      `[bob1] received from=${m.from.slice(0, 8)} ts=${m.ts} clock=${JSON.stringify(m.clock)} text="${m.text}"`,
    );
  });

  await bobOffline1.start();
  // Allow the relay to push historical wraps
  await new Promise((res) => setTimeout(res, 1500));

  saveClock(bobClockPath, bobClock);
  await bobOffline1.close();

  if (received1.length !== 3) {
    console.error(`FAIL: expected 3 messages, got ${received1.length}`);
    process.exit(1);
  }
  // After the drain-ordering fix, OfflineMessenger emits buffered messages in
  // causal (vector-clock) order — no manual sort required. This is the
  // STRONGER guarantee: the order the receiver SEES is the order the sender
  // intended.
  const orderTexts = received1.map((m) => m.text);
  const expected = ["msg-1: hi bob", "msg-2: are you there?", "msg-3: ping"];
  if (JSON.stringify(orderTexts) !== JSON.stringify(expected)) {
    console.error("FAIL: drain emitted messages out of causal order", { orderTexts });
    process.exit(1);
  }
  console.log("[test] drain emitted messages in causal order (no manual sort) ✓");

  // Sanity: alice's counter is strictly increasing in the emitted order.
  const aliceCounters = received1.map((m) => m.clock[aliceId.publicKey]);
  for (let i = 1; i < aliceCounters.length; i++) {
    if (!(aliceCounters[i] > aliceCounters[i - 1])) {
      console.error("FAIL: alice counter not strictly increasing", aliceCounters);
      process.exit(1);
    }
  }
  console.log("[test] alice's vector counter strictly increasing ✓");

  // compareClocks remains exported & callable — keep a smoke test on the API.
  const c = compareClocks(received1[0].clock, received1[2].clock);
  if (c !== "before") {
    console.error(`FAIL: compareClocks expected "before", got "${c}"`);
    process.exit(1);
  }

  // ---- Bob restarts and confirms dedup (no duplicate delivery) ----
  console.log("[test] bob restarts — should NOT receive duplicates");
  bobClock = loadClock(bobClockPath, bobId.publicKey);
  const bobDedup2 = new DedupStore(bobDedupPath);
  const bobOffline2 = new OfflineMessenger({
    pool: bobPool,
    selfPubkey: bobId.publicKey,
    selfSecret: bobId.secretKey,
    dedup: bobDedup2,
    clock: bobClock,
  });

  const received2: string[] = [];
  bobOffline2.on((m) => received2.push(m.text));
  await bobOffline2.start();
  await new Promise((res) => setTimeout(res, 1200));
  await bobOffline2.close();
  await bobPool.close();

  if (received2.length !== 0) {
    console.error("FAIL: dedup broken — got duplicates on restart", received2);
    process.exit(1);
  }
  console.log("[test] no duplicates on restart ✓");

  rmSync(tmp, { recursive: true, force: true });
  console.log("OK: offline delivery + dedup + vector clocks all working");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
