import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT ?? 8080);

type Envelope =
  | { type: "register"; peerId: string }
  | { type: "signal"; to: string; from: string; payload: unknown };

const peers = new Map<string, WebSocket>();

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  let myId: string | null = null;

  ws.on("message", (raw) => {
    let msg: Envelope;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "register") {
      myId = msg.peerId;
      peers.set(myId, ws);
      console.log(`[register] ${myId} (total: ${peers.size})`);
      ws.send(JSON.stringify({ type: "registered", peerId: myId }));
      return;
    }

    if (msg.type === "signal") {
      const target = peers.get(msg.to);
      if (!target || target.readyState !== WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", reason: "peer-offline", to: msg.to }));
        return;
      }
      target.send(JSON.stringify(msg));
    }
  });

  ws.on("close", () => {
    if (myId && peers.get(myId) === ws) {
      peers.delete(myId);
      console.log(`[disconnect] ${myId} (total: ${peers.size})`);
    }
  });
});

console.log(`signaling server listening on :${PORT}`);
