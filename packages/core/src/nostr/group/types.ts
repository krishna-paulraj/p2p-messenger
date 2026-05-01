/**
 * Wire and storage types for groups.
 *
 * Wire types are NIP-17-style chat-message content (kind 14) but with a
 * `type` discriminator inside the JSON content so they don't collide with
 * regular 1:1 messages. Carrying everything inside kind 14 keeps the relay
 * footprint identical to chat — relays can't even tell which messages are
 * group control vs group data.
 */

export const GROUP_CONTENT_TYPES = {
  INVITE: "p2p-group-invite",
  SENDER_KEY: "p2p-group-sender-key",
  MESSAGE: "p2p-group-message",
  LEAVE: "p2p-group-leave",
} as const;

export type GroupContentType =
  (typeof GROUP_CONTENT_TYPES)[keyof typeof GROUP_CONTENT_TYPES];

/** A discoverable invitation. Recipient may accept or ignore. */
export type WireInvite = {
  type: typeof GROUP_CONTENT_TYPES.INVITE;
  groupId: string;
  groupName: string;
  /** Hex pubkeys of all members at invite time (NOT including the recipient). */
  members: string[];
  inviter: string; // hex pubkey, for display
  /** UNIX seconds — for ordering races between invites. */
  ts: number;
};

/** Distribute a sender key to a group member at a specific epoch. */
export type WireSenderKey = {
  type: typeof GROUP_CONTENT_TYPES.SENDER_KEY;
  groupId: string;
  /** Epoch monotonic per (group, sender). Bumps on every rotation. */
  epoch: number;
  /** Hex of the sender chain seed. Recipient feeds this into newChainState. */
  chainSeedHex: string;
};

/** An actual group chat message, encrypted with the sender's chain key. */
export type WireGroupMessage = {
  type: typeof GROUP_CONTENT_TYPES.MESSAGE;
  groupId: string;
  /** Sender's epoch — receiver must use the matching sender-key state. */
  epoch: number;
  counter: number;
  nonceHex: string;
  ciphertextHex: string;
};

/** Sender announces they are leaving the group. */
export type WireLeave = {
  type: typeof GROUP_CONTENT_TYPES.LEAVE;
  groupId: string;
};

export type WireGroupContent =
  | WireInvite
  | WireSenderKey
  | WireGroupMessage
  | WireLeave;

// ---- Persisted (on-disk) shape ----

export type StoredSenderChain = {
  /** Hex-encoded 32-byte chain key. Mutates on every advance. */
  chainKeyHex: string;
  /** Next counter we'll assign (for own) or expect to derive (for peer). */
  counter: number;
  /** Hex-encoded skipped message keys, keyed by counter. */
  skippedHex: Record<string, string>;
};

export type StoredPeerSenderKey = {
  pubkey: string;
  epoch: number;
  chain: StoredSenderChain;
};

export type StoredGroup = {
  id: string;
  name: string;
  /** All members including ourselves, hex pubkeys, sorted for stable serialization. */
  members: string[];
  ownEpoch: number;
  ownChain: StoredSenderChain;
  peerKeys: Record<string /* pubkey */, StoredPeerSenderKey>;
  createdAt: number;
  /** Most-recent activity ts — used to surface fresh groups in /groups. */
  updatedAt: number;
};

export type StoredInvite = {
  groupId: string;
  groupName: string;
  members: string[];
  inviter: string;
  receivedAt: number;
  /** Underlying gift-wrap event id (used for dedup + display). */
  eventId: string;
};

export type StoredGroupBook = {
  version: 1;
  groups: StoredGroup[];
  pendingInvites: StoredInvite[];
};

// ---- Runtime convenience type returned by GroupStore ----

export type Group = {
  id: string;
  name: string;
  members: string[];
  ownEpoch: number;
  createdAt: number;
  updatedAt: number;
};
