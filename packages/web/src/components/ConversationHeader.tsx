import { useApp } from "../store/app";
import { peerColorClass, shortNpub } from "../lib/colors";
import { CopyButton } from "./CopyButton";

export function ConversationHeader() {
  const activePeer = useApp((s) => s.activePeer);
  const contacts = useApp((s) => s.contacts);
  const p2pConnected = useApp((s) => s.p2pConnected);
  const p2pDialing = useApp((s) => s.p2pDialing);
  const dial = useApp((s) => s.dial);
  const hangup = useApp((s) => s.hangup);

  if (!activePeer) return null;
  const peer = Object.values(contacts).find((c) => c.pubkey === activePeer);
  if (!peer) return null;

  const isP2P = p2pConnected.has(activePeer);
  const isDialing = p2pDialing.has(activePeer);

  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-ripple-border bg-ripple-surface/30 px-5">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={`avatar-gradient flex h-9 w-9 shrink-0 items-center justify-center rounded-full ring-1 ring-ripple-border-strong ${peerColorClass(peer.pubkey)} text-sm font-semibold`}
        >
          {peer.alias.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-zinc-100">
              {peer.alias}
            </span>
            {isP2P && (
              <span className="rounded-full bg-teal-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-teal-300 ring-1 ring-teal-500/30">
                p2p
              </span>
            )}
            {!isP2P && isDialing && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-300 ring-1 ring-amber-500/30">
                dialing
              </span>
            )}
            {!isP2P && !isDialing && (
              <span className="rounded-full bg-ripple-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ripple-muted ring-1 ring-ripple-border">
                relay
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-ripple-muted">
            <span className="truncate font-mono">{shortNpub(peer.npub)}</span>
            <CopyButton value={peer.npub} label="copy npub" />
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {isP2P ? (
          <button
            onClick={() => void hangup(activePeer)}
            className="rounded-full border border-ripple-border px-3 py-1 text-xs text-zinc-300 transition hover:border-rose-400/60 hover:bg-rose-500/10 hover:text-rose-300"
            title="close P2P connection (messages fall back to relay)"
          >
            hang up
          </button>
        ) : (
          <button
            onClick={() => {
              void dial(activePeer).catch((err) => {
                console.error("dial failed:", err);
                alert(`dial failed: ${(err as Error).message}`);
              });
            }}
            disabled={isDialing}
            className="rounded-full bg-indigo-500/15 px-3 py-1 text-xs font-medium text-indigo-200 ring-1 ring-indigo-500/40 transition hover:bg-indigo-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            title="open WebRTC P2P data channel for low-latency messaging"
          >
            {isDialing ? "dialing…" : "dial p2p"}
          </button>
        )}
      </div>
    </div>
  );
}
