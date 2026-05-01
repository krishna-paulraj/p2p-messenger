/**
 * SignalingTransport — abstraction over WebSocket signaling and Nostr relay signaling.
 *
 * Both transports must:
 *   1. Identify the local peer to remote peers via a stable string id (selfId).
 *   2. Deliver opaque, typed payloads to a target peer id (best-effort, at-least-once).
 *   3. Surface inbound payloads via an observable handler.
 *
 * Confidentiality of the payload is the transport's responsibility when the underlying
 * channel is not trusted (e.g. Nostr relays). The WebSocket transport relies on the
 * outer X25519 + XChaCha20 layer in the data channel for confidentiality of user data,
 * and treats SDP/ICE as non-secret. The Nostr transport encrypts SDP/ICE end-to-end
 * via NIP-44 + NIP-59 gift wrap.
 */
export type SignalPayload =
  | { kind: "offer"; sdp: string; pubKey: string }
  | { kind: "answer"; sdp: string; pubKey: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

export type IncomingSignal = {
  from: string;
  payload: SignalPayload;
};

export type SignalHandler = (signal: IncomingSignal) => void;

export interface SignalingTransport {
  /** Stable string identifier for this peer on this transport. */
  readonly selfId: string;

  /** Connect/register; resolves once ready to send & receive. */
  start(): Promise<void>;

  /** Best-effort send of a signal payload to target peer. */
  send(toPeerId: string, payload: SignalPayload): Promise<void>;

  /** Subscribe to inbound signals. Returns an unsubscribe function. */
  onSignal(handler: SignalHandler): () => void;

  /** Graceful shutdown. */
  close(): Promise<void>;
}
