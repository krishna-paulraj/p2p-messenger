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
import { SignalingClient, type SignalingEvent } from "./signaling.js";

const { RTCPeerConnection } = wrtc;

type SignalPayload =
  | { kind: "offer"; sdp: string; pubKey: string }
  | { kind: "answer"; sdp: string; pubKey: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

export type PeerOptions = {
  signalingUrl: string;
  selfId: string;
  iceServers?: RTCIceServer[];
};

const DEFAULT_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export class Peer {
  private signaling: SignalingClient;
  private keypair: KeyPair = generateKeyPair();
  private connections = new Map<string, ConnectionState>();
  private messageHandlers = new Set<(from: string, text: string) => void>();
  private connectHandlers = new Set<(peerId: string) => void>();

  constructor(private opts: PeerOptions) {
    this.signaling = new SignalingClient(opts.signalingUrl, opts.selfId);
    this.signaling.on((e) => this.onSignaling(e));
  }

  async start(): Promise<void> {
    await this.signaling.register();
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
    this.signaling.send(peerId, {
      kind: "offer",
      sdp: offer.sdp ?? "",
      pubKey: toBase64(this.keypair.publicKey),
    } satisfies SignalPayload);
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

  close(): void {
    for (const s of this.connections.values()) s.pc.close();
    this.connections.clear();
    this.signaling.close();
  }

  private ensureConnection(peerId: string, initiator: boolean): ConnectionState {
    const existing = this.connections.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers ?? DEFAULT_ICE });
    const state: ConnectionState = { peerId, pc, initiator };
    this.connections.set(peerId, state);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.signaling.send(peerId, {
          kind: "ice",
          candidate: ev.candidate.toJSON(),
        } satisfies SignalPayload);
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
        console.error(`[${state.peerId}] decrypt failed:`, err);
      }
    };
  }

  private async onSignaling(e: SignalingEvent): Promise<void> {
    if (e.type !== "signal") return;
    const payload = e.payload as SignalPayload;

    if (payload.kind === "offer") {
      const state = this.ensureConnection(e.from, false);
      this.installSession(state, payload.pubKey);
      await state.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      this.signaling.send(e.from, {
        kind: "answer",
        sdp: answer.sdp ?? "",
        pubKey: toBase64(this.keypair.publicKey),
      } satisfies SignalPayload);
      return;
    }

    if (payload.kind === "answer") {
      const state = this.connections.get(e.from);
      if (!state) return;
      this.installSession(state, payload.pubKey);
      await state.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      return;
    }

    if (payload.kind === "ice") {
      const state = this.connections.get(e.from);
      if (!state) return;
      try {
        await state.pc.addIceCandidate(payload.candidate);
      } catch (err) {
        console.error("addIceCandidate failed", err);
      }
    }
  }

  private installSession(state: ConnectionState, peerPubKeyB64: string): void {
    if (state.session) return;
    const peerPub = fromBase64(peerPubKeyB64);
    const isClient = this.opts.selfId < state.peerId;
    state.session = deriveSessionKeys(this.keypair, peerPub, isClient);
  }
}

type ConnectionState = {
  peerId: string;
  pc: RTCPeerConnection;
  initiator: boolean;
  dc?: RTCDataChannel;
  session?: SessionKeys;
};
