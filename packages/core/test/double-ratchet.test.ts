/**
 * Unit tests for the Double Ratchet primitives.
 *
 * Run: tsx packages/core/test/double-ratchet.test.ts
 *
 * These are pure crypto tests — no relays, no network. The integration test
 * (test/dr-offline.test.ts) covers the over-the-wire flow.
 */
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  decrypt,
  encrypt,
  initRatchet,
  serializeState,
  deserializeState,
  type RatchetState,
} from "../src/nostr/ratchet/double-ratchet.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.error(`  ✗ ${label}`);
    failed += 1;
  }
}

/**
 * Deterministically set up "alice" as the lex-smaller-pubkey peer (the
 * initiator under our protocol's role assignment). Tests can assume alice
 * sends first and gets the full DH-ratchet path.
 */
function setupPeers(): {
  alice: { pub: string; secret: Uint8Array; state: RatchetState };
  bob: { pub: string; secret: Uint8Array; state: RatchetState };
  aad: Uint8Array;
} {
  let aliceSecret = generateSecretKey();
  let bobSecret = generateSecretKey();
  let alicePub = getPublicKey(aliceSecret);
  let bobPub = getPublicKey(bobSecret);
  if (alicePub >= bobPub) {
    [aliceSecret, bobSecret] = [bobSecret, aliceSecret];
    [alicePub, bobPub] = [bobPub, alicePub];
  }

  // Bind AAD to the conversation pair so a stolen ciphertext can't be
  // replayed across conversations.
  const aad = enc(`${alicePub}|${bobPub}`);

  return {
    alice: {
      pub: alicePub,
      secret: aliceSecret,
      state: initRatchet({
        selfPubkeyHex: alicePub,
        selfSecret: aliceSecret,
        peerPubkeyHex: bobPub,
      }),
    },
    bob: {
      pub: bobPub,
      secret: bobSecret,
      state: initRatchet({
        selfPubkeyHex: bobPub,
        selfSecret: bobSecret,
        peerPubkeyHex: alicePub,
      }),
    },
    aad,
  };
}

// ---- Test 1: round-trip ping-pong ----
function testPingPong(): void {
  console.log("[T1] alice↔bob ping-pong");
  const { alice, bob, aad } = setupPeers();

  const m1 = encrypt(alice.state, enc("hi bob"), aad);
  const p1 = decrypt(bob.state, m1.header, m1.ciphertext, aad);
  check("bob decrypts alice's first msg", dec(p1) === "hi bob");

  const m2 = encrypt(bob.state, enc("hi alice"), aad);
  const p2 = decrypt(alice.state, m2.header, m2.ciphertext, aad);
  check("alice decrypts bob's reply", dec(p2) === "hi alice");

  const m3 = encrypt(alice.state, enc("how are you"), aad);
  const p3 = decrypt(bob.state, m3.header, m3.ciphertext, aad);
  check("bob decrypts alice's second msg (post-ratchet)", dec(p3) === "how are you");

  const m4 = encrypt(bob.state, enc("good thanks"), aad);
  const p4 = decrypt(alice.state, m4.header, m4.ciphertext, aad);
  check("alice decrypts bob's second msg", dec(p4) === "good thanks");
}

// ---- Test 2: distinct chain keys per chain (forward secrecy property) ----
function testForwardSecrecy(): void {
  console.log("[T2] each message in a chain has a distinct key");
  const { alice, bob, aad } = setupPeers();

  const m1 = encrypt(alice.state, enc("msg-1"), aad);
  const m2 = encrypt(alice.state, enc("msg-2"), aad);
  const m3 = encrypt(alice.state, enc("msg-3"), aad);

  // Counters must be strictly increasing in the same chain.
  check(
    "counters strictly increasing within a chain",
    m1.header.counter === 0 && m2.header.counter === 1 && m3.header.counter === 2,
  );
  // dhPub stays constant within a chain (no DH ratchet step yet).
  check(
    "dhPub stable within a chain",
    bytesEq(m1.header.dhPub, m2.header.dhPub) && bytesEq(m2.header.dhPub, m3.header.dhPub),
  );
  // Ciphertexts of identical-length plaintexts are different (different keys).
  check("distinct ciphertexts despite same-length plaintext", !bytesEq(m1.ciphertext, m2.ciphertext));

  // Bob can decrypt them in order.
  const p1 = decrypt(bob.state, m1.header, m1.ciphertext, aad);
  const p2 = decrypt(bob.state, m2.header, m2.ciphertext, aad);
  const p3 = decrypt(bob.state, m3.header, m3.ciphertext, aad);
  check("ordered decrypt yields correct plaintexts", dec(p1) === "msg-1" && dec(p2) === "msg-2" && dec(p3) === "msg-3");
}

// ---- Test 3: post-compromise security — RK rotates on direction flip ----
function testPostCompromise(): void {
  console.log("[T3] DH ratchet rotates RK on direction flip");
  const { alice, bob, aad } = setupPeers();

  const rk0 = alice.state.rootKey.slice();

  // Alice sends — does NOT trigger DH ratchet (we always send under the same
  // chain until we receive a new dhPub).
  encrypt(alice.state, enc("a1"), aad);
  check("alice's RK unchanged after sending", bytesEq(alice.state.rootKey, rk0));

  // Bob receives — runs DH ratchet on first message from a new dhPub.
  const m = encrypt(alice.state, enc("a2"), aad);
  const rkBobBefore = bob.state.rootKey.slice();
  decrypt(bob.state, m.header, m.ciphertext, aad);
  check("bob's RK rotated after receiving alice's first message", !bytesEq(bob.state.rootKey, rkBobBefore));

  // Bob replies — RK rotates again on receiver side.
  const r = encrypt(bob.state, enc("b1"), aad);
  const rkAliceBefore = alice.state.rootKey.slice();
  decrypt(alice.state, r.header, r.ciphertext, aad);
  check("alice's RK rotated after receiving bob's reply", !bytesEq(alice.state.rootKey, rkAliceBefore));
}

// ---- Test 4: out-of-order delivery via skipped-keys cache ----
function testOutOfOrder(): void {
  console.log("[T4] out-of-order delivery within a chain");
  const { alice, bob, aad } = setupPeers();

  const m1 = encrypt(alice.state, enc("msg-1"), aad);
  const m2 = encrypt(alice.state, enc("msg-2"), aad);
  const m3 = encrypt(alice.state, enc("msg-3"), aad);

  // Bob receives them out of order: 2, 1, 3.
  const p2 = decrypt(bob.state, m2.header, m2.ciphertext, aad);
  check("bob decrypts m2 first", dec(p2) === "msg-2");

  const p1 = decrypt(bob.state, m1.header, m1.ciphertext, aad);
  check("bob decrypts m1 (from skipped cache)", dec(p1) === "msg-1");

  const p3 = decrypt(bob.state, m3.header, m3.ciphertext, aad);
  check("bob decrypts m3 (advance from current chain position)", dec(p3) === "msg-3");
}

// ---- Test 5: tampered ciphertext rejected ----
function testTamper(): void {
  console.log("[T5] tampered ciphertext rejected by AEAD");
  const { alice, bob, aad } = setupPeers();
  const m = encrypt(alice.state, enc("legit"), aad);

  // Flip one byte in the ciphertext payload (after the nonce).
  const tampered = m.ciphertext.slice();
  tampered[tampered.length - 1] ^= 0xff;

  let threw = false;
  try {
    decrypt(bob.state, m.header, tampered, aad);
  } catch {
    threw = true;
  }
  check("tampered ciphertext throws on decrypt", threw);
}

// ---- Test 6: AAD mismatch (cross-conversation replay) rejected ----
function testAadMismatch(): void {
  console.log("[T6] AAD mismatch rejected (cross-conversation replay defense)");
  const { alice, bob, aad } = setupPeers();
  const m = encrypt(alice.state, enc("payload"), aad);

  // Decrypt with WRONG aad (different conversation context).
  const wrongAad = enc("different-conversation");
  let threw = false;
  try {
    decrypt(bob.state, m.header, m.ciphertext, wrongAad);
  } catch {
    threw = true;
  }
  check("wrong AAD throws on decrypt", threw);
}

// ---- Test 7: state serialization round-trip ----
function testSerialize(): void {
  console.log("[T7] state serialization survives a round-trip");
  const { alice, bob, aad } = setupPeers();
  const m1 = encrypt(alice.state, enc("hi"), aad);
  decrypt(bob.state, m1.header, m1.ciphertext, aad);
  // Bob's state now has a peerDhPub + advanced chain + maybe skipped keys.
  const json = JSON.stringify(serializeState(bob.state));
  const bobRehydrated = deserializeState(JSON.parse(json));

  // Continue the conversation using the rehydrated state.
  const r = encrypt(bobRehydrated, enc("reply"), aad);
  const back = decrypt(alice.state, r.header, r.ciphertext, aad);
  check("rehydrated state can encrypt and be decrypted by peer", dec(back) === "reply");
}

testPingPong();
testForwardSecrecy();
testPostCompromise();
testOutOfOrder();
testTamper();
testAadMismatch();
testSerialize();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
