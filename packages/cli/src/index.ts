import readline from "node:readline";
import { Peer, initCrypto } from "@p2p/core";

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      args.set(key, value);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const id = args.get("id");
  const initialPeer = args.get("peer");
  const signal = args.get("signal") ?? "ws://localhost:8080";

  if (!id) {
    console.error("usage: p2p-chat --id <my-id> [--peer <other-id>] [--signal ws://host:port]");
    process.exit(1);
  }

  await initCrypto();

  const peer = new Peer({ signalingUrl: signal, selfId: id });
  const knownPeers = new Set<string>();
  let activePeer: string | undefined = initialPeer;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const updatePrompt = () => {
    rl.setPrompt(activePeer ? `[→ ${activePeer}] > ` : "> ");
  };

  peer.onConnect((p) => {
    knownPeers.add(p);
    if (!activePeer) activePeer = p;
    process.stdout.write(`\n[connected to ${p}]\n`);
    updatePrompt();
    rl.prompt();
  });

  peer.onMessage((from, text) => {
    knownPeers.add(from);
    activePeer = from;
    process.stdout.write(`\n${from}> ${text}\n`);
    updatePrompt();
    rl.prompt();
  });

  await peer.start();
  console.log(`registered as "${id}" on ${signal}`);

  if (initialPeer) {
    console.log(`dialing ${initialPeer}...`);
    knownPeers.add(initialPeer);
    await peer.connect(initialPeer);
  } else {
    console.log("waiting for incoming connections...");
  }

  updatePrompt();
  rl.prompt();

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();

    if (text.startsWith("/")) {
      handleCommand(text);
      return rl.prompt();
    }

    if (!activePeer) {
      console.log("(no active peer yet — wait for a connection or use /to <id>)");
      return rl.prompt();
    }
    try {
      peer.send(activePeer, text);
    } catch (err) {
      console.error("send failed:", (err as Error).message);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    peer.close();
    process.exit(0);
  });

  function handleCommand(cmd: string) {
    const [head, ...rest] = cmd.slice(1).split(/\s+/);
    if (head === "to" && rest[0]) {
      activePeer = rest[0];
      knownPeers.add(activePeer);
      console.log(`(active peer set to ${activePeer})`);
      updatePrompt();
      return;
    }
    if (head === "dial" && rest[0]) {
      const target = rest[0];
      knownPeers.add(target);
      activePeer = target;
      peer.connect(target).catch((err) => console.error("dial failed:", err));
      console.log(`(dialing ${target}...)`);
      updatePrompt();
      return;
    }
    if (head === "peers") {
      console.log("known peers:", [...knownPeers].join(", ") || "(none)");
      return;
    }
    if (head === "help" || head === "?") {
      console.log("/to <id>     switch active peer");
      console.log("/dial <id>   open a new connection");
      console.log("/peers       list known peers");
      console.log("/quit        exit");
      return;
    }
    if (head === "quit" || head === "exit") {
      rl.close();
      return;
    }
    console.log(`unknown command: /${head} (try /help)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
