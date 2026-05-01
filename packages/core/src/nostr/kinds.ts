/**
 * Nostr event kinds we use. NIP-numbers in comments where applicable.
 */
export const KINDS = {
  /** NIP-01 — profile metadata */
  PROFILE: 0,
  /** NIP-17 — chat message (gift-wrapped) */
  CHAT_MESSAGE: 14,
  /** NIP-59 — seal */
  SEAL: 13,
  /** NIP-59 — gift wrap */
  GIFT_WRAP: 1059,
  /**
   * Application-defined inner kind for WebRTC signaling payloads carried inside
   * a NIP-59 gift wrap. Not a registered kind; we use 21059 (privately picked,
   * outside any NIP namespace, > 10000 so it's regular not parameterized).
   */
  P2P_SIGNAL: 21059,
  /**
   * Parameterized replaceable event for our presence heartbeat.
   * 30000-39999 is the NIP-01 PRE range.
   */
  P2P_PRESENCE: 30078,
  /**
   * Application-defined inner kind for group control + data. The actual
   * payload type (invite, sender-key share, group message, leave) is
   * discriminated by a `type` field inside the JSON content. Sharing one
   * inner kind keeps subscription overhead constant regardless of how many
   * group operation types we add later.
   */
  P2P_GROUP: 25001,
} as const;

/** Stable d-tag identifier for our presence event. */
export const PRESENCE_D_TAG = "p2p-messenger:presence:v1";
