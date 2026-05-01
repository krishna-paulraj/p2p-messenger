import WebSocket from "ws";
import type {
  IncomingSignal,
  SignalHandler,
  SignalPayload,
  SignalingTransport,
} from "../transport.js";
import { makeLogger } from "../util/logger.js";

type WireEnvelope =
  | { type: "register"; peerId: string }
  | { type: "signal"; to: string; from: string; payload: SignalPayload }
  | { type: "registered"; peerId: string }
  | { type: "error"; reason: string; to?: string };

export type WebSocketSignalingOptions = {
  url: string;
  selfId: string;
};

const log = makeLogger("ws-signaling");

export class WebSocketSignaling implements SignalingTransport {
  readonly selfId: string;
  private url: string;
  private ws!: WebSocket;
  private opened!: Promise<void>;
  private handlers = new Set<SignalHandler>();
  private closing = false;

  constructor(opts: WebSocketSignalingOptions) {
    this.selfId = opts.selfId;
    this.url = opts.url;
  }

  async start(): Promise<void> {
    this.connect();
    await this.opened;
    this.ws.send(JSON.stringify({ type: "register", peerId: this.selfId }));
    log.info("registered", { selfId: this.selfId, url: this.url });
  }

  async send(toPeerId: string, payload: SignalPayload): Promise<void> {
    const env: WireEnvelope = { type: "signal", to: toPeerId, from: this.selfId, payload };
    this.ws.send(JSON.stringify(env));
  }

  onSignal(handler: SignalHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.ws.close();
  }

  private connect(): void {
    this.ws = new WebSocket(this.url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (raw) => this.onMessage(raw.toString()));
    this.ws.on("close", () => {
      if (this.closing) return;
      log.warn("ws connection closed");
    });
  }

  private onMessage(raw: string): void {
    let parsed: WireEnvelope;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn("dropped malformed message");
      return;
    }
    if (parsed.type === "signal") {
      const inbound: IncomingSignal = { from: parsed.from, payload: parsed.payload };
      for (const h of this.handlers) h(inbound);
      return;
    }
    if (parsed.type === "error") {
      log.warn("server error", { reason: parsed.reason, to: parsed.to });
    }
  }
}
