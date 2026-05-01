import {
  decodePeerRef,
  fetchProfiles,
  publishProfile,
  resolvePeer,
} from "@p2p/core";
import type { Session } from "./services.js";
import type { Action, ContextRef, LogEntry } from "./state.js";
import { shortPubkey } from "./colors.js";

export type CommandResult = {
  /** Reducer actions to dispatch as a result of the command. */
  actions: Action[];
  /** True iff the command requested an exit. */
  exit?: boolean;
};

/**
 * Run a single slash command. The dispatcher mutates external state (sends
 * messages, dials peers, updates contacts) and returns a list of reducer
 * actions for the caller to apply — keeping the TUI's render loop in sync
 * with the side effects.
 */
export async function runCommand(
  raw: string,
  session: Session,
  active: ContextRef | undefined,
): Promise<CommandResult> {
  const [head, ...rest] = raw.slice(1).split(/\s+/);
  const out: Action[] = [];

  const sysLog = (text: string, kind: LogEntry["kind"] = "system") =>
    out.push({
      type: "log/append",
      entry: {
        ts: nowSeconds(),
        context: { kind: "system" },
        kind,
        text,
      },
    });

  const inActiveLog = (text: string, kind: LogEntry["kind"] = "system") => {
    if (!active) return sysLog(text, kind);
    out.push({
      type: "log/append",
      entry: { ts: nowSeconds(), context: active, kind, text },
    });
  };

  if (head === "help" || head === "?") {
    sysLog("/whoami                       show your identity");
    sysLog("/contact list|add|rm          manage contacts");
    sysLog("/profile set|get              manage Nostr profile metadata");
    sysLog("/online                       list contacts currently online");
    sysLog("/peers                        list connected peers");
    sysLog("/dial <peer>                  open a P2P (WebRTC) connection");
    sysLog("/sendto <peer> <msg>          one-shot send to a peer");
    sysLog("/all <msg>                    broadcast to all P2P-connected peers");
    sysLog("/group create|invite|accept|… group commands");
    sysLog("/win <n>                      switch to window n");
    sysLog("/quit                         exit");
    sysLog("Tab completes commands and @aliases. Up/Down recalls history. Ctrl+N/P switches window.");
    return { actions: out };
  }

  if (head === "quit" || head === "exit") return { actions: out, exit: true };

  if (head === "whoami") {
    if (!session.identity) {
      sysLog(`alias: ${session.alias} (ws transport — no Nostr identity)`);
      return { actions: out };
    }
    sysLog(`alias:    ${session.identity.alias}`);
    sysLog(`npub:     ${session.identity.npub}`);
    sysLog(`hex:      ${session.identity.publicKey}`);
    return { actions: out };
  }

  if (head === "online") {
    if (!session.presenceWatch) {
      sysLog("(presence only available on nostr transport)", "error");
      return { actions: out };
    }
    const list = session.presenceWatch.online();
    if (list.length === 0) sysLog("(no contacts online)");
    for (const s of list) {
      const c = session.contacts?.byPubkeyOrUndefined(s.pubkey);
      const name = c?.alias ?? shortPubkey(s.pubkey);
      sysLog(`● ${name}  (last seen ${new Date(s.ts * 1000).toLocaleTimeString()})`);
    }
    return { actions: out };
  }

  if (head === "peers") {
    const connected = session.messenger.connectedPeers();
    if (connected.length === 0) sysLog("(no P2P connections)");
    for (const p of connected) {
      const c = session.contacts?.byPubkeyOrUndefined(p);
      sysLog(`● ${c?.alias ?? shortPubkey(p)}  (P2P)`);
    }
    return { actions: out };
  }

  if (head === "dial" && rest[0]) {
    try {
      const target = await resolvePeerArg(rest[0], session);
      sysLog(`dialing ${displayPeer(target, session)}…`);
      session.messenger.dial(target).catch((err) => {
        // Best-effort: if dial errors later, surface it via a follow-up log entry.
        // We can't push to `out` here since we've already returned.
        console.error("dial failed:", err);
      });
      const ref: ContextRef = { kind: "peer", pubkey: target };
      out.push({
        type: "context/upsert",
        summary: { ref, label: displayPeer(target, session), unread: 0 },
      });
      out.push({ type: "context/focus", ref });
    } catch (err) {
      sysLog((err as Error).message, "error");
    }
    return { actions: out };
  }

  if (head === "to" && rest[0]) {
    try {
      const target = await resolvePeerArg(rest[0], session);
      const ref: ContextRef = { kind: "peer", pubkey: target };
      out.push({
        type: "context/upsert",
        summary: { ref, label: displayPeer(target, session), unread: 0 },
      });
      out.push({ type: "context/focus", ref });
    } catch (err) {
      sysLog((err as Error).message, "error");
    }
    return { actions: out };
  }

  if (head === "sendto" && rest[0] && rest[1]) {
    try {
      const target = await resolvePeerArg(rest[0], session);
      const text = rest.slice(1).join(" ");
      const result = await session.messenger.send(target, text);
      session.messageStore.save(target, "out", text);
      out.push({
        type: "log/append",
        entry: {
          ts: nowSeconds(),
          context: { kind: "peer", pubkey: target },
          kind: "self",
          sender: session.alias,
          text,
          source: result.source,
        },
      });
      out.push({
        type: "context/upsert",
        summary: {
          ref: { kind: "peer", pubkey: target },
          label: displayPeer(target, session),
          unread: 0,
        },
      });
    } catch (err) {
      sysLog((err as Error).message, "error");
    }
    return { actions: out };
  }

  if (head === "all") {
    const msg = rest.join(" ");
    if (!msg) {
      sysLog("usage: /all <message>", "error");
      return { actions: out };
    }
    const targets = session.messenger.connectedPeers();
    if (targets.length === 0) {
      sysLog("(no connected peers)", "error");
      return { actions: out };
    }
    for (const t of targets) {
      try {
        await session.messenger.send(t, msg);
        session.messageStore.save(t, "out", msg);
      } catch (err) {
        sysLog(
          `send to ${displayPeer(t, session)} failed: ${(err as Error).message}`,
          "error",
        );
      }
    }
    sysLog(`(broadcast to ${targets.length} peers) ${msg}`);
    return { actions: out };
  }

  if (head === "contact") {
    if (!session.contacts) {
      sysLog("(contacts only available on nostr transport)", "error");
      return { actions: out };
    }
    const sub = rest[0];
    if (sub === "add" && rest[1] && rest[2]) {
      try {
        const r = await resolvePeer(rest[2], session.contacts);
        session.contacts.add({
          alias: rest[1],
          pubkey: r.pubkey,
          note: rest.slice(3).join(" ") || undefined,
        });
        sysLog(`added ${rest[1]} → ${shortPubkey(r.pubkey)}`);
        if (session.presenceWatch)
          session.presenceWatch.watch(session.contacts.pubkeys());
      } catch (err) {
        sysLog((err as Error).message, "error");
      }
      return { actions: out };
    }
    if (sub === "rm" && rest[1]) {
      const ok = session.contacts.remove(rest[1]);
      sysLog(ok ? `removed ${rest[1]}` : `no contact named ${rest[1]}`);
      if (session.presenceWatch) session.presenceWatch.watch(session.contacts.pubkeys());
      return { actions: out };
    }
    if (sub === "list" || !sub) {
      const list = session.contacts.list();
      if (list.length === 0) sysLog("(no contacts — /contact add <alias> <ref>)");
      for (const c of list) {
        const online = session.presenceWatch?.isOnline(c.pubkey) ? "●" : "○";
        sysLog(`  ${online} ${c.alias.padEnd(12)} ${shortPubkey(c.pubkey)}`);
      }
      return { actions: out };
    }
    sysLog("usage: /contact add|rm|list", "error");
    return { actions: out };
  }

  if (head === "profile") {
    if (!session.identity || !session.pool) {
      sysLog("(profile only available on nostr transport)", "error");
      return { actions: out };
    }
    if (rest[0] === "set" && rest[1]) {
      const name = rest[1];
      const about = rest.slice(2).join(" ") || undefined;
      try {
        await publishProfile({
          pool: session.pool,
          secretKey: session.identity.secretKey,
          profile: { name, about },
        });
        sysLog(`profile updated: name=${name}${about ? ` about="${about}"` : ""}`);
      } catch (err) {
        sysLog(`publish failed: ${(err as Error).message}`, "error");
      }
      return { actions: out };
    }
    if (rest[0] === "get" && rest[1]) {
      try {
        const target = await resolvePeerArg(rest[1], session);
        const profiles = await fetchProfiles(session.pool, [target]);
        const p = profiles.get(target);
        if (!p) sysLog(`(no profile for ${displayPeer(target, session)})`);
        else
          sysLog(
            `name=${p.name ?? "(none)"}${p.about ? ` about="${p.about}"` : ""}${
              p.picture ? ` picture=${p.picture}` : ""
            }`,
          );
      } catch (err) {
        sysLog((err as Error).message, "error");
      }
      return { actions: out };
    }
    sysLog("usage: /profile set|get", "error");
    return { actions: out };
  }

  if (head === "group") {
    if (!session.groupMessenger || !session.groupStore) {
      sysLog("(groups only available on nostr transport)", "error");
      return { actions: out };
    }
    const sub = rest[0];
    const gm = session.groupMessenger;
    const gs = session.groupStore;

    if (sub === "create" && rest[1]) {
      const name = rest.slice(1).join(" ");
      const g = gm.createGroup(name);
      const ref: ContextRef = { kind: "group", groupId: g.id };
      out.push({
        type: "context/upsert",
        summary: { ref, label: `#${g.name}`, unread: 0 },
      });
      out.push({ type: "context/focus", ref });
      sysLog(`created #${g.name} (id=${g.id.slice(0, 8)}…)`);
      return { actions: out };
    }

    if (sub === "invite" && rest[1]) {
      const target = active?.kind === "group" ? active.groupId : undefined;
      if (!target) {
        sysLog("(focus a group first — /group focus <name>)", "error");
        return { actions: out };
      }
      try {
        const peerPk = await resolvePeerArg(rest[1], session);
        await gm.invite({ groupId: target, peerPubkey: peerPk });
        sysLog(`invited ${displayPeer(peerPk, session)}`);
      } catch (err) {
        sysLog(`invite failed: ${(err as Error).message}`, "error");
      }
      return { actions: out };
    }

    if (sub === "accept" && rest[1]) {
      const partial = rest[1];
      const match = gs.invites().find((i) => i.eventId.startsWith(partial));
      if (!match) {
        sysLog(`(no pending invite matching "${partial}")`, "error");
        return { actions: out };
      }
      try {
        const g = await gm.accept(match.eventId);
        const ref: ContextRef = { kind: "group", groupId: g.id };
        out.push({
          type: "context/upsert",
          summary: { ref, label: `#${g.name}`, unread: 0 },
        });
        out.push({ type: "context/focus", ref });
        out.push({ type: "invite/remove", eventId: match.eventId });
        sysLog(`joined #${g.name} (${g.members.length} members)`);
      } catch (err) {
        sysLog((err as Error).message, "error");
      }
      return { actions: out };
    }

    if (sub === "invites") {
      const list = gs.invites();
      if (list.length === 0) sysLog("(no pending invites)");
      for (const i of list) {
        sysLog(
          `${i.eventId.slice(0, 8)}  "${i.groupName}" from ${displayPeer(i.inviter, session)} (${i.members.length} members)`,
        );
      }
      return { actions: out };
    }

    if (sub === "list" || !sub) {
      const list = gs.list();
      if (list.length === 0) sysLog("(no groups)");
      for (const g of list) {
        sysLog(`#${g.name}  ${g.members.length} members  (id=${g.id.slice(0, 8)}…)`);
      }
      return { actions: out };
    }

    if (sub === "focus" && rest[1]) {
      const name = rest.slice(1).join(" ");
      const g = gs.byName(name) ?? gs.get(name);
      if (!g) {
        sysLog(`(no group "${name}")`, "error");
        return { actions: out };
      }
      const ref: ContextRef = { kind: "group", groupId: g.id };
      out.push({
        type: "context/upsert",
        summary: { ref, label: `#${g.name}`, unread: 0 },
      });
      out.push({ type: "context/focus", ref });
      return { actions: out };
    }

    if (sub === "members" && rest[1]) {
      const name = rest.slice(1).join(" ");
      const g = gs.byName(name) ?? gs.get(name);
      if (!g) {
        sysLog(`(no group "${name}")`, "error");
        return { actions: out };
      }
      for (const m of g.members) {
        const me = m === session.identity?.publicKey ? "  (you)" : "";
        sysLog(`  ${displayPeer(m, session)}${me}`);
      }
      return { actions: out };
    }

    if (sub === "leave" && rest[1]) {
      const name = rest.slice(1).join(" ");
      const g = gs.byName(name) ?? gs.get(name);
      if (!g) {
        sysLog(`(no group "${name}")`, "error");
        return { actions: out };
      }
      try {
        await gm.leave(g.id);
        sysLog(`left #${g.name}`);
      } catch (err) {
        sysLog((err as Error).message, "error");
      }
      return { actions: out };
    }

    sysLog(
      "usage: /group create|invite|accept|invites|list|focus|members|leave",
      "error",
    );
    return { actions: out };
  }

  inActiveLog(`unknown command: /${head} (try /help)`, "error");
  return { actions: out };
}

async function resolvePeerArg(raw: string, session: Session): Promise<string> {
  if (!session.identity) return raw;
  if (!session.contacts) {
    return decodePeerRef(raw);
  }
  const r = await resolvePeer(raw, session.contacts);
  return r.pubkey;
}

export function displayPeer(pubkey: string, session: Session): string {
  if (!session.identity) return pubkey;
  const c = session.contacts?.byPubkeyOrUndefined(pubkey);
  if (c) return c.alias;
  return shortPubkey(pubkey);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
