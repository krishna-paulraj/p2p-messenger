/**
 * Browser-native WebRTC peer. Mirrors the public API of @p2p/core's Node-side
 * `Peer` so the wire format on the SIGNALING channel (NIP-44 + NIP-59 gift
 * wraps with inner kind P2P_SIGNAL = 21059) and the SESSION crypto on the
 * data channel (X25519 → HKDF-SHA256 → XChaCha20-Poly1305) match exactly.
 * A CLI alice and a browser bob can complete a handshake with each other
 * without either side knowing or caring which runtime its peer is on.
 *
 * Lifecycle:
 *   1. dial(pubkey) → ensureConnection (initiator) → createOffer → send via
 *      signaling (caller's responsibility — `onSignalOut` callback).
 *   2. receive offer → ensureConnection (responder) → setRemoteDescription
 *      → createAnswer → send via signaling.
 *   3. receive answer → setRemoteDescription. ICE candidates flow in both
 *      directions until the data channel opens.
 *   4. data channel opens → derive session keys → emit `connect` event.
 *   5. send/receive: encrypt with session.tx, decrypt with session.rx. Same
 *      key derivation as the CLI: lex-smaller-pubkey is "client".
 */

import {
  decryptBytes,
  deriveSessionKeys,
  encryptBytes,
  fromBase64,
  generateKeyPair,
  toBase64,
  type KeyPair,
  type SessionKeys,
} from "@p2p/core/browser";

const CHAT_CHANNEL_LABEL = "chat";
const DEFAULT_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export type SignalPayload =
  | { kind: "offer"; sdp: string; pubKey: string }
  | { kind: "answer"; sdp: string; pubKey: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

export type SignalOut = (toPeerId: string, payload: SignalPayload) => Promise<void>;

export type WebPeerOptions = {
  /** Our own Nostr pubkey hex — serves as our identity on the wire. */
  selfId: string;
  /** Outbound signal hook — caller is responsible for getting it to the peer. */
  sendSignal: SignalOut;
  iceServers?: RTCIceServer[];
};

type ConnectionState = {
  peerId: string;
  pc: RTCPeerConnection;
  initiator: boolean;
  dc?: RTCDataChannel;
  session?: SessionKeys;
};

/**
 * Per-peer WebRTC peer registry. Single instance per browser session.
 */
export class WebPeer {
  readonly selfId: string;
  private opts: WebPeerOptions;
  private sessionKeypair: KeyPair = generateKeyPair();
  private connections = new Map<string, ConnectionState>();
  private messageHandlers = new Set<(from: string, text: string) => void>();
  private connectHandlers = new Set<(peerId: string) => void>();
  private disconnectHandlers = new Set<(peerId: string) => void>();

  constructor(opts: WebPeerOptions) {
    this.opts = opts;
    this.selfId = opts.selfId;
  }

  onMessage(fn: (from: string, text: string) => void): () => void {
    this.messageHandlers.add(fn);
    return () => this.messageHandlers.delete(fn);
  }

  onConnect(fn: (peerId: string) => void): () => void {
    this.connectHandlers.add(fn);
    return () => this.connectHandlers.delete(fn);
  }

  onDisconnect(fn: (peerId: string) => void): () => void {
    this.disconnectHandlers.add(fn);
    return () => this.disconnectHandlers.delete(fn);
  }

  isConnected(peerId: string): boolean {
    const s = this.connections.get(peerId);
    return !!(s && s.dc && s.dc.readyState === "open" && s.session);
  }

  connectedPeers(): string[] {
    const out: string[] = [];
    for (const [id, s] of this.connections) {
      if (s.dc && s.dc.readyState === "open" && s.session) out.push(id);
    }
    return out;
  }

  /** Dial a peer. Idempotent — re-calling for the same peer is a no-op. */
  async dial(peerId: string): Promise<void> {
    if (this.connections.has(peerId)) return;
    const state = this.ensureConnection(peerId, /* initiator */ true);
    const dc = state.pc.createDataChannel(CHAT_CHANNEL_LABEL);
    this.wireDataChannel(state, dc);

    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    await this.opts.sendSignal(peerId, {
      kind: "offer",
      sdp: offer.sdp ?? "",
      pubKey: toBase64(this.sessionKeypair.publicKey),
    });
  }

  send(peerId: string, text: string): void {
    const state = this.connections.get(peerId);
    if (!state || !state.dc || state.dc.readyState !== "open" || !state.session) {
      throw new Error(`not connected to ${peerId}`);
    }
    const ct = encryptBytes(new TextEncoder().encode(text), state.session.tx);
    const ab = ct.buffer.slice(
      ct.byteOffset,
      ct.byteOffset + ct.byteLength,
    ) as ArrayBuffer;
    state.dc.send(ab);
  }

  /** Inbound signal handler — wire this to the messenger's onSignal listener. */
  async handleSignal(from: string, payload: SignalPayload): Promise<void> {
    try {
      if (payload.kind === "offer") {
        const existing = this.connections.get(from);
        if (existing && existing.pc.signalingState === "stable") {
          // Renegotiation — tear down and start fresh.
          this.teardown(existing, "renegotiation");
        } else if (existing && existing.pc.signalingState !== "have-remote-offer") {
          // Mid-handshake collision — ignore the dup.
          return;
        }

        const state = this.ensureConnection(from, false);
        this.installSession(state, payload.pubKey);
        await state.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        const answer = await state.pc.createAnswer();
        await state.pc.setLocalDescription(answer);
        await this.opts.sendSignal(from, {
          kind: "answer",
          sdp: answer.sdp ?? "",
          pubKey: toBase64(this.sessionKeypair.publicKey),
        });
        return;
      }

      if (payload.kind === "answer") {
        const state = this.connections.get(from);
        if (!state) return;
        if (state.pc.signalingState !== "have-local-offer") {
          // Stale answer (e.g. a replay from a prior session) — drop.
          return;
        }
        this.installSession(state, payload.pubKey);
        await state.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        return;
      }

      if (payload.kind === "ice") {
        const state = this.connections.get(from);
        if (!state || !state.pc.remoteDescription) return;
        try {
          await state.pc.addIceCandidate(payload.candidate);
        } catch {
          // ICE candidates can fail benignly (already known, expired, etc.).
        }
      }
    } catch (err) {
      // Defensive — never let a bad signal crash the peer.
      console.warn("[WebPeer] signal handler error:", err);
    }
  }

  /** Tear down a specific connection (or all). */
  disconnect(peerId: string): void {
    const state = this.connections.get(peerId);
    if (!state) return;
    this.teardown(state, "user closed");
  }

  close(): void {
    for (const s of [...this.connections.values()]) this.teardown(s, "peer closed");
    this.connections.clear();
  }

  // ---- Internal ----

  private ensureConnection(peerId: string, initiator: boolean): ConnectionState {
    const existing = this.connections.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers ?? DEFAULT_ICE });
    const state: ConnectionState = { peerId, pc, initiator };
    this.connections.set(peerId, state);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        void this.opts
          .sendSignal(peerId, {
            kind: "ice",
            candidate: ev.candidate.toJSON(),
          })
          .catch((err) => console.warn("[WebPeer] ICE send failed:", err));
      }
    };

    pc.ondatachannel = (ev) => {
      if (ev.channel.label === CHAT_CHANNEL_LABEL) {
        this.wireDataChannel(state, ev.channel);
      }
      // Other labels reserved for future SecureChannel work.
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.teardown(state, `pc state ${pc.connectionState}`);
      }
    };

    return state;
  }

  private wireDataChannel(state: ConnectionState, dc: RTCDataChannel): void {
    state.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.onopen = () => {
      for (const h of this.connectHandlers) {
        try {
          h(state.peerId);
        } catch (err) {
          console.warn("[WebPeer] connect handler error:", err);
        }
      }
    };
    dc.onmessage = (ev) => {
      if (!state.session) return;
      const buf =
        ev.data instanceof ArrayBuffer
          ? new Uint8Array(ev.data)
          : new Uint8Array(ev.data as ArrayBufferLike);
      try {
        const plaintext = decryptBytes(buf, state.session.rx);
        const text = new TextDecoder().decode(plaintext);
        for (const h of this.messageHandlers) {
          try {
            h(state.peerId, text);
          } catch (err) {
            console.warn("[WebPeer] message handler error:", err);
          }
        }
      } catch (err) {
        console.warn("[WebPeer] decrypt failed:", err);
      }
    };
    dc.onclose = () => {
      this.teardown(state, "data channel closed");
    };
  }

  private installSession(state: ConnectionState, peerPubKeyB64: string): void {
    if (state.session) return;
    const peerPub = fromBase64(peerPubKeyB64);
    const isClient = this.selfId < state.peerId;
    state.session = deriveSessionKeys(this.sessionKeypair, peerPub, isClient);
  }

  private teardown(state: ConnectionState, reason: string): void {
    const wasConnected = !!(state.dc && state.dc.readyState === "open" && state.session);
    try {
      state.pc.close();
    } catch {
      // ignore
    }
    this.connections.delete(state.peerId);
    if (wasConnected) {
      for (const h of this.disconnectHandlers) {
        try {
          h(state.peerId);
        } catch (err) {
          console.warn("[WebPeer] disconnect handler error:", err);
        }
      }
    }
    void reason;
  }
}
