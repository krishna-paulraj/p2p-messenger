import { useState, type SyntheticEvent } from "react";
import { useApp } from "../store/app";
import { peerColorClass, shortNpub } from "../lib/colors";

export function ContactList() {
  const contacts = useApp((s) => s.contacts);
  const activePeer = useApp((s) => s.activePeer);
  const setActive = useApp((s) => s.setActivePeer);
  const messages = useApp((s) => s.messages);
  const addContact = useApp((s) => s.addContact);
  const removeContact = useApp((s) => s.removeContact);
  const p2pConnected = useApp((s) => s.p2pConnected);
  const p2pDialing = useApp((s) => s.p2pDialing);

  const [showAdd, setShowAdd] = useState(false);
  const [aliasInput, setAliasInput] = useState("");
  const [refInput, setRefInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const list = Object.values(contacts).sort((a, b) => {
    // Recently-active conversations first, then alphabetical fallback.
    const aLast = messages[a.pubkey]?.[messages[a.pubkey].length - 1]?.ts ?? 0;
    const bLast = messages[b.pubkey]?.[messages[b.pubkey].length - 1]?.ts ?? 0;
    if (aLast !== bLast) return bLast - aLast;
    return a.alias.localeCompare(b.alias);
  });

  async function handleAdd(e: SyntheticEvent) {
    e.preventDefault();
    setError(null);
    if (!aliasInput.trim() || !refInput.trim()) {
      setError("alias and npub/hex required");
      return;
    }
    try {
      await addContact(aliasInput.trim(), refInput.trim());
      setAliasInput("");
      setRefInput("");
      setShowAdd(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-slate-800/80 bg-slate-900/30">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-slate-800/80 px-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
          contacts
        </h2>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="rounded-md bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300 transition hover:bg-cyan-500/20"
        >
          {showAdd ? "× cancel" : "+ add"}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleAdd} className="space-y-2 border-b border-slate-800/80 p-3">
          <input
            value={aliasInput}
            onChange={(e) => setAliasInput(e.target.value)}
            placeholder="alias (e.g. bob)"
            className="w-full rounded-md bg-slate-950 px-2.5 py-1.5 text-sm text-slate-100 ring-1 ring-slate-800 placeholder:text-slate-600 focus:outline-none focus:ring-cyan-500/50"
            autoFocus
          />
          <input
            value={refInput}
            onChange={(e) => setRefInput(e.target.value)}
            placeholder="npub… or hex pubkey"
            className="w-full rounded-md bg-slate-950 px-2.5 py-1.5 font-mono text-[11px] text-slate-100 ring-1 ring-slate-800 placeholder:text-slate-600 focus:outline-none focus:ring-cyan-500/50"
          />
          {error && <div className="text-xs text-rose-400">{error}</div>}
          <button
            type="submit"
            className="w-full rounded-md bg-cyan-500/15 py-1.5 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/25"
          >
            add contact
          </button>
        </form>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {list.length === 0 && !showAdd && (
          <div className="px-4 py-8 text-center text-xs leading-relaxed text-slate-500">
            no contacts yet
            <br />
            click <span className="text-slate-300">+ add</span> above to start
          </div>
        )}
        {list.map((c) => {
          const recent = messages[c.pubkey];
          const lastMsg = recent && recent[recent.length - 1];
          const isActive = activePeer === c.pubkey;
          const isP2P = p2pConnected.has(c.pubkey);
          const isDialing = p2pDialing.has(c.pubkey);
          return (
            <button
              key={c.pubkey}
              onClick={() => setActive(c.pubkey)}
              className={`group relative flex w-full items-center gap-3 px-3 py-2 text-left transition ${
                isActive
                  ? "bg-slate-800/70"
                  : "hover:bg-slate-800/40"
              }`}
            >
              {/* active peer indicator stripe on the left */}
              {isActive && (
                <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-cyan-400" />
              )}

              <div className="relative shrink-0">
                <div
                  className={`avatar-gradient flex h-9 w-9 items-center justify-center rounded-full ring-1 ring-slate-700/80 ${peerColorClass(c.pubkey)} text-sm font-semibold`}
                >
                  {c.alias.slice(0, 1).toUpperCase()}
                </div>
                {/* Connection dot at lower-right of avatar */}
                {isP2P && (
                  <span
                    className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 ring-2 ring-slate-900"
                    title="P2P connected"
                  />
                )}
                {!isP2P && isDialing && (
                  <span
                    className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-amber-400 ring-2 ring-slate-900"
                    title="dialing…"
                  />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`truncate text-sm font-medium ${
                      isActive ? "text-slate-100" : "text-slate-200"
                    }`}
                  >
                    {c.alias}
                  </span>
                  {lastMsg && (
                    <span className="shrink-0 text-[10px] text-slate-600">
                      {fmtTimeShort(lastMsg.ts)}
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-slate-500">
                  {lastMsg?.text ?? shortNpub(c.npub)}
                </div>
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`remove ${c.alias}?`)) void removeContact(c.alias);
                }}
                className="shrink-0 rounded text-xs text-slate-600 opacity-0 transition group-hover:opacity-100 hover:text-rose-400"
                aria-label={`remove ${c.alias}`}
              >
                ×
              </button>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function fmtTimeShort(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
