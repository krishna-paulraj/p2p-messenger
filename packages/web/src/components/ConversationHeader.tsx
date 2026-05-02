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
    <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-slate-800/80 bg-slate-900/30 px-5">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={`avatar-gradient flex h-9 w-9 shrink-0 items-center justify-center rounded-full ring-1 ring-slate-700/80 ${peerColorClass(peer.pubkey)} text-sm font-semibold`}
        >
          {peer.alias.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-slate-100">
              {peer.alias}
            </span>
            {isP2P && (
              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-300 ring-1 ring-emerald-500/30">
                p2p
              </span>
            )}
            {!isP2P && isDialing && (
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-300 ring-1 ring-amber-500/30">
                dialing
              </span>
            )}
            {!isP2P && !isDialing && (
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-400 ring-1 ring-slate-700">
                relay
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <span className="truncate font-mono">{shortNpub(peer.npub)}</span>
            <CopyButton value={peer.npub} label="copy npub" />
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {isP2P ? (
          <button
            onClick={() => void hangup(activePeer)}
            className="rounded-md border border-slate-700 px-2.5 py-1 text-xs text-slate-300 transition hover:border-rose-400/60 hover:bg-rose-500/10 hover:text-rose-300"
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
            className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1 text-xs font-medium text-cyan-200 transition hover:border-cyan-400 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            title="open WebRTC P2P data channel for low-latency messaging"
          >
            {isDialing ? "dialing…" : "dial p2p"}
          </button>
        )}
      </div>
    </div>
  );
}
