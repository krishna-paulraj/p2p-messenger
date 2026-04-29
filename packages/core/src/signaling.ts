import WebSocket from "ws";

export type SignalEnvelope = {
  type: "signal";
  to: string;
  from: string;
  payload: unknown;
};

export type SignalingEvent =
  | { type: "registered"; peerId: string }
  | { type: "signal"; from: string; payload: unknown }
  | { type: "error"; reason: string; to?: string };

export class SignalingClient {
  private ws: WebSocket;
  private listeners = new Set<(e: SignalingEvent) => void>();
  private opened: Promise<void>;

  constructor(
    url: string,
    private peerId: string,
  ) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (raw) => {
      let parsed: SignalingEvent;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      for (const l of this.listeners) l(parsed);
    });
  }

  async register(): Promise<void> {
    await this.opened;
    this.ws.send(JSON.stringify({ type: "register", peerId: this.peerId }));
  }

  send(to: string, payload: unknown): void {
    const env: SignalEnvelope = { type: "signal", to, from: this.peerId, payload };
    this.ws.send(JSON.stringify(env));
  }

  on(listener: (e: SignalingEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.ws.close();
  }
}
