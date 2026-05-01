/**
 * Centralized state for the TUI. Reducer-driven so React state mutations
 * are explicit, ordered, and easy to reason about.
 *
 * The reducer is pure: side effects (sending messages, dialing peers) live
 * in the command dispatcher and only THEN dispatch a "result" action to
 * update state. Async events from the messenger / presence / group layers
 * flow into the reducer as actions through useEffect bridges.
 */

export type ContextRef =
  | { kind: "peer"; pubkey: string }
  | { kind: "group"; groupId: string }
  | { kind: "system" /* neutral channel for startup info */ };

export type LogEntry = {
  /** Stable id for React reconciliation. UNIX-millis + counter. */
  id: string;
  /** UNIX seconds — used for display timestamps. */
  ts: number;
  context: ContextRef;
  /** Visual category — drives color + glyph. */
  kind:
    | "self"
    | "peer"
    | "system"
    | "presence"
    | "group-self"
    | "group-peer"
    | "group-event"
    | "error";
  /** Optional sender display name (for peer/group-peer). */
  sender?: string;
  text: string;
  /** Source channel ("p2p" / "relay") for 1:1 messages. */
  source?: "webrtc" | "offline";
  /** True for messages drained from the offline queue at startup. */
  fromDrain?: boolean;
};

export type ContextSummary = {
  ref: ContextRef;
  /** What to show in the status bar / window list. */
  label: string;
  /** Number of unseen messages while this context wasn't focused. */
  unread: number;
};

export type RelayHealth = {
  url: string;
  status: "ok" | "degraded" | "unknown";
};

export type AppState = {
  alias: string;
  /** Hex pubkey, undefined for ws transport. */
  selfPubkey?: string;
  /** Bech32 npub, undefined for ws transport. */
  npub?: string;
  signalDescription: string;
  relays: RelayHealth[];
  /** All log entries, append-only. UI may filter by activeContext for display. */
  log: LogEntry[];
  /** Distinct conversation contexts known so far. */
  contexts: ContextSummary[];
  /** Currently focused context. */
  active?: ContextRef;
  /** Connection state per peer pubkey. */
  connectedPeers: Set<string>;
  /** Recent online status — true means presence event seen within freshness window. */
  online: Map<string, boolean>;
  /** Pending group invites (eventId → display info). */
  invites: { eventId: string; groupId: string; groupName: string; inviter: string }[];
};

export type Action =
  | { type: "init"; payload: Partial<AppState> }
  | { type: "log/append"; entry: Omit<LogEntry, "id"> }
  | { type: "context/focus"; ref: ContextRef }
  | { type: "context/upsert"; summary: ContextSummary }
  | { type: "peer/connected"; pubkey: string }
  | { type: "peer/disconnected"; pubkey: string }
  | { type: "presence"; pubkey: string; online: boolean }
  | { type: "invite/add"; eventId: string; groupId: string; groupName: string; inviter: string }
  | { type: "invite/remove"; eventId: string }
  | { type: "relay/update"; relays: RelayHealth[] };

let nextLogCounter = 0;
function nextLogId(): string {
  nextLogCounter += 1;
  return `${Date.now().toString(36)}-${nextLogCounter}`;
}

export function initialState(seed: Partial<AppState>): AppState {
  return {
    alias: seed.alias ?? "?",
    selfPubkey: seed.selfPubkey,
    npub: seed.npub,
    signalDescription: seed.signalDescription ?? "",
    relays: seed.relays ?? [],
    log: [],
    contexts: [{ ref: { kind: "system" }, label: "*system*", unread: 0 }],
    active: { kind: "system" },
    connectedPeers: new Set(),
    online: new Map(),
    invites: [],
  };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "init":
      return { ...state, ...action.payload };

    case "log/append": {
      const entry: LogEntry = { id: nextLogId(), ...action.entry };
      const log = [...state.log, entry];
      // Bump unread counter on the entry's context if it's not focused.
      const isActive = sameContext(state.active, entry.context);
      const contexts = state.contexts.map((c) =>
        sameContext(c.ref, entry.context) && !isActive
          ? { ...c, unread: c.unread + 1 }
          : c,
      );
      return { ...state, log, contexts };
    }

    case "context/focus": {
      const contexts = state.contexts.map((c) =>
        sameContext(c.ref, action.ref) ? { ...c, unread: 0 } : c,
      );
      return { ...state, active: action.ref, contexts };
    }

    case "context/upsert": {
      const exists = state.contexts.some((c) => sameContext(c.ref, action.summary.ref));
      const contexts = exists
        ? state.contexts.map((c) =>
            sameContext(c.ref, action.summary.ref)
              ? { ...c, label: action.summary.label }
              : c,
          )
        : [...state.contexts, action.summary];
      return { ...state, contexts };
    }

    case "peer/connected": {
      const next = new Set(state.connectedPeers);
      next.add(action.pubkey);
      return { ...state, connectedPeers: next };
    }

    case "peer/disconnected": {
      const next = new Set(state.connectedPeers);
      next.delete(action.pubkey);
      return { ...state, connectedPeers: next };
    }

    case "presence": {
      const next = new Map(state.online);
      next.set(action.pubkey, action.online);
      return { ...state, online: next };
    }

    case "invite/add": {
      if (state.invites.some((i) => i.eventId === action.eventId)) return state;
      return {
        ...state,
        invites: [
          ...state.invites,
          {
            eventId: action.eventId,
            groupId: action.groupId,
            groupName: action.groupName,
            inviter: action.inviter,
          },
        ],
      };
    }

    case "invite/remove":
      return { ...state, invites: state.invites.filter((i) => i.eventId !== action.eventId) };

    case "relay/update":
      return { ...state, relays: action.relays };

    default:
      return state;
  }
}

export function sameContext(a: ContextRef | undefined, b: ContextRef | undefined): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "peer" && b.kind === "peer") return a.pubkey === b.pubkey;
  if (a.kind === "group" && b.kind === "group") return a.groupId === b.groupId;
  return a.kind === "system" && b.kind === "system";
}
