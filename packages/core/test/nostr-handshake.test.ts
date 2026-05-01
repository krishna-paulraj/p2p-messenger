/**
 * Integration test: two peers complete a WebRTC handshake via the local Nostr relay
 * (NIP-59 gift-wrapped signaling), then exchange XChaCha20-encrypted messages over
 * the resulting data channel. No WebSocket signaling server involved.
 *
 * Run with: relay must be up at ws://localhost:7777 (`pnpm relay:up`).
 *           tsx test/nostr-handshake.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NostrSignaling,
  Peer,
  RelayPool,
  initCrypto,
  loadOrCreateIdentity,
} from "../src/index.js";

const RELAY_URL = process.env.P2P_RELAY ?? "ws://localhost:7777";

async function main() {
  await initCrypto();

  const tmp = mkdtempSync(join(tmpdir(), "p2p-nostr-test-"));
  console.log("[test] tmp data dir:", tmp);

  const aliceId = loadOrCreateIdentity("alice", { dataDir: tmp });
  const bobId = loadOrCreateIdentity("bob", { dataDir: tmp });

  console.log("[test] alice npub:", aliceId.npub);
  console.log("[test] bob   npub:", bobId.npub);

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

  const received: { who: string; from: string; text: string }[] = [];
  alice.onMessage((from, text) => received.push({ who: "alice", from, text }));
  bob.onMessage((from, text) => received.push({ who: "bob", from, text }));

  await alice.start();
  await bob.start();
  // Give subscriptions time to register at the relay
  await new Promise((r) => setTimeout(r, 500));

  console.log("[test] dialing alice from bob via Nostr...");
  await bob.connect(aliceId.publicKey);

  // Wait for the data channel to open (means full WebRTC handshake completed)
  await Promise.race([
    new Promise<void>((resolve) => alice.onConnect(() => resolve())),
    timeoutErr(15000, "alice never received connection"),
  ]);
  await new Promise((r) => setTimeout(r, 200));

  bob.send(aliceId.publicKey, "hello alice via Nostr signaling");
  alice.send(bobId.publicKey, "hi bob, encrypted reply via WebRTC");

  await new Promise((r) => setTimeout(r, 500));

  console.log("[test] received:");
  for (const m of received) {
    console.log(`  ${m.who} got from=${shortPub(m.from)}: ${m.text}`);
  }

  await alice.close();
  await bob.close();
  await alicePool.close();
  await bobPool.close();
  rmSync(tmp, { recursive: true, force: true });

  const aliceGot = received.find(
    (m) =>
      m.who === "alice" &&
      m.from === bobId.publicKey &&
      m.text === "hello alice via Nostr signaling",
  );
  const bobGot = received.find(
    (m) =>
      m.who === "bob" &&
      m.from === aliceId.publicKey &&
      m.text === "hi bob, encrypted reply via WebRTC",
  );

  if (!aliceGot || !bobGot) {
    console.error("FAIL: expected messages not received", { aliceGot, bobGot });
    process.exit(1);
  }
  console.log("OK: WebRTC over Nostr signaling round-trip succeeded");
  process.exit(0);
}

function timeoutErr(ms: number, msg: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
}

function shortPub(p: string): string {
  return p.length > 12 ? `${p.slice(0, 8)}…${p.slice(-4)}` : p;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
