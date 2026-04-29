import { Peer, initCrypto } from "./index.js";

async function main() {
  await initCrypto();
  const url = "ws://localhost:8080";

  const alice = new Peer({ signalingUrl: url, selfId: "alice" });
  const bob = new Peer({ signalingUrl: url, selfId: "bob" });

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

  alice.close();
  bob.close();

  const ok =
    received.some((m) => m.from === "bob" && m.text === "hello from bob") &&
    received.some((m) => m.from === "alice" && m.text === "hi bob, encrypted reply");

  if (!ok) {
    console.error("FAIL: expected messages not received");
    process.exit(1);
  }
  console.log("OK: round-trip encrypted exchange succeeded");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
