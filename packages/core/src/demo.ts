/**
 * Phase 1 demo (legacy WS signaling) — proves the transport refactor preserves
 * behavior. Run with the WS signaling server up on :8080.
 */
import { Peer, initCrypto, WebSocketSignaling } from "./index.js";

async function main() {
  await initCrypto();
  const url = "ws://localhost:8080";

  const aliceTransport = new WebSocketSignaling({ url, selfId: "alice" });
  const bobTransport = new WebSocketSignaling({ url, selfId: "bob" });

  const alice = new Peer({ transport: aliceTransport });
  const bob = new Peer({ transport: bobTransport });

  const received: { from: string; text: string }[] = [];
  alice.onMessage((from, text) => received.push({ from, text }));
  bob.onMessage((from, text) => received.push({ from, text }));

  await alice.start();
  await bob.start();
  await new Promise((r) => setTimeout(r, 200));

  await bob.connect("alice");

  await new Promise<void>((resolve) => {
    alice.onConnect(() => resolve());
  });
  await new Promise((r) => setTimeout(r, 100));

  bob.send("alice", "hello from bob");
  alice.send("bob", "hi bob, encrypted reply");

  await new Promise((r) => setTimeout(r, 300));

  console.log("received messages:", received);

  await alice.close();
  await bob.close();

  const ok =
    received.some((m) => m.from === "bob" && m.text === "hello from bob") &&
    received.some((m) => m.from === "alice" && m.text === "hi bob, encrypted reply");

  if (!ok) {
    console.error("FAIL: expected messages not received");
    process.exit(1);
  }
  console.log("OK: ws transport round-trip succeeded");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
