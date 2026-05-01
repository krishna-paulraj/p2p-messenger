/**
 * Phase 4 integration test: Sender Keys group messaging.
 *
 *   1. alice creates group "trio", invites bob and charlie.
 *   2. bob and charlie accept (each sends own sender key to the others).
 *   3. all three exchange messages — each receiver decrypts using the
 *      sender's chain key + counter.
 *   4. bob leaves. alice and charlie rotate own keys + redistribute.
 *   5. alice sends a post-leave message; charlie receives it.
 *   6. bob (still subscribed) cannot decrypt the post-leave message —
 *      his stored peer-chain for alice is at the old epoch.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GroupMessenger,
  GroupStore,
  RelayPool,
  initCrypto,
  loadOrCreateIdentity,
} from "../src/index.js";

const RELAY_URL = process.env.P2P_RELAY ?? "ws://localhost:7777";

type Member = {
  id: { secretKey: Uint8Array; publicKey: string; alias: string };
  pool: RelayPool;
  store: GroupStore;
  messenger: GroupMessenger;
  inbox: { groupId: string; from: string; text: string }[];
  invites: { groupId: string; eventId: string }[];
};

async function startMember(name: string, dataDir: string): Promise<Member> {
  const id = loadOrCreateIdentity(name, { dataDir });
  const pool = new RelayPool([RELAY_URL]);
  const store = new GroupStore({ dataDir, ownerAlias: name });
  const messenger = new GroupMessenger({
    pool,
    selfPubkey: id.publicKey,
    selfSecret: id.secretKey,
    store,
  });
  const inbox: Member["inbox"] = [];
  const invites: Member["invites"] = [];
  messenger.onMessage((m) => inbox.push({ groupId: m.groupId, from: m.from, text: m.text }));
  messenger.onInvite((i) => invites.push({ groupId: i.groupId, eventId: i.eventId }));
  await messenger.start();
  return { id, pool, store, messenger, inbox, invites };
}

async function stop(m: Member): Promise<void> {
  await m.messenger.close();
  m.store.close();
  await m.pool.close();
}

async function main() {
  await initCrypto();
  const tmp = mkdtempSync(join(tmpdir(), "p2p-group-"));

  const alice = await startMember("alice", tmp);
  const bob = await startMember("bob", tmp);
  const charlie = await startMember("charlie", tmp);
  await new Promise((r) => setTimeout(r, 500));

  // --- Step 1: alice creates the group + invites bob and charlie
  const trio = alice.messenger.createGroup("trio");
  await alice.messenger.invite({ groupId: trio.id, peerPubkey: bob.id.publicKey });
  await alice.messenger.invite({ groupId: trio.id, peerPubkey: charlie.id.publicKey });

  await waitFor(() => bob.invites.length > 0 && charlie.invites.length > 0, 5000, "invites");
  console.log("[test] bob and charlie received invites ✓");

  // --- Step 2: bob and charlie accept
  await bob.messenger.accept(bob.invites[0].eventId);
  await charlie.messenger.accept(charlie.invites[0].eventId);
  await new Promise((r) => setTimeout(r, 800)); // sender key distribution settles

  const aliceGroup = alice.store.get(trio.id)!;
  const bobGroup = bob.store.get(trio.id)!;
  const charlieGroup = charlie.store.get(trio.id)!;
  if (
    aliceGroup.members.length !== 3 ||
    bobGroup.members.length !== 3 ||
    charlieGroup.members.length !== 3
  ) {
    console.error("FAIL: not all members converged on full membership", {
      alice: aliceGroup.members.length,
      bob: bobGroup.members.length,
      charlie: charlieGroup.members.length,
    });
    process.exit(1);
  }
  console.log("[test] full membership converged across all 3 peers ✓");

  // --- Step 3: each member sends a message; verify others decrypt successfully
  await alice.messenger.send(trio.id, "alice: hello team");
  await bob.messenger.send(trio.id, "bob: hi everyone");
  await charlie.messenger.send(trio.id, "charlie: hey hey");

  await waitFor(
    () => alice.inbox.length >= 2 && bob.inbox.length >= 2 && charlie.inbox.length >= 2,
    7000,
    "all 3 inboxes have 2+ messages",
  );

  if (
    !alice.inbox.some((m) => m.from === bob.id.publicKey && m.text === "bob: hi everyone") ||
    !alice.inbox.some(
      (m) => m.from === charlie.id.publicKey && m.text === "charlie: hey hey",
    ) ||
    !bob.inbox.some((m) => m.from === alice.id.publicKey && m.text === "alice: hello team") ||
    !bob.inbox.some(
      (m) => m.from === charlie.id.publicKey && m.text === "charlie: hey hey",
    ) ||
    !charlie.inbox.some(
      (m) => m.from === alice.id.publicKey && m.text === "alice: hello team",
    ) ||
    !charlie.inbox.some((m) => m.from === bob.id.publicKey && m.text === "bob: hi everyone")
  ) {
    console.error("FAIL: missing messages", {
      alice: alice.inbox.map((m) => `${m.from.slice(0, 8)}>${m.text}`),
      bob: bob.inbox.map((m) => `${m.from.slice(0, 8)}>${m.text}`),
      charlie: charlie.inbox.map((m) => `${m.from.slice(0, 8)}>${m.text}`),
    });
    process.exit(1);
  }
  console.log("[test] all 3 members received both other members' messages ✓");

  // Snapshot inbox sizes prior to leave so we can identify post-leave messages.
  const charlieInboxBefore = charlie.inbox.length;

  // --- Step 4: bob leaves
  await bob.messenger.leave(trio.id);
  await new Promise((r) => setTimeout(r, 800)); // alice + charlie process leave + rotate

  const aliceGroupAfter = alice.store.get(trio.id)!;
  const charlieGroupAfter = charlie.store.get(trio.id)!;
  if (
    aliceGroupAfter.members.includes(bob.id.publicKey) ||
    charlieGroupAfter.members.includes(bob.id.publicKey)
  ) {
    console.error("FAIL: bob still listed as member after leave");
    process.exit(1);
  }
  console.log("[test] bob removed from membership for alice & charlie ✓");

  // Verify epoch bumped from rotation
  if (aliceGroupAfter.ownEpoch < 1 || charlieGroupAfter.ownEpoch < 1) {
    console.error("FAIL: epoch did not advance on leave-rotation", {
      aliceEpoch: aliceGroupAfter.ownEpoch,
      charlieEpoch: charlieGroupAfter.ownEpoch,
    });
    process.exit(1);
  }
  console.log("[test] alice & charlie rotated to new epoch ✓");

  // --- Step 5: alice sends post-leave; charlie should receive
  await alice.messenger.send(trio.id, "alice: post-leave message");

  await waitFor(
    () =>
      charlie.inbox.length > charlieInboxBefore &&
      charlie.inbox.some(
        (m) => m.from === alice.id.publicKey && m.text === "alice: post-leave message",
      ),
    7000,
    "charlie receives alice's post-leave",
  );
  console.log("[test] charlie received alice's post-leave message ✓");

  // --- Step 6: bob should NOT receive the post-leave
  // (He's still subscribed but should be dropping events for groups he no longer
  // tracks, OR his stored peer chain for alice is at the OLD epoch and the new
  // message is at the NEW epoch — message gets dropped with epoch-mismatch warn.)
  const bobGotPostLeave = bob.inbox.some(
    (m) => m.from === alice.id.publicKey && m.text === "alice: post-leave message",
  );
  if (bobGotPostLeave) {
    console.error("FAIL: bob received post-leave message — Sender Keys rotation is broken");
    process.exit(1);
  }
  console.log("[test] bob blocked from post-leave (forward secrecy on member departure) ✓");

  await stop(alice);
  await stop(bob);
  await stop(charlie);
  rmSync(tmp, { recursive: true, force: true });

  console.log("OK: 3-member group with Sender Keys + member-leave rotation");
  process.exit(0);
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`waitFor timeout: ${label}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
