export { Peer, type PeerOptions, type SecureChannel } from "./peer.js";
export { initCrypto } from "./crypto.js";
export {
  type SignalingTransport,
  type SignalPayload,
  type IncomingSignal,
  type SignalHandler,
} from "./transport.js";
export { WebSocketSignaling, type WebSocketSignalingOptions } from "./signaling/ws.js";
export { NostrSignaling, type NostrSignalingOptions } from "./nostr/signaling.js";
export {
  RelayPool,
  type RelayUrl,
  type PublishOutcome,
  type SubscriptionHandle,
  type SubscribeOptions,
} from "./nostr/relay-pool.js";
export {
  loadOrCreateIdentity,
  decodePeerRef,
  pubkeyToNpub,
  dataDirFor,
  type Identity,
  type IdentityStoreOptions,
} from "./nostr/identity.js";
export { KINDS, PRESENCE_D_TAG } from "./nostr/kinds.js";
export { giftWrap, giftUnwrap, type Unwrapped } from "./nostr/gift-wrap.js";
export {
  publishProfile,
  fetchProfiles,
  type Profile,
} from "./nostr/profile.js";
export {
  PresencePublisher,
  PresenceWatcher,
  type PresenceSnapshot,
  type PresenceOptions,
} from "./nostr/presence.js";
export {
  ContactBook,
  resolvePeer,
  lookupNip05,
  type Contact,
} from "./nostr/contacts.js";
export {
  VectorClock,
  compareClocks,
  type Clock,
  type ClockOrder,
} from "./nostr/vector-clock.js";
export { DedupStore } from "./nostr/dedup.js";
export { loadClock, saveClock } from "./nostr/clock-store.js";
export {
  OfflineMessenger,
  type OfflineMessage,
  type OfflineMessengerOptions,
} from "./nostr/offline-queue.js";
export { RatchetStore } from "./nostr/ratchet/store.js";
export {
  initRatchet,
  encrypt as drEncrypt,
  decrypt as drDecrypt,
  serializeState as serializeRatchetState,
  deserializeState as deserializeRatchetState,
  type RatchetState,
  type Header as DrHeader,
  type SerializedState,
} from "./nostr/ratchet/double-ratchet.js";
export {
  FileTransferManager,
  type FileTransferOptions,
  type TransferEvent,
} from "./file/transfer.js";
export {
  FILE_CHUNK_SIZE,
  FILE_MAX_BYTES,
  FILE_CONTENT_TYPES,
  type WireManifest,
  type WireChunk,
  type WireFileFrame,
  type FileContentType,
} from "./file/types.js";
export type { IncomingFileFrame } from "./nostr/offline-queue.js";
export {
  Messenger,
  type IncomingMessage,
  type MessengerOptions,
  type MessengerSource,
  type SendResult,
} from "./messenger.js";
export { GroupStore } from "./nostr/group/group-store.js";
export {
  GroupMessenger,
  type GroupMessengerOptions,
  type IncomingGroupMessage,
  type IncomingInvite,
} from "./nostr/group/group-messenger.js";
export type { Group, StoredInvite } from "./nostr/group/types.js";
export { GROUP_CONTENT_TYPES } from "./nostr/group/types.js";
export { makeLogger, setLogLevel, type Logger } from "./util/logger.js";
