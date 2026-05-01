import readline from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ContactBook,
  DedupStore,
  Messenger,
  OfflineMessenger,
  Peer,
  PresencePublisher,
  PresenceWatcher,
  type Profile,
  fetchProfiles,
  initCrypto,
  loadClock,
  publishProfile,
  resolvePeer,
  saveClock,
  setLogLevel,
} from "@p2p/core";
import { MessageStore } from "./storage.js";
import { buildTransport, shortPubkey } from "./transport.js";

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
  const initialPeerArg = args.get("peer");
  const signal = args.get("signal") ?? "ws://localhost:8080";
  const dataDir =
    args.get("data-dir") ?? process.env.P2P_DATA_DIR ?? join(homedir(), ".p2p-messenger");

  // CLI default log level is `warn` so info-level chatter from core modules
  // doesn't interleave with the readline prompt. P2P_LOG_LEVEL env var still
  // wins; --debug / --verbose are CLI-side opt-ins.
  if (!process.env.P2P_LOG_LEVEL) {
    if (args.has("debug")) setLogLevel("debug");
    else if (args.has("verbose")) setLogLevel("info");
    else setLogLevel("warn");
  }

  if (!alias) {
    console.error(
      "usage: p2p-chat --id <alias> [--peer <alias|npub|hex|nip05>]\n" +
        "                [--signal ws://host:port | nostr://relay1[,relay2...]]\n" +
        "                [--verbose | --debug]",
    );
    process.exit(1);
  }

  await initCrypto();

  const dbPath = args.get("db") ?? join(dataDir, "history", `${alias}.db`);
  const store = new MessageStore(dbPath);

  const resolved = buildTransport({ alias, signal, dataDir });
  const { transport, identity, pool } = resolved;

  // Phase 2/3 services — only meaningful on the Nostr transport.
  const contacts = identity ? new ContactBook({ dataDir, ownerAlias: alias }) : undefined;
  const presencePub =
    identity && pool
      ? new PresencePublisher({
          pool,
          secretKey: identity.secretKey,
          publicKey: identity.publicKey,
        })
      : undefined;
  const presenceWatch = identity && pool ? new PresenceWatcher(pool) : undefined;

  const clockPath = identity ? join(dataDir, "clock", `${alias}.json`) : undefined;
  const dedupPath = identity ? join(dataDir, "dedup", `${alias}.json`) : undefined;
  const clock = identity && clockPath ? loadClock(clockPath, identity.publicKey) : undefined;
  const dedup = dedupPath ? new DedupStore(dedupPath) : undefined;

  const offline =
    identity && pool && clock && dedup
      ? new OfflineMessenger({
          pool,
          selfPubkey: identity.publicKey,
          selfSecret: identity.secretKey,
          dedup,
          clock,
        })
      : undefined;

  const peer = new Peer({ transport });
  const messenger = new Messenger({
    peer,
    offline,
    tickClock: clock ? () => clock.tick() : undefined,
  });

  const knownPeers = new Set<string>();
  let activePeer: string | undefined;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const displayPeer = (id: string): string => {
    if (!identity) return id;
    const c = contacts?.byPubkeyOrUndefined(id);
    if (c) return c.alias;
    return shortPubkey(id);
  };

  const updatePrompt = () => {
    if (!activePeer) {
      rl.setPrompt("> ");
      return;
    }
    const onlineMark = presenceWatch?.isOnline(activePeer) ? "●" : "○";
    const channel = messenger.isConnected(activePeer) ? "p2p" : offline ? "relay" : "?";
    rl.setPrompt(`${onlineMark} [→ ${displayPeer(activePeer)} via ${channel}] > `);
  };

  messenger.onConnect((p) => {
    knownPeers.add(p);
    if (!activePeer) activePeer = p;
    process.stdout.write(`\n[connected to ${displayPeer(p)}] (WebRTC P2P)\n`);
    printRecent(p);
    updatePrompt();
    rl.prompt();
  });

  messenger.onMessage((msg) => {
    knownPeers.add(msg.from);
    activePeer = msg.from;
    store.save(msg.from, "in", msg.text);
    const sourceTag = msg.source === "offline" ? "(via relay)" : "";
    process.stdout.write(`\n${displayPeer(msg.from)}> ${msg.text} ${sourceTag}\n`.trimEnd() + "\n");
    updatePrompt();
    rl.prompt();
  });

  presenceWatch?.on((snap) => {
    const c = contacts?.byPubkeyOrUndefined(snap.pubkey);
    if (!c) return;
    if (snap.status === "online") {
      process.stdout.write(`\n● ${c.alias} is online\n`);
    } else {
      process.stdout.write(`\n○ ${c.alias} went offline\n`);
    }
    updatePrompt();
    rl.prompt();
  });

  await peer.start();
  if (offline) await offline.start();
  console.log(`[startup] ${resolved.description}`);
  if (identity) console.log(`[startup] your npub: ${identity.npub}`);
  if (offline) console.log(`[startup] offline drain enabled (NIP-17)`);

  let initialPeerId: string | undefined;
  if (initialPeerArg) {
    if (identity && contacts) {
      try {
        const r = await resolvePeer(initialPeerArg, contacts);
        initialPeerId = r.pubkey;
        console.log(`[resolve] ${initialPeerArg} → ${shortPubkey(r.pubkey)} (${r.source})`);
      } catch (err) {
        console.error("could not resolve initial peer:", (err as Error).message);
      }
    } else {
      initialPeerId = initialPeerArg;
    }
  }
  activePeer = initialPeerId;

  if (presencePub) await presencePub.start();
  if (presenceWatch && contacts) {
    const list = contacts.pubkeys();
    if (initialPeerId && !list.includes(initialPeerId)) list.push(initialPeerId);
    if (list.length > 0) presenceWatch.watch(list);
  }

  if (identity && pool) {
    publishProfile({
      pool,
      secretKey: identity.secretKey,
      profile: { name: alias },
    }).catch((err) => console.error("profile publish failed:", (err as Error).message));
  }

  if (initialPeerId) {
    console.log(`dialing ${displayPeer(initialPeerId)}...`);
    knownPeers.add(initialPeerId);
    messenger.dial(initialPeerId).catch((err) => {
      console.error("dial failed:", (err as Error).message);
    });
  } else {
    console.log("waiting for incoming connections...");
  }

  updatePrompt();
  rl.prompt();

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();

    if (text.startsWith("/")) {
      handleCommand(text).then(() => rl.prompt());
      return;
    }

    if (!activePeer) {
      console.log("(no active peer yet — wait for a connection or use /to <id>)");
      return rl.prompt();
    }

    void messenger
      .send(activePeer, text)
      .then((result) => {
        store.save(activePeer!, "out", text);
        const tag = result.source === "offline" ? " (queued via relay)" : "";
        process.stdout.write(`\x1b[1A\x1b[2K\r${alias}> ${text}${tag}\n`);
        updatePrompt();
        rl.prompt();
      })
      .catch((err) => {
        console.error("send failed:", (err as Error).message);
        rl.prompt();
      });
  });

  rl.on("close", async () => {
    await presencePub?.stop();
    presenceWatch?.close();
    if (clock && clockPath) saveClock(clockPath, clock);
    dedup?.close();
    await messenger.close();
    await pool?.close();
    store.close();
    process.exit(0);
  });

  async function resolvePeerArg(raw: string): Promise<string> {
    if (!identity) return raw;
    if (!contacts) throw new Error("contact book not initialized");
    const r = await resolvePeer(raw, contacts);
    return r.pubkey;
  }

  function printRecent(p: string, limit = 10) {
    const msgs = store.recent(p, limit);
    if (msgs.length === 0) return;
    process.stdout.write(`(last ${msgs.length} with ${displayPeer(p)})\n`);
    for (const m of msgs) {
      const who = m.direction === "out" ? alias : displayPeer(m.peer);
      process.stdout.write(`  ${who}> ${m.text}\n`);
    }
  }

  async function handleCommand(cmd: string): Promise<void> {
    const [head, ...rest] = cmd.slice(1).split(/\s+/);

    if (head === "to" && rest[0]) {
      try {
        activePeer = await resolvePeerArg(rest[0]);
        knownPeers.add(activePeer);
        console.log(`(active peer set to ${displayPeer(activePeer)})`);
        updatePrompt();
      } catch (err) {
        console.error((err as Error).message);
      }
      return;
    }

    if (head === "dial" && rest[0]) {
      try {
        const target = await resolvePeerArg(rest[0]);
        knownPeers.add(target);
        if (presenceWatch && contacts) {
          presenceWatch.watch([...contacts.pubkeys(), target]);
        }
        activePeer = target;
        messenger.dial(target).catch((err) => console.error("dial failed:", err));
        console.log(`(dialing ${displayPeer(target)}...)`);
        updatePrompt();
      } catch (err) {
        console.error((err as Error).message);
      }
      return;
    }

    if (head === "peers") {
      const connected = messenger.connectedPeers();
      console.log("connected (P2P):", connected.map(displayPeer).join(", ") || "(none)");
      const others = [...knownPeers].filter((p) => !connected.includes(p));
      if (others.length > 0)
        console.log("known but not connected:", others.map(displayPeer).join(", "));
      if (presenceWatch) {
        const onlineNow = presenceWatch.online().map((s) => s.pubkey);
        if (onlineNow.length > 0)
          console.log("online (presence):", onlineNow.map(displayPeer).join(", "));
      }
      return;
    }

    if (head === "all") {
      const msg = rest.join(" ");
      if (!msg) {
        console.log("(usage: /all <message>)");
        return;
      }
      const targets = messenger.connectedPeers();
      if (targets.length === 0) {
        console.log("(no connected peers — use /sendto <peer> <msg> for offline send)");
        return;
      }
      for (const t of targets) {
        try {
          await messenger.send(t, msg);
          store.save(t, "out", msg);
        } catch (err) {
          console.error(`send to ${displayPeer(t)} failed:`, (err as Error).message);
        }
      }
      process.stdout.write(`${alias}> [→ all ${targets.length}] ${msg}\n`);
      return;
    }

    if (head === "sendto") {
      if (!rest[0] || !rest[1]) {
        console.log("(usage: /sendto <peer> <message>)");
        return;
      }
      try {
        const target = await resolvePeerArg(rest[0]);
        const text = rest.slice(1).join(" ");
        const r = await messenger.send(target, text);
        store.save(target, "out", text);
        console.log(`sent via ${r.source} to ${displayPeer(target)}`);
      } catch (err) {
        console.error("send failed:", (err as Error).message);
      }
      return;
    }

    if (head === "history") {
      const target = rest[0] ? await resolvePeerArg(rest[0]) : activePeer;
      if (!target) {
        console.log("(no peer — usage: /history [peerId])");
        return;
      }
      const limit = rest[1] ? Number(rest[1]) : 20;
      const msgs = store.recent(target, limit);
      if (msgs.length === 0) {
        console.log(`(no history with ${displayPeer(target)})`);
        return;
      }
      console.log(`--- last ${msgs.length} with ${displayPeer(target)} ---`);
      for (const m of msgs) {
        const when = new Date(m.ts).toLocaleTimeString();
        const who = m.direction === "out" ? alias : displayPeer(m.peer);
        console.log(`  [${when}] ${who}> ${m.text}`);
      }
      return;
    }

    if (head === "whoami") {
      if (identity) {
        console.log(`alias:    ${identity.alias}`);
        console.log(`npub:     ${identity.npub}`);
        console.log(`hex:      ${identity.publicKey}`);
        if (clock) {
          const snap = clock.snapshot();
          console.log(`clock:    ${JSON.stringify(snap)}`);
        }
      } else {
        console.log(`alias: ${alias} (ws transport — no Nostr identity)`);
      }
      return;
    }

    if (head === "contact") {
      if (!contacts) {
        console.log("(contacts only available on nostr transport)");
        return;
      }
      const sub = rest[0];
      if (sub === "add" && rest[1] && rest[2]) {
        try {
          const r = await resolvePeer(rest[2], contacts);
          contacts.add({
            alias: rest[1],
            pubkey: r.pubkey,
            note: rest.slice(3).join(" ") || undefined,
          });
          console.log(`added ${rest[1]} → ${shortPubkey(r.pubkey)}`);
          if (presenceWatch) presenceWatch.watch(contacts.pubkeys());
        } catch (err) {
          console.error((err as Error).message);
        }
        return;
      }
      if (sub === "rm" && rest[1]) {
        const ok = contacts.remove(rest[1]);
        console.log(ok ? `removed ${rest[1]}` : `no contact named ${rest[1]}`);
        if (presenceWatch) presenceWatch.watch(contacts.pubkeys());
        return;
      }
      if (sub === "list" || sub === undefined) {
        const list = contacts.list();
        if (list.length === 0)
          console.log("(no contacts yet — /contact add <alias> <npub|hex|nip05>)");
        for (const c of list) {
          const online = presenceWatch?.isOnline(c.pubkey) ? "●" : presenceWatch ? "○" : " ";
          console.log(
            `  ${online} ${c.alias.padEnd(12)} ${shortPubkey(c.pubkey)}${
              c.nip05 ? `  (${c.nip05})` : ""
            }`,
          );
        }
        return;
      }
      console.log(
        "usage: /contact add <alias> <npub|hex|nip05> | /contact rm <alias> | /contact list",
      );
      return;
    }

    if (head === "profile") {
      if (!identity || !pool) {
        console.log("(profile only available on nostr transport)");
        return;
      }
      if (rest[0] === "set" && rest[1]) {
        const name = rest[1];
        const about = rest.slice(2).join(" ") || undefined;
        try {
          await publishProfile({
            pool,
            secretKey: identity.secretKey,
            profile: { name, about },
          });
          console.log(`profile updated: name=${name}${about ? ` about="${about}"` : ""}`);
        } catch (err) {
          console.error("publish failed:", (err as Error).message);
        }
        return;
      }
      if (rest[0] === "get" && rest[1]) {
        try {
          const target = await resolvePeerArg(rest[1]);
          const profiles = await fetchProfiles(pool, [target]);
          const p: Profile | undefined = profiles.get(target);
          if (!p) console.log(`(no profile found for ${displayPeer(target)})`);
          else
            console.log(
              `name=${p.name ?? "(none)"}${p.about ? ` about="${p.about}"` : ""}${
                p.picture ? ` picture=${p.picture}` : ""
              }`,
            );
        } catch (err) {
          console.error((err as Error).message);
        }
        return;
      }
      console.log("usage: /profile set <name> [about...] | /profile get <peer>");
      return;
    }

    if (head === "online") {
      if (!presenceWatch) {
        console.log("(presence only available on nostr transport)");
        return;
      }
      const list = presenceWatch.online();
      if (list.length === 0) console.log("(no contacts online)");
      for (const s of list) {
        console.log(
          `  ● ${displayPeer(s.pubkey)}  (last seen ${new Date(s.ts * 1000).toLocaleTimeString()})`,
        );
      }
      return;
    }

    if (head === "help" || head === "?") {
      console.log("/whoami                       show your identity");
      console.log("/contact list                 list contacts");
      console.log("/contact add <alias> <ref>    add a contact (ref=npub|hex|nip05)");
      console.log("/contact rm <alias>           remove a contact");
      console.log("/profile set <name> [about]   publish your profile metadata");
      console.log("/profile get <peer>           fetch a peer's profile");
      console.log("/online                       list contacts currently online");
      console.log("/to <id|alias>                switch active peer");
      console.log("/dial <id|alias>              open a P2P (WebRTC) connection");
      console.log("/sendto <peer> <msg>          send (auto-routes P2P or relay)");
      console.log("/all <msg>                    broadcast to all P2P-connected peers");
      console.log("/peers                        list connected/known/online peers");
      console.log("/history [id] [n]             show recent messages");
      console.log("/quit                         exit");
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
