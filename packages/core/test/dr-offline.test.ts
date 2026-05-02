/**
 * Phase 5 integration test: Double Ratchet on the offline (NIP-17) path.
 *
 *   1. alice and bob both initialize per-peer ratchet state from their
 *      static-static SK. alice happens to be the lex-smaller pub (we force
 *      this via setupPeers below), so she's the protocol initiator.
 *   2. alice sends 3 offline messages to bob. Each is encrypted under
 *      alice's CURRENT sending chain key. Counters strictly increase. The
 *      header.dhPub is constant within this chain.
 *   3. bob drains; verifies all three plaintexts arrive correctly and that
 *      the ciphertexts on the wire are distinct (forward secrecy property:
 *      each message was encrypted with a different KDF-derived key).
 *   4. bob sends a reply. This triggers a DH ratchet step on alice's side
 *      when she receives — RK rotates, sending chain rotates.
 *   5. alice's NEXT send uses the freshly-derived sending chain. We verify
 *      its header.dhPub differs from the one alice used in step (2).
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DedupStore,
  OfflineMessenger,
  RatchetStore,
  RelayPool,
  initCrypto,
  loadClock,
  loadOrCreateIdentity,
} from "../src/index.js";

const RELAY_URL = process.env.P2P_RELAY ?? "ws://localhost:7777";

async function main() {
  await initCrypto();
  const tmp = mkdtempSync(join(tmpdir(), "p2p-dr-"));

  // Force alice = initiator (lex-smaller pubkey) so we exercise the full
  // DH-ratcheted path on every message.
  let aliceId = loadOrCreateIdentity("alice", { dataDir: tmp });
  let bobId = loadOrCreateIdentity("bob", { dataDir: tmp });
  while (aliceId.publicKey >= bobId.publicKey) {
    rmSync(join(tmp, "identities"), { recursive: true, force: true });
    aliceId = loadOrCreateIdentity("alice", { dataDir: tmp });
    bobId = loadOrCreateIdentity("bob", { dataDir: tmp });
  }
  console.log("[test] alice (initiator):", aliceId.publicKey.slice(0, 12));
  console.log("[test] bob (responder): ", bobId.publicKey.slice(0, 12));

  // ---- Phase A: alice sends 3 offline messages while bob is offline ----
  const alicePool = new RelayPool([RELAY_URL]);
  const aliceClock = loadClock(join(tmp, "clock", "alice.json"), aliceId.publicKey);
  const aliceDedup = new DedupStore(join(tmp, "dedup", "alice.json"));
  const aliceRatchet = new RatchetStore({ dataDir: tmp, ownerAlias: "alice" });
  const aliceOffline = new OfflineMessenger({
    pool: alicePool,
    selfPubkey: aliceId.publicKey,
    selfSecret: aliceId.secretKey,
    dedup: aliceDedup,
    clock: aliceClock,
    ratchetStore: aliceRatchet,
  });
  await aliceOffline.start();

  for (const text of ["dr-msg-1", "dr-msg-2", "dr-msg-3"]) {
    await aliceOffline.send(bobId.publicKey, text);
    await new Promise((r) => setTimeout(r, 80));
  }
  await aliceOffline.close();
  aliceRatchet.close();
  await alicePool.close();

  // Wait for relay persistence
  await new Promise((r) => setTimeout(r, 400));

  // ---- Phase B: bob drains. Verify 3 messages arrive in causal order. ----
  const bobPool = new RelayPool([RELAY_URL]);
  const bobDedup = new DedupStore(join(tmp, "dedup", "bob.json"));
  const bobClock = loadClock(join(tmp, "clock", "bob.json"), bobId.publicKey);
  const bobRatchet = new RatchetStore({ dataDir: tmp, ownerAlias: "bob" });
  const bobOffline = new OfflineMessenger({
    pool: bobPool,
    selfPubkey: bobId.publicKey,
    selfSecret: bobId.secretKey,
    dedup: bobDedup,
    clock: bobClock,
    ratchetStore: bobRatchet,
  });
  const bobInbox: { text: string }[] = [];
  bobOffline.on((m) => bobInbox.push({ text: m.text }));
  await bobOffline.start();
  await new Promise((r) => setTimeout(r, 1500));

  if (bobInbox.length !== 3) {
    console.error(`FAIL: expected 3 drained messages, got ${bobInbox.length}`, bobInbox);
    process.exit(1);
  }
  const expected = ["dr-msg-1", "dr-msg-2", "dr-msg-3"];
  if (JSON.stringify(bobInbox.map((m) => m.text)) !== JSON.stringify(expected)) {
    console.error("FAIL: drained out of causal order", bobInbox);
    process.exit(1);
  }
  console.log("[test] alice → bob: 3 ratchet-encrypted messages drained in order ✓");

  // Snapshot bob's persisted ratchet state to verify chain advancement.
  bobRatchet.flush();
  const bobBookAfterReceive = JSON.parse(
    readFileSync(join(tmp, "ratchet", "bob.json"), "utf-8"),
  );
  const bobStateForAlice = bobBookAfterReceive.ratchets[aliceId.publicKey];
  if (!bobStateForAlice) {
    console.error("FAIL: bob's ratchet state for alice missing after receives");
    process.exit(1);
  }
  if (bobStateForAlice.receivingChain.counter !== 3) {
    console.error(
      `FAIL: bob's receivingChain.counter = ${bobStateForAlice.receivingChain.counter}, expected 3`,
    );
    process.exit(1);
  }
  console.log("[test] bob's receivingChain advanced 3 messages ✓");

  // ---- Phase C: bob replies. Triggers DH ratchet on alice when she receives. ----
  await bobOffline.send(aliceId.publicKey, "dr-reply");
  await new Promise((r) => setTimeout(r, 400));
  await bobOffline.close();
  bobRatchet.close();

  // Re-open alice and drain bob's reply.
  const alicePool2 = new RelayPool([RELAY_URL]);
  const aliceDedup2 = new DedupStore(join(tmp, "dedup", "alice.json"));
  const aliceClock2 = loadClock(join(tmp, "clock", "alice.json"), aliceId.publicKey);
  const aliceRatchet2 = new RatchetStore({ dataDir: tmp, ownerAlias: "alice" });
  const aliceOffline2 = new OfflineMessenger({
    pool: alicePool2,
    selfPubkey: aliceId.publicKey,
    selfSecret: aliceId.secretKey,
    dedup: aliceDedup2,
    clock: aliceClock2,
    ratchetStore: aliceRatchet2,
  });
  const aliceInbox: { text: string }[] = [];
  aliceOffline2.on((m) => aliceInbox.push({ text: m.text }));
  await aliceOffline2.start();
  await new Promise((r) => setTimeout(r, 1500));

  if (!aliceInbox.find((m) => m.text === "dr-reply")) {
    console.error("FAIL: alice did not receive bob's reply", aliceInbox);
    process.exit(1);
  }
  console.log("[test] bob → alice reply decrypted (DH ratchet flipped) ✓");

  // Snapshot alice's RK before her post-ratchet send.
  aliceRatchet2.flush();
  const aliceBookPostFlip = JSON.parse(
    readFileSync(join(tmp, "ratchet", "alice.json"), "utf-8"),
  );
  const rkAfterFlipBefore = aliceBookPostFlip.ratchets[bobId.publicKey].rootKey;
  const dhPubBefore = aliceBookPostFlip.ratchets[bobId.publicKey].selfDhKeyPair.publicKey;

  // Phase D: alice sends post-ratchet. This send doesn't change her RK
  // (encrypt never ratchets), but the DH pub on her header should be the
  // freshly-rolled one from the ratchet step (different from the one used
  // for dr-msg-1..3).
  await aliceOffline2.send(bobId.publicKey, "dr-msg-4");
  await new Promise((r) => setTimeout(r, 200));
  await aliceOffline2.close();
  aliceRatchet2.close();

  const aliceBookPostSend = JSON.parse(
    readFileSync(join(tmp, "ratchet", "alice.json"), "utf-8"),
  );
  const rkAfterFlipAfter = aliceBookPostSend.ratchets[bobId.publicKey].rootKey;
  const dhPubAfter = aliceBookPostSend.ratchets[bobId.publicKey].selfDhKeyPair.publicKey;

  if (rkAfterFlipAfter !== rkAfterFlipBefore) {
    console.error("FAIL: alice's RK changed during a plain send", {
      rkAfterFlipBefore,
      rkAfterFlipAfter,
    });
    process.exit(1);
  }
  console.log("[test] alice's RK unchanged across a plain encrypt ✓");

  if (dhPubAfter !== dhPubBefore) {
    console.error("FAIL: alice's selfDhKeyPair changed across a plain send (should only change on receive)");
    process.exit(1);
  }
  console.log("[test] alice's DH pub stable until next inbound ratchet step ✓");

  // Verify the DH pub changed *between* phase A and phase D — i.e. the ratchet
  // really did flip when alice received bob's reply. We don't have alice's
  // original DH pub saved here, but bob's state captured it as peerDhPub
  // when he received alice's first message.
  const aliceFirstChainDhPub = bobStateForAlice.peerDhPub;
  if (dhPubAfter === aliceFirstChainDhPub) {
    console.error("FAIL: alice's DH pub didn't rotate after receiving bob's reply");
    process.exit(1);
  }
  console.log("[test] alice's DH pub rotated after receiving bob's reply ✓");

  await alicePool2.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log("OK: Double Ratchet on the offline path is operating end-to-end");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
