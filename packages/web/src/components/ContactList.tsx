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

  const [showAdd, setShowAdd] = useState(false);
  const [aliasInput, setAliasInput] = useState("");
  const [refInput, setRefInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const list = Object.values(contacts).sort((a, b) => a.alias.localeCompare(b.alias));

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
    <aside className="flex h-full w-72 flex-col border-r border-slate-800 bg-slate-900/40">
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          contacts
        </h2>
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="rounded bg-cyan-500/10 px-2 py-0.5 text-xs text-cyan-300 transition hover:bg-cyan-500/20"
        >
          {showAdd ? "× cancel" : "+ add"}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={handleAdd} className="space-y-2 border-b border-slate-800 p-3">
          <input
            value={aliasInput}
            onChange={(e) => setAliasInput(e.target.value)}
            placeholder="alias (e.g. bob)"
            className="w-full rounded bg-slate-950 px-2 py-1.5 text-sm text-slate-100 ring-1 ring-slate-800 focus:outline-none focus:ring-cyan-500/50"
            autoFocus
          />
          <input
            value={refInput}
            onChange={(e) => setRefInput(e.target.value)}
            placeholder="npub… or hex pubkey"
            className="w-full rounded bg-slate-950 px-2 py-1.5 text-xs text-slate-100 ring-1 ring-slate-800 focus:outline-none focus:ring-cyan-500/50"
          />
          {error && <div className="text-xs text-rose-400">{error}</div>}
          <button
            type="submit"
            className="w-full rounded bg-cyan-500/20 py-1.5 text-sm text-cyan-200 transition hover:bg-cyan-500/30"
          >
            add contact
          </button>
        </form>
      )}

      <div className="flex-1 overflow-y-auto">
        {list.length === 0 && !showAdd && (
          <div className="px-4 py-8 text-center text-xs text-slate-500">
            no contacts yet
            <br />
            add one to start chatting
          </div>
        )}
        {list.map((c) => {
          const recent = messages[c.pubkey];
          const lastMsg = recent && recent[recent.length - 1];
          const isActive = activePeer === c.pubkey;
          return (
            <button
              key={c.pubkey}
              onClick={() => setActive(c.pubkey)}
              className={`group flex w-full items-start gap-3 px-4 py-2.5 text-left transition ${
                isActive ? "bg-slate-800/80" : "hover:bg-slate-800/50"
              }`}
            >
              <div
                className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-800 ${peerColorClass(c.pubkey)} font-semibold`}
              >
                {c.alias.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className={`truncate text-sm font-medium ${isActive ? "text-slate-100" : "text-slate-200"}`}>
                    {c.alias}
                  </span>
                  {lastMsg && (
                    <span className="shrink-0 text-[10px] text-slate-500">
                      {new Date(lastMsg.ts * 1000).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
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
                className="opacity-0 group-hover:opacity-100 text-xs text-slate-500 hover:text-rose-400"
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
