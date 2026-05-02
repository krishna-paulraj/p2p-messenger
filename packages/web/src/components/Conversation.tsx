import { useEffect, useRef } from "react";
import { useApp } from "../store/app";
import { formatTime, peerColorClass } from "../lib/colors";

export function Conversation() {
  const activePeer = useApp((s) => s.activePeer);
  const contacts = useApp((s) => s.contacts);
  const messages = useApp((s) => s.messages);
  const identity = useApp((s) => s.identity);
  const scrollRef = useRef<HTMLDivElement>(null);

  const log = activePeer ? messages[activePeer] ?? [] : [];
  const peerContact = activePeer
    ? Object.values(contacts).find((c) => c.pubkey === activePeer)
    : undefined;

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length, activePeer]);

  if (!activePeer) {
    return (
      <div className="flex flex-1 items-center justify-center text-slate-500">
        <div className="text-center">
          <div className="text-sm">select a contact to start chatting</div>
          <div className="mt-1 text-xs text-slate-600">
            messages are end-to-end encrypted with NIP-44 + Double Ratchet
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
      {log.length === 0 ? (
        <div className="flex h-full items-center justify-center text-slate-600 text-sm">
          (no messages yet — say hi to {peerContact?.alias ?? "this peer"})
        </div>
      ) : (
        <ul className="space-y-2">
          {log.map((m, i) => {
            const isSelf = m.direction === "out";
            const senderName = isSelf
              ? identity?.alias ?? "you"
              : peerContact?.alias ?? "peer";
            const senderColor = isSelf
              ? "text-cyan-300"
              : peerColorClass(activePeer);
            const sourceTag = m.source === "relay" ? "via relay" : "";
            return (
              <li key={i} className="leading-relaxed">
                <span className="text-[10px] text-slate-600">{formatTime(m.ts)}</span>
                <span className="mx-2"> </span>
                <span className={`text-xs font-semibold ${senderColor}`}>
                  {senderName}
                </span>
                <span className="ml-2 text-sm text-slate-100">{m.text}</span>
                {sourceTag && (
                  <span className="ml-2 text-[10px] text-slate-600">[{sourceTag}]</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
