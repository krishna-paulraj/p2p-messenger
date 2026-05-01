/**
 * Single source of truth for slash commands. Drives:
 *   - the suggestion popup (filter by name prefix)
 *   - the bottom hints bar (filter by active context)
 *   - the /help system message
 *
 * Keep this in sync with the runCommand dispatcher in commands.ts.
 */

export type ContextKind = "system" | "peer" | "group";

export type CommandSpec = {
  /** Canonical command name; "/group invite", "/dial", etc. */
  name: string;
  /** Full syntax including args; "/dial <peer>". */
  syntax: string;
  /** One-line description shown in suggestions and hints. */
  description: string;
  /**
   * Contexts where this command is most useful. Hints filter by this.
   * Suggestions ignore context (any command can be invoked from anywhere)
   * but de-emphasize ones that don't match the active context.
   */
  contexts: ContextKind[];
  /** True if a leading-space arg placeholder should follow the name on accept. */
  takesArgs: boolean;
};

export const COMMANDS: CommandSpec[] = [
  // — Identity & meta —
  {
    name: "/help",
    syntax: "/help",
    description: "show all commands",
    contexts: ["system", "peer", "group"],
    takesArgs: false,
  },
  {
    name: "/whoami",
    syntax: "/whoami",
    description: "show your identity (alias, npub, pubkey)",
    contexts: ["system", "peer", "group"],
    takesArgs: false,
  },
  {
    name: "/quit",
    syntax: "/quit",
    description: "exit the chat",
    contexts: ["system", "peer", "group"],
    takesArgs: false,
  },

  // — Contacts —
  {
    name: "/contact list",
    syntax: "/contact list",
    description: "list your saved contacts",
    contexts: ["system", "peer", "group"],
    takesArgs: false,
  },
  {
    name: "/contact add",
    syntax: "/contact add <alias> <npub|hex|nip05>",
    description: "save someone as a contact under a local alias",
    contexts: ["system", "peer", "group"],
    takesArgs: true,
  },
  {
    name: "/contact rm",
    syntax: "/contact rm <alias>",
    description: "remove a contact",
    contexts: ["system", "peer", "group"],
    takesArgs: true,
  },

  // — Profile (Nostr metadata) —
  {
    name: "/profile set",
    syntax: "/profile set <name> [about...]",
    description: "publish your profile metadata (kind 0)",
    contexts: ["system", "peer", "group"],
    takesArgs: true,
  },
  {
    name: "/profile get",
    syntax: "/profile get <peer>",
    description: "fetch a peer's profile",
    contexts: ["system", "peer", "group"],
    takesArgs: true,
  },

  // — Presence & peers —
  {
    name: "/online",
    syntax: "/online",
    description: "list contacts currently online",
    contexts: ["system", "peer"],
    takesArgs: false,
  },
  {
    name: "/peers",
    syntax: "/peers",
    description: "list connected P2P peers",
    contexts: ["system", "peer"],
    takesArgs: false,
  },

  // — 1:1 conversation —
  {
    name: "/dial",
    syntax: "/dial <peer>",
    description: "open a P2P (WebRTC) connection",
    contexts: ["system", "peer"],
    takesArgs: true,
  },
  {
    name: "/to",
    syntax: "/to <peer>",
    description: "switch the active peer (no dial)",
    contexts: ["system", "peer"],
    takesArgs: true,
  },
  {
    name: "/sendto",
    syntax: "/sendto <peer> <msg>",
    description: "one-shot send (auto-routes P2P or relay)",
    contexts: ["system", "peer"],
    takesArgs: true,
  },
  {
    name: "/all",
    syntax: "/all <msg>",
    description: "broadcast to all P2P-connected peers",
    contexts: ["system", "peer"],
    takesArgs: true,
  },
  {
    name: "/history",
    syntax: "/history [peer] [n]",
    description: "show recent messages with a peer",
    contexts: ["peer"],
    takesArgs: true,
  },

  // — Groups —
  {
    name: "/group create",
    syntax: "/group create <name>",
    description: "create a new group (you become its first member)",
    contexts: ["system", "peer"],
    takesArgs: true,
  },
  {
    name: "/group invite",
    syntax: "/group invite <peer>",
    description: "invite a peer to the active group",
    contexts: ["group"],
    takesArgs: true,
  },
  {
    name: "/group accept",
    syntax: "/group accept <id-prefix>",
    description: "accept a pending group invite",
    contexts: ["system", "peer", "group"],
    takesArgs: true,
  },
  {
    name: "/group invites",
    syntax: "/group invites",
    description: "list pending group invites",
    contexts: ["system", "peer", "group"],
    takesArgs: false,
  },
  {
    name: "/group list",
    syntax: "/group list",
    description: "list all your groups",
    contexts: ["system", "peer", "group"],
    takesArgs: false,
  },
  {
    name: "/group focus",
    syntax: "/group focus <name>",
    description: "switch to a group",
    contexts: ["system", "peer", "group"],
    takesArgs: true,
  },
  {
    name: "/group members",
    syntax: "/group members <name>",
    description: "list members of a group",
    contexts: ["group"],
    takesArgs: true,
  },
  {
    name: "/group leave",
    syntax: "/group leave <name>",
    description: "leave a group (triggers key rotation)",
    contexts: ["group"],
    takesArgs: true,
  },

  // — Window switching —
  {
    name: "/win",
    syntax: "/win <n>",
    description: "jump directly to window n",
    contexts: ["system", "peer", "group"],
    takesArgs: true,
  },
];

/** Filter by case-insensitive prefix match against the canonical name. */
export function filterByPrefix(prefix: string): CommandSpec[] {
  const p = prefix.toLowerCase();
  return COMMANDS.filter((c) => c.name.toLowerCase().startsWith(p));
}

/** Top-N most relevant commands for the current context (used by Hints). */
export function hintsFor(active: ContextKind): CommandSpec[] {
  // Pick a curated subset per context — not the entire matching list.
  if (active === "group") {
    return pick(["/group invite", "/group members", "/group leave", "/group list", "/group exit", "/win"]);
  }
  if (active === "peer") {
    return pick(["/dial", "/sendto", "/history", "/to", "/peers", "/win"]);
  }
  // system
  return pick(["/whoami", "/contact list", "/dial", "/group create", "/group invites", "/help"]);
}

function pick(names: string[]): CommandSpec[] {
  const map = new Map(COMMANDS.map((c) => [c.name, c] as const));
  return names.map((n) => map.get(n)).filter((x): x is CommandSpec => x !== undefined);
}
