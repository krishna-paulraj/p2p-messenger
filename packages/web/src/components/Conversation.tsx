import { useEffect, useRef } from "react";
import { useApp } from "../store/app";
import type { StoredMessage } from "../db/store";
import { peerColorClass } from "../lib/colors";

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

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length, activePeer]);

  if (!activePeer) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-slate-500">
        <div className="max-w-sm text-center">
          <div className="mb-2 text-base font-semibold text-slate-200">
            select a contact
          </div>
          <div className="text-sm leading-relaxed text-slate-500">
            messages are end-to-end encrypted with NIP-44 + a Signal-style
            Double Ratchet. WebRTC P2P data channels available with{" "}
            <span className="text-slate-300">dial p2p</span> for low-latency
            messaging.
          </div>
        </div>
      </div>
    );
  }

  if (log.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-600">
        no messages yet — say hi to {peerContact?.alias ?? "this peer"}
      </div>
    );
  }

  // Group consecutive messages from the same sender.
  const groups: StoredMessage[][] = [];
  for (const m of log) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last[0].direction === m.direction &&
      m.ts - last[last.length - 1].ts < 5 * 60 // 5-min coalesce
    ) {
      last.push(m);
    } else {
      groups.push([m]);
    }
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4">
      <div className="mx-auto max-w-3xl space-y-4">
        {groups.map((group, gi) => {
          const isSelf = group[0].direction === "out";
          const senderName = isSelf
            ? identity?.alias ?? "you"
            : peerContact?.alias ?? "peer";
          const senderColor = isSelf ? "text-cyan-300" : peerColorClass(activePeer);
          return (
            <div
              key={gi}
              className={`flex flex-col ${isSelf ? "items-end" : "items-start"}`}
            >
              <div
                className={`mb-1 flex items-center gap-2 text-[11px] ${
                  isSelf ? "flex-row-reverse" : ""
                }`}
              >
                <span className={`font-semibold ${senderColor}`}>{senderName}</span>
                <span className="text-slate-600">
                  {fmtTime(group[group.length - 1].ts)}
                </span>
              </div>
              <div className="flex max-w-[80%] flex-col gap-1">
                {group.map((m, mi) => {
                  const isSystem = m.text.startsWith("[") && m.text.endsWith("]");
                  if (isSystem) {
                    return (
                      <div
                        key={mi}
                        className="self-center rounded-full border border-slate-800 bg-slate-900/60 px-3 py-0.5 text-[11px] text-slate-500"
                      >
                        {m.text.replace(/^\[|\]$/g, "")}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={mi}
                      className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm ${
                        isSelf
                          ? "bg-cyan-500/10 text-slate-100 ring-1 ring-cyan-500/30"
                          : "bg-slate-800/70 text-slate-100 ring-1 ring-slate-700/50"
                      }`}
                    >
                      {m.text}
                      {m.source === "relay" && (
                        <span className="ml-2 text-[10px] text-slate-500">
                          via relay
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
