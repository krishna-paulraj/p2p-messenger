import { useEffect, useReducer, useMemo, useCallback } from "react";
import { Box, useApp, useInput, useStdout } from "ink";
import { Header } from "./Header.js";
import { Scrollback } from "./Scrollback.js";
import { StatusBar } from "./StatusBar.js";
import { Input } from "./Input.js";
import {
  initialState,
  reducer,
  type ContextRef,
  sameContext,
} from "./state.js";
import type { Session } from "./services.js";
import { displayPeer, runCommand } from "./commands.js";
import { shortPubkey } from "./colors.js";

export type AppProps = {
  session: Session;
};

export function App({ session }: AppProps) {
  const [state, dispatch] = useReducer(
    reducer,
    initialState({
      alias: session.alias,
      selfPubkey: session.identity?.publicKey,
      npub: session.identity?.npub,
      signalDescription: session.description,
      relays:
        session.pool?.relays.map((url) => ({ url, status: "ok" as const })) ?? [],
    }),
  );
  const { exit } = useApp();
  const { stdout } = useStdout();

  // ---- Bridge core service callbacks → reducer actions ----
  useEffect(() => {
    const unsubs: Array<() => void> = [];

    // 1:1 messenger — connect / message / source
    unsubs.push(
      session.messenger.onConnect((peerPubkey) => {
        dispatch({ type: "peer/connected", pubkey: peerPubkey });
        const ref: ContextRef = { kind: "peer", pubkey: peerPubkey };
        dispatch({
          type: "context/upsert",
          summary: { ref, label: contactLabel(peerPubkey), unread: 0 },
        });
        dispatch({
          type: "log/append",
          entry: {
            ts: nowSeconds(),
            context: ref,
            kind: "system",
            text: `connected (WebRTC P2P) to ${contactLabel(peerPubkey)}`,
          },
        });
      }),
    );

    unsubs.push(
      session.messenger.onMessage((msg) => {
        const ref: ContextRef = { kind: "peer", pubkey: msg.from };
        dispatch({
          type: "context/upsert",
          summary: { ref, label: contactLabel(msg.from), unread: 0 },
        });
        dispatch({
          type: "log/append",
          entry: {
            ts: msg.ts,
            context: ref,
            kind: "peer",
            sender: contactLabel(msg.from),
            text: msg.text,
            source: msg.source,
            fromDrain: msg.fromDrain,
          },
        });
        session.messageStore.save(msg.from, "in", msg.text);
      }),
    );

    // Group messenger — message / invite / membership
    if (session.groupMessenger) {
      const gm = session.groupMessenger;
      unsubs.push(
        gm.onMessage((msg) => {
          const ref: ContextRef = { kind: "group", groupId: msg.groupId };
          dispatch({
            type: "context/upsert",
            summary: { ref, label: `#${msg.groupName}`, unread: 0 },
          });
          const isSelf =
            session.identity !== undefined && msg.from === session.identity.publicKey;
          dispatch({
            type: "log/append",
            entry: {
              ts: msg.ts,
              context: ref,
              kind: isSelf ? "group-self" : "group-peer",
              sender: isSelf ? session.alias : contactLabel(msg.from),
              text: msg.text,
              fromDrain: msg.fromDrain,
            },
          });
        }),
      );
      unsubs.push(
        gm.onInvite((inv) => {
          dispatch({
            type: "invite/add",
            eventId: inv.eventId,
            groupId: inv.groupId,
            groupName: inv.groupName,
            inviter: inv.inviter,
          });
          dispatch({
            type: "log/append",
            entry: {
              ts: inv.ts,
              context: { kind: "system" },
              kind: "system",
              text: `group invite "${inv.groupName}" from ${contactLabel(
                inv.inviter,
              )} — accept with /group accept ${inv.eventId.slice(0, 8)}`,
            },
          });
        }),
      );
      unsubs.push(
        gm.onMembership((e) => {
          const g = session.groupStore?.get(e.groupId);
          if (!g) return;
          const ref: ContextRef = { kind: "group", groupId: e.groupId };
          dispatch({
            type: "context/upsert",
            summary: { ref, label: `#${g.name}`, unread: 0 },
          });
          dispatch({
            type: "log/append",
            entry: {
              ts: nowSeconds(),
              context: ref,
              kind: "group-event",
              text: `${e.kind === "joined" ? "+" : "−"} ${contactLabel(e.pubkey)}`,
            },
          });
        }),
      );
    }

    // Presence
    if (session.presenceWatch) {
      unsubs.push(
        session.presenceWatch.on((snap) => {
          dispatch({
            type: "presence",
            pubkey: snap.pubkey,
            online: snap.status === "online",
          });
          const c = session.contacts?.byPubkeyOrUndefined(snap.pubkey);
          if (!c) return;
          dispatch({
            type: "log/append",
            entry: {
              ts: snap.ts,
              context: { kind: "system" },
              kind: "presence",
              text: `${c.alias} ${snap.status === "online" ? "is online" : "went offline"}`,
            },
          });
        }),
      );

      // Initialize watchlist from contacts
      if (session.contacts) {
        const list = session.contacts.pubkeys();
        if (list.length > 0) session.presenceWatch.watch(list);
      }
    }

    return () => {
      for (const u of unsubs) u();
    };
    // We deliberately depend only on `session` — its identity is the natural
    // lifecycle of all subscriptions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // ---- Startup banner ----
  useEffect(() => {
    dispatch({
      type: "log/append",
      entry: {
        ts: nowSeconds(),
        context: { kind: "system" },
        kind: "system",
        text: `${session.description}`,
      },
    });
    if (session.identity) {
      dispatch({
        type: "log/append",
        entry: {
          ts: nowSeconds(),
          context: { kind: "system" },
          kind: "system",
          text: `your npub: ${session.identity.npub}`,
        },
      });
    }
    if (session.offline) {
      dispatch({
        type: "log/append",
        entry: {
          ts: nowSeconds(),
          context: { kind: "system" },
          kind: "system",
          text: `offline drain enabled (NIP-17)`,
        },
      });
    }
    if (session.groupMessenger && session.groupStore) {
      const groups = session.groupStore.list();
      if (groups.length > 0) {
        for (const g of groups) {
          dispatch({
            type: "context/upsert",
            summary: { ref: { kind: "group", groupId: g.id }, label: `#${g.name}`, unread: 0 },
          });
        }
        dispatch({
          type: "log/append",
          entry: {
            ts: nowSeconds(),
            context: { kind: "system" },
            kind: "system",
            text: `tracking ${groups.length} group(s)`,
          },
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const contactLabel = useCallback(
    (pubkey: string): string => displayPeer(pubkey, session),
    [session],
  );

  // ---- Submit handler: command vs chat ----
  const onSubmit = useCallback(
    async (text: string) => {
      if (text.startsWith("/")) {
        // /win <n> handled here so we don't have to thread state through commands
        const m = text.match(/^\/win\s+(\d+)/);
        if (m) {
          const idx = Number(m[1]) - 1;
          const target = state.contexts[idx];
          if (target) {
            dispatch({ type: "context/focus", ref: target.ref });
          }
          return;
        }
        const result = await runCommand(text, session, state.active);
        for (const a of result.actions) dispatch(a);
        if (result.exit) exit();
        return;
      }

      // Plain text — depends on active context
      if (!state.active || state.active.kind === "system") {
        dispatch({
          type: "log/append",
          entry: {
            ts: nowSeconds(),
            context: { kind: "system" },
            kind: "error",
            text: "no active context — /dial <peer> or /group focus <name>",
          },
        });
        return;
      }

      if (state.active.kind === "peer") {
        const target = state.active.pubkey;
        try {
          const result = await session.messenger.send(target, text);
          session.messageStore.save(target, "out", text);
          dispatch({
            type: "log/append",
            entry: {
              ts: nowSeconds(),
              context: state.active,
              kind: "self",
              sender: session.alias,
              text,
              source: result.source,
            },
          });
        } catch (err) {
          dispatch({
            type: "log/append",
            entry: {
              ts: nowSeconds(),
              context: state.active,
              kind: "error",
              text: `send failed: ${(err as Error).message}`,
            },
          });
        }
        return;
      }

      if (state.active.kind === "group" && session.groupMessenger) {
        const gid = state.active.groupId;
        try {
          await session.groupMessenger.send(gid, text);
          dispatch({
            type: "log/append",
            entry: {
              ts: nowSeconds(),
              context: state.active,
              kind: "group-self",
              sender: session.alias,
              text,
            },
          });
        } catch (err) {
          dispatch({
            type: "log/append",
            entry: {
              ts: nowSeconds(),
              context: state.active,
              kind: "error",
              text: `group send failed: ${(err as Error).message}`,
            },
          });
        }
      }
    },
    [session, state.active, state.contexts, exit],
  );

  // ---- Window switching ----
  useInput((input, key) => {
    if (key.ctrl && input === "n") {
      const idx = state.contexts.findIndex((c) => sameContext(c.ref, state.active));
      const next = state.contexts[(idx + 1) % state.contexts.length];
      if (next) dispatch({ type: "context/focus", ref: next.ref });
    }
    if (key.ctrl && input === "p") {
      const idx = state.contexts.findIndex((c) => sameContext(c.ref, state.active));
      const prev =
        state.contexts[(idx - 1 + state.contexts.length) % state.contexts.length];
      if (prev) dispatch({ type: "context/focus", ref: prev.ref });
    }
  });

  // ---- Layout sizing ----
  const rows = stdout.rows ?? 24;
  // Reserve: header(3) + status(4) + input(1) + spacing(1) = ~9 rows
  const visibleScrollback = Math.max(5, rows - 9);

  const inputLabel = useMemo(() => {
    if (!state.active || state.active.kind === "system") return "*system*";
    if (state.active.kind === "peer") return `→ ${displayPeer(state.active.pubkey, session)}`;
    return state.contexts.find((c) => sameContext(c.ref, state.active))?.label ?? "—";
  }, [state.active, state.contexts, session]);

  const completionAliases = useMemo(() => {
    const aliases = new Set<string>();
    if (session.contacts) {
      for (const c of session.contacts.list()) aliases.add(c.alias);
    }
    if (session.groupStore) {
      for (const g of session.groupStore.list()) aliases.add(g.name);
    }
    return [...aliases];
  }, [session]);

  const resolveDisplay = useCallback(
    (ref: ContextRef): string => {
      if (ref.kind === "peer") return displayPeer(ref.pubkey, session);
      if (ref.kind === "group") {
        const g = session.groupStore?.get(ref.groupId);
        return g ? `#${g.name}` : `#${shortPubkey(ref.groupId)}`;
      }
      return "*system*";
    },
    [session],
  );

  return (
    <Box flexDirection="column" width={stdout.columns ?? 80} height={rows}>
      <Header state={state} />
      <Scrollback state={state} visibleRows={visibleScrollback} />
      <StatusBar state={state} resolveDisplay={resolveDisplay} />
      <Input label={inputLabel} completionAliases={completionAliases} onSubmit={onSubmit} />
    </Box>
  );
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
