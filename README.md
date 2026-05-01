# p2p-messenger

A serverless, end-to-end encrypted messenger that combines **WebRTC for low-latency P2P data transport** with **Nostr relays for decentralized signaling, discovery, and store-and-forward offline delivery**. Built in TypeScript on Node.js. No vendor-controlled infrastructure anywhere in the stack.

## Status

- [x] **Phase 1** — 1:1 encrypted messaging over WebRTC + WebSocket signaling
- [x] **Phase 1.5** — Nostr-relay signaling (NIP-44 + NIP-59 gift wrap)
- [x] **Phase 2** — Discovery via Nostr presence events + NIP-05 + local contacts
- [x] **Phase 3** — NIP-17 store-and-forward offline delivery with vector clocks
- [ ] Phase 4 — group chats (Sender Keys)
- [ ] Phase 5 — Double Ratchet forward secrecy
- [ ] Phase 6 — file transfer over the same protocol

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  CLI / readline + slash commands                            │
├─────────────────────────────────────────────────────────────┤
│  Messenger — unified send/receive (hybrid routing)          │
│      ├── Peer (WebRTC P2P)                                  │
│      └── OfflineMessenger (NIP-17 via Nostr relays)         │
├─────────────────────────────────────────────────────────────┤
│  SignalingTransport (interface)                             │
│      ├── WebSocketSignaling — single dev signaling server   │
│      └── NostrSignaling — multi-relay, NIP-59 gift wrap     │
├─────────────────────────────────────────────────────────────┤
│  Crypto                                                     │
│      ├── X25519 + XChaCha20-Poly1305 (data-channel session) │
│      ├── secp256k1 + NIP-44 (Nostr identity & E2E payload)  │
│      └── NIP-59 (sender-anonymous gift wrap)                │
├─────────────────────────────────────────────────────────────┤
│  Persistence                                                │
│      ├── identity (per-alias Nostr keypair, mode 0600)      │
│      ├── contacts (alias → npub map)                        │
│      ├── vector clock (per peer, persisted)                 │
│      ├── dedup ring (recent gift-wrap event ids)            │
│      └── message history (SQLite via better-sqlite3)        │
└─────────────────────────────────────────────────────────────┘
```

### Data flow at a glance

```
Online peer ↔ Nostr relays ↔ Online peer    ← signaling, presence, offline messages
    └────── WebRTC P2P (XChaCha20) ──────┘   ← actual message data when both online
```

## Quick start

```bash
# 0. install deps
pnpm install

# 1. start the local Nostr relay (Docker)
pnpm relay:up

# 2. terminal A (alice) — auto-creates her Nostr identity
pnpm chat --id alice --signal nostr://localhost:7777

# 3. terminal B (bob) — paste alice's npub from the alice startup line
pnpm chat --id bob  --signal nostr://localhost:7777 --peer <alice's npub>
```

In any session, type `/help` for the full command list.

### Multi-relay redundancy demo

```bash
pnpm chat --id alice --signal nostr://localhost:7777,relay.damus.io,nos.lol
```

Publishes to all relays and subscribes from all relays — any one going down doesn't sever the channel.

### Offline-delivery demo

```bash
# alice sends, bob is not running
pnpm chat --id alice --signal nostr://localhost:7777
# (in alice) /sendto <bob_npub> "ping while you were out"
# (Ctrl+C alice)

# bob comes online — drains the message off the relay
pnpm chat --id bob --signal nostr://localhost:7777
# bob sees: alice> ping while you were out (via relay)
```

## Cryptographic primitives

| Layer | Algorithm | Library |
| --- | --- | --- |
| Nostr identity | secp256k1 (Schnorr / BIP-340) | `@noble/curves`, `nostr-tools` |
| Data-channel session | X25519 ECDH → HKDF-SHA256 → 64-byte split (tx/rx) | `@noble/curves`, `@noble/hashes` |
| Data-channel payload | XChaCha20-Poly1305 (24-byte nonce, AEAD) | `@noble/ciphers` |
| Nostr DM payload | NIP-44 v2 (XChaCha20 + HMAC-SHA256) | `nostr-tools/nip44` |
| Sender anonymity | NIP-59 gift wrap (rumor → seal → wrap) | `nostr-tools/nip59` |
| Hashing | SHA-256, BLAKE3-ready | `@noble/hashes` |

## Security & threat model

What the design protects:

- **Confidentiality of message body** — XChaCha20-Poly1305 on WebRTC data channel; NIP-44 v2 on Nostr offline path.
- **Sender anonymity from relays** — NIP-59 gift wrap (kind 1059) replaces the sender pubkey with a one-time ephemeral key. Relays see only “someone is sending kind 1059 events to recipient X.”
- **Replay protection** — persistent dedup ring on event id, vector-clock causal ordering.
- **At-rest secret keys** — files written with `chmod 0600`, parent directory `0700`. Permission drift is detected and re-tightened on load.

What the design does **not** protect (yet):

- **Metadata** — relays still observe recipient, frequency, and approximate timing. Mitigations require Tor / private relays.
- **Forward secrecy** — Phase 1 / 3 use static identity keys for the Nostr layer. The data-channel session is fresh per WebRTC connection but the Nostr seal is not. Phase 5 (Double Ratchet) closes this.
- **Compromised endpoint** — local plaintext history & secret key file are at the OS file-permission boundary. No passphrase encryption yet.
- **Sybil / spam** — anyone can DM your pubkey. PoW / contact-list filtering is future work.

## Project layout

```
.
├── infra/
│   └── nostr-relay/          # local nostr-rs-relay via Docker Compose
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── crypto.ts             # X25519 + XChaCha20 session keys
│   │   │   ├── transport.ts          # SignalingTransport interface
│   │   │   ├── peer.ts               # WebRTC peer (transport-agnostic)
│   │   │   ├── messenger.ts          # hybrid send (P2P / offline)
│   │   │   ├── signaling/
│   │   │   │   └── ws.ts             # WebSocket impl
│   │   │   ├── nostr/
│   │   │   │   ├── identity.ts       # secp256k1 keypair, persisted
│   │   │   │   ├── relay-pool.ts     # multi-relay fan-out + dedup
│   │   │   │   ├── gift-wrap.ts      # NIP-59 wrap / unwrap
│   │   │   │   ├── signaling.ts      # SignalingTransport over Nostr
│   │   │   │   ├── profile.ts        # kind 0 metadata
│   │   │   │   ├── presence.ts       # online/offline heartbeat
│   │   │   │   ├── contacts.ts       # local contact book + NIP-05
│   │   │   │   ├── kinds.ts          # event-kind constants
│   │   │   │   ├── vector-clock.ts   # causality
│   │   │   │   ├── clock-store.ts    # persisted clock
│   │   │   │   ├── dedup.ts          # event-id LRU + drain cursor
│   │   │   │   └── offline-queue.ts  # NIP-17 send + drain
│   │   │   └── util/{logger,backoff}.ts
│   │   └── test/                     # integration tests, runnable via tsx
│   ├── cli/                          # readline UI, slash commands
│   └── signaling-server/             # tiny WS signaling for Phase 1 demos
└── package.json                      # workspace scripts
```

## Scripts

```
pnpm relay:up        start local Nostr relay (Docker)
pnpm relay:down      stop relay
pnpm relay:logs      tail relay logs
pnpm relay:test      smoke test: publish + subscribe round-trip
pnpm dev:signal      run the WebSocket signaling server
pnpm chat …          run the CLI (see arguments above)
pnpm build           type-check & emit dist/

pnpm -w run test:phase1     ws transport round-trip
pnpm -w run test:phase15    Nostr-signaling WebRTC handshake
pnpm -w run test:phase2     presence + alias-resolution
pnpm -w run test:phase3     offline delivery + dedup + vector clocks (causal order)
pnpm -w run test:replay     stale-signaling replay regression
pnpm -w run test:nostr      runs phase 1.5 → 3 + replay sequentially
```

## Configuration

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `P2P_DATA_DIR` | `~/.p2p-messenger` | identity, contacts, clock, dedup, history |
| `P2P_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `P2P_RELAY` | `ws://localhost:7777` | relay used by integration tests |

CLI flags:

| Flag | Example | Purpose |
| --- | --- | --- |
| `--id` | `--id alice` | Local alias (also DB filename, prompt label, identity key) |
| `--signal` | `--signal nostr://localhost:7777,nos.lol` | Transport selector |
| `--peer` | `--peer npub1…` / `bob` / `bob@example.com` | Initial peer (resolved via contacts → NIP-05 → npub/hex) |
| `--data-dir` | `--data-dir ./tmp` | Override `P2P_DATA_DIR` |

## Resume bullet

> Built a hybrid P2P/relay encrypted messenger in Node.js + TypeScript: WebRTC data channels with X25519 + XChaCha20-Poly1305 session keys for low-latency online traffic, layered atop a Nostr-relay control plane (NIP-44 + NIP-59 gift-wrapped signaling, presence-based discovery, NIP-17 store-and-forward) for offline delivery and discovery without any owned infrastructure. Multi-relay fan-out with per-subscription dedup, vector-clock causal ordering, persistent identity (mode 0600), and an integration test suite covering all four phases.
