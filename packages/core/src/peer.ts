import wrtc from "@roamhq/wrtc";
import {
  decrypt,
  decryptBytes,
  deriveSessionKeys,
  encrypt,
  encryptBytes,
  fromBase64,
  generateKeyPair,
  type KeyPair,
  type SessionKeys,
  toBase64,
} from "./crypto.js";
import type {
  IncomingSignal,
  SignalPayload,
  SignalingTransport,
} from "./transport.js";
import { makeLogger } from "./util/logger.js";

const { RTCPeerConnection } = wrtc;

const log = makeLogger("peer");

export type PeerOptions = {
  /** Pluggable signaling transport (WebSocket or Nostr). */
  transport: SignalingTransport;
  iceServers?: RTCIceServer[];
};

const DEFAULT_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/**
 * Reserved label for the original 1:1 text channel. All other RTCDataChannels
 * on the same peer connection are treated as application-level SecureChannels.
 */
const CHAT_CHANNEL_LABEL = "chat";

/**
 * Encrypted, ordered byte channel between two peers, multiplexed on top of
 * the same RTCPeerConnection used for chat. Each SecureChannel is its own
 * RTCDataChannel labeled with `label`, sharing the connection's already-
 * derived X25519 session keys.
 *
 * Used for file transfer (Phase 6) so chunk floods don't block the chat
 * channel and can apply backpressure independently.
 */
export type SecureChannel = {
  readonly label: string;
  /** Encrypted send. Buffers in the WebRTC data-channel queue. */
  send(payload: Uint8Array): void;
  onMessage(fn: (payload: Uint8Array) => void): () => void;
  onClose(fn: () => void): () => void;
  /** Underlying data-channel buffered bytes — used for backpressure decisions. */
  bufferedAmount(): number;
  /** Resolves once the buffer drops below `threshold`. */
  waitForDrain(threshold?: number): Promise<void>;
  close(): void;
};

export class Peer {
  /** This peer's id on the active transport (e.g. nostr pubkey or "alice"). */
  readonly selfId: string;
  private transport: SignalingTransport;
  private sessionKeypair: KeyPair = generateKeyPair();
  private connections = new Map<string, ConnectionState>();
  private messageHandlers = new Set<(from: string, text: string) => void>();
  private connectHandlers = new Set<(peerId: string) => void>();
  private secureChannelHandlers = new Set<
    (peerId: string, channel: SecureChannel) => void
  >();
  private opts: PeerOptions;

  constructor(opts: PeerOptions) {
    this.opts = opts;
    this.transport = opts.transport;
    this.selfId = opts.transport.selfId;
    this.transport.onSignal((s) => this.onSignaling(s));
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  onMessage(fn: (from: string, text: string) => void): () => void {
    this.messageHandlers.add(fn);
    return () => this.messageHandlers.delete(fn);
  }

  onConnect(fn: (peerId: string) => void): () => void {
    this.connectHandlers.add(fn);
    return () => this.connectHandlers.delete(fn);
  }

  async connect(peerId: string): Promise<void> {
    const state = this.ensureConnection(peerId, /* initiator */ true);
    const dc = state.pc.createDataChannel(CHAT_CHANNEL_LABEL);
    this.wireDataChannel(state, dc);

    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    await this.transport.send(peerId, {
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
    const ct = encrypt(text, state.session.tx);
    const ab = ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer;
    state.dc.send(ab);
  }

  connectedPeers(): string[] {
    const out: string[] = [];
    for (const [id, s] of this.connections) {
      if (s.dc && s.dc.readyState === "open" && s.session) out.push(id);
    }
    return out;
  }

  isConnected(peerId: string): boolean {
    const s = this.connections.get(peerId);
    return !!(s && s.dc && s.dc.readyState === "open" && s.session);
  }

  async close(): Promise<void> {
    for (const s of this.connections.values()) s.pc.close();
    this.connections.clear();
    await this.transport.close();
  }

  private ensureConnection(peerId: string, initiator: boolean): ConnectionState {
    const existing = this.connections.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers ?? DEFAULT_ICE });
    const state: ConnectionState = { peerId, pc, initiator };
    this.connections.set(peerId, state);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.transport
          .send(peerId, { kind: "ice", candidate: ev.candidate.toJSON() })
          .catch((err) => log.warn("ICE send failed", { peerId, err: String(err) }));
      }
    };

    pc.ondatachannel = (ev) => {
      // The "chat" channel is the original 1:1 text channel; everything else
      // is a labeled SecureChannel created by openSecureChannel on the other
      // side (e.g. file transfers).
      if (ev.channel.label === CHAT_CHANNEL_LABEL) {
        this.wireDataChannel(state, ev.channel);
      } else {
        this.handleIncomingSecureChannel(state, ev.channel);
      }
    };

    return state;
  }

  /**
   * Open a labeled secure data channel to a connected peer. Encrypted with
   * the same X25519 session keys as chat (derived per WebRTC connection).
   * Resolves once the channel is open on both ends.
   */
  async openSecureChannel(peerId: string, label: string): Promise<SecureChannel> {
    if (label === CHAT_CHANNEL_LABEL) {
      throw new Error(`label "${label}" is reserved for the chat channel`);
    }
    const state = this.connections.get(peerId);
    if (!state || !state.session) throw new Error(`no session with ${peerId}`);
    const dc = state.pc.createDataChannel(label, { ordered: true });
    // @roamhq/wrtc treats on* properties as the canonical event source —
    // addEventListener is partial. Use the property style for reliability.
    return new Promise((resolve, reject) => {
      // The channel may already be in "open" state by the time we get here
      // (subsequent channels on an established connection can open very fast).
      // Poll at a short interval as a backstop for the open event.
      let done = false;
      const settle = (ok: boolean, err?: unknown) => {
        if (done) return;
        done = true;
        dc.onopen = null;
        dc.onerror = null;
        clearInterval(poll);
        if (ok) resolve(this.wrapSecureChannel(dc, state.session!));
        else reject(err);
      };
      dc.onopen = () => settle(true);
      dc.onerror = (err) => settle(false, err);
      const poll = setInterval(() => {
        if (dc.readyState === "open") settle(true);
        else if (dc.readyState === "closed") settle(false, new Error("channel closed"));
      }, 25);
      // Also check immediately in case the channel raced to open before the
      // promise body started.
      if (dc.readyState === "open") settle(true);
    });
  }

  /** Subscribe to incoming SecureChannels (channels opened by the remote peer). */
  onSecureChannel(fn: (peerId: string, channel: SecureChannel) => void): () => void {
    this.secureChannelHandlers.add(fn);
    return () => this.secureChannelHandlers.delete(fn);
  }

  private handleIncomingSecureChannel(state: ConnectionState, dc: RTCDataChannel): void {
    if (!state.session) {
      // Should not happen — channel is only opened after session is installed.
      log.warn("incoming secure channel before session — closing", {
        peerId: state.peerId,
        label: dc.label,
      });
      dc.close();
      return;
    }
    const channel = this.wrapSecureChannel(dc, state.session);
    for (const h of this.secureChannelHandlers) {
      try {
        h(state.peerId, channel);
      } catch (err) {
        log.error("onSecureChannel handler threw", { err: String(err) });
      }
    }
  }

  private wrapSecureChannel(dc: RTCDataChannel, session: SessionKeys): SecureChannel {
    const messageHandlers = new Set<(p: Uint8Array) => void>();
    const closeHandlers = new Set<() => void>();
    dc.binaryType = "arraybuffer";
    dc.onmessage = (ev) => {
      const buf =
        ev.data instanceof ArrayBuffer
          ? new Uint8Array(ev.data)
          : new Uint8Array(ev.data);
      try {
        const pt = decryptBytes(buf, session.rx);
        for (const h of messageHandlers) h(pt);
      } catch (err) {
        log.warn("secure-channel decrypt failed", { label: dc.label, err: String(err) });
      }
    };
    dc.onclose = () => {
      for (const h of closeHandlers) h();
    };
    return {
      label: dc.label,
      send: (payload) => {
        const ct = encryptBytes(payload, session.tx);
        const ab = ct.buffer.slice(
          ct.byteOffset,
          ct.byteOffset + ct.byteLength,
        ) as ArrayBuffer;
        dc.send(ab);
      },
      onMessage: (fn) => {
        messageHandlers.add(fn);
        return () => messageHandlers.delete(fn);
      },
      onClose: (fn) => {
        closeHandlers.add(fn);
        return () => closeHandlers.delete(fn);
      },
      bufferedAmount: () => dc.bufferedAmount,
      waitForDrain: (threshold = 65536) =>
        new Promise<void>((resolve) => {
          if (dc.bufferedAmount <= threshold) {
            resolve();
            return;
          }
          dc.bufferedAmountLowThreshold = threshold;
          dc.onbufferedamountlow = () => {
            dc.onbufferedamountlow = null;
            resolve();
          };
        }),
      close: () => dc.close(),
    };
  }

  private wireDataChannel(state: ConnectionState, dc: RTCDataChannel): void {
    state.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.onopen = () => {
      for (const h of this.connectHandlers) h(state.peerId);
    };
    dc.onmessage = (ev) => {
      if (!state.session) return;
      const buf =
        ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data);
      try {
        const text = decrypt(buf, state.session.rx);
        for (const h of this.messageHandlers) h(state.peerId, text);
      } catch (err) {
        log.error("decrypt failed", { peerId: state.peerId, err: String(err) });
      }
    };
  }

  private async onSignaling(signal: IncomingSignal): Promise<void> {
    const { from, payload } = signal;

    try {
      if (payload.kind === "offer") {
        // If we already have a stable (or otherwise non-handshaking) PC for this
        // peer, treat the new offer as a request to renegotiate: tear down and
        // start fresh. This is a simplified "perfect negotiation" — sufficient
        // because our app's signaling is symmetric and infrequent.
        const existing = this.connections.get(from);
        if (existing && existing.pc.signalingState === "stable") {
          log.info("renegotiation offer received — closing existing PC", {
            peerId: from,
            prevSignalingState: existing.pc.signalingState,
          });
          existing.pc.close();
          this.connections.delete(from);
        } else if (existing && existing.pc.signalingState !== "have-remote-offer") {
          // Mid-handshake collision — ignore the duplicate. The original
          // negotiation either completes or fails on its own.
          log.debug("ignoring offer during in-flight handshake", {
            peerId: from,
            signalingState: existing.pc.signalingState,
          });
          return;
        }

        const state = this.ensureConnection(from, false);
        this.installSession(state, payload.pubKey);
        await state.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        const answer = await state.pc.createAnswer();
        await state.pc.setLocalDescription(answer);
        await this.transport.send(from, {
          kind: "answer",
          sdp: answer.sdp ?? "",
          pubKey: toBase64(this.sessionKeypair.publicKey),
        });
        return;
      }

      if (payload.kind === "answer") {
        const state = this.connections.get(from);
        if (!state) {
          log.debug("answer for unknown peer", { peerId: from });
          return;
        }
        if (state.pc.signalingState !== "have-local-offer") {
          log.warn("ignoring answer in unexpected state", {
            peerId: from,
            signalingState: state.pc.signalingState,
          });
          return;
        }
        this.installSession(state, payload.pubKey);
        await state.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        return;
      }

      if (payload.kind === "ice") {
        const state = this.connections.get(from);
        if (!state) return;
        // ICE candidates must arrive after remoteDescription is set.
        if (!state.pc.remoteDescription) {
          log.debug("queueing ICE — remote description not yet set", { peerId: from });
          return;
        }
        try {
          await state.pc.addIceCandidate(payload.candidate);
        } catch (err) {
          log.warn("addIceCandidate failed", { err: String(err) });
        }
      }
    } catch (err) {
      log.error("signaling handler threw", {
        peerId: from,
        kind: payload.kind,
        err: String(err),
      });
    }
  }

  private installSession(state: ConnectionState, peerPubKeyB64: string): void {
    if (state.session) return;
    const peerPub = fromBase64(peerPubKeyB64);
    const isClient = this.selfId < state.peerId;
    state.session = deriveSessionKeys(this.sessionKeypair, peerPub, isClient);
  }
}

type ConnectionState = {
  peerId: string;
  pc: RTCPeerConnection;
  initiator: boolean;
  dc?: RTCDataChannel;
  session?: SessionKeys;
};

/** Re-exports kept for callers that previously imported from this module. */
export type { SignalPayload, SignalingTransport };
