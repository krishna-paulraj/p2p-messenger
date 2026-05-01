import { homedir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { setLogLevel } from "@p2p/core";
import { App } from "./tui/App.js";
import { startSession } from "./tui/services.js";

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
  const alias = args.get("id");
  const signal = args.get("signal") ?? "nostr://localhost:7777";
  const dataDir =
    args.get("data-dir") ?? process.env.P2P_DATA_DIR ?? join(homedir(), ".p2p-messenger");

  // Quiet logger by default — TUI owns the screen and stray log lines corrupt
  // the layout.
  if (!process.env.P2P_LOG_LEVEL) {
    if (args.has("debug")) setLogLevel("debug");
    else if (args.has("verbose")) setLogLevel("info");
    else setLogLevel("error");
  }

  if (!alias) {
    console.error(
      "usage: p2p-chat-tui --id <alias>\n" +
        "                    [--signal ws://host:port | nostr://relay1[,relay2...]]\n" +
        "                    [--verbose | --debug]",
    );
    process.exit(1);
  }

  const session = await startSession({ alias, signal, dataDir });

  const { waitUntilExit } = render(<App session={session} />);
  await waitUntilExit();
  await session.cleanup();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
