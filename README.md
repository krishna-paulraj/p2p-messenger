# p2p-messenger

Serverless E2E-encrypted P2P messenger over WebRTC. No central server holds your messages; the signaling server only relays SDP offers/answers during connection setup and is dropped entirely once DHT discovery lands in Phase 2.

## Status

- [x] Phase 1 — 1:1 encrypted messaging over WebRTC + signaling server
- [ ] Phase 2 — Kademlia DHT peer discovery (drop signaling)
- [ ] Phase 3 — store-and-forward gossip for offline delivery
- [ ] Phase 4 — group chats (Sender Keys)
- [ ] Phase 5 — Double Ratchet forward secrecy
- [ ] Phase 6 — file transfer over the same protocol

## Phase 1 demo

```bash
pnpm install

# terminal 1
pnpm dev:signal

# terminal 2 — listener
pnpm chat -- --id alice

# terminal 3 — dialer
pnpm chat -- --id bob --peer alice
```

Type into either terminal; messages flow over a WebRTC data channel encrypted with XChaCha20-Poly1305 keys derived from an X25519 handshake.
# p2p-messenger
