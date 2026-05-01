import wrtc from "@roamhq/wrtc";
import {
  decrypt,
  deriveSessionKeys,
  encrypt,
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

export class Peer {
  /** This peer's id on the active transport (e.g. nostr pubkey or "alice"). */
  readonly selfId: string;
  private transport: SignalingTransport;
  private sessionKeypair: KeyPair = generateKeyPair();
  private connections = new Map<string, ConnectionState>();
  private messageHandlers = new Set<(from: string, text: string) => void>();
  private connectHandlers = new Set<(peerId: string) => void>();
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
    const dc = state.pc.createDataChannel("chat");
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
      this.wireDataChannel(state, ev.channel);
    };

    return state;
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
