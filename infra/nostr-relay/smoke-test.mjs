// Smoke test: publish a signed event to the local relay and read it back via subscription.
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { Relay, useWebSocketImplementation } from "nostr-tools/relay";
import WebSocket from "ws";

useWebSocketImplementation(WebSocket);

const RELAY_URL = "ws://localhost:7777";
const NONCE = `p2p-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function main() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  console.log("[test] pubkey:", pk);

  const relay = await Relay.connect(RELAY_URL);
  console.log("[test] connected to", relay.url);

  // Subscribe BEFORE publishing so we receive the event when it arrives
  const received = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timeout waiting for event")), 5000);
    const sub = relay.subscribe(
      [{ kinds: [1], authors: [pk], "#t": ["p2p-smoke"], limit: 10 }],
      {
        onevent(ev) {
          if (ev.content === NONCE) {
            clearTimeout(timeout);
            sub.close();
            resolve(ev);
          }
        },
        oneose() {
          // EOSE = end of stored events; we'll wait for live publish below
        },
      },
    );
  });

  const event = finalizeEvent(
    {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["t", "p2p-smoke"]],
      content: NONCE,
    },
    sk,
  );

  await relay.publish(event);
  console.log("[test] published event id:", event.id);

  const got = await received;
  console.log("[test] received event id:", got.id, "content:", got.content);

  if (got.id !== event.id) throw new Error("event id mismatch");
  if (got.content !== NONCE) throw new Error("content mismatch");

  relay.close();
  console.log("OK: relay accepts events and serves subscriptions");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
