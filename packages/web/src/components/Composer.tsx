import { useState, type SyntheticEvent, type KeyboardEvent } from "react";
import { useApp } from "../store/app";

export function Composer() {
  const activePeer = useApp((s) => s.activePeer);
  const contacts = useApp((s) => s.contacts);
  const send = useApp((s) => s.send);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const peerContact = activePeer
    ? Object.values(contacts).find((c) => c.pubkey === activePeer)
    : undefined;

  async function handleSubmit(e: SyntheticEvent) {
    e.preventDefault();
    if (!activePeer || !draft.trim() || sending) return;
    setSending(true);
    const text = draft.trim();
    setDraft("");
    try {
      await send(text);
    } catch (err) {
      console.error("send failed:", err);
      setDraft(text); // restore so user can retry
    } finally {
      setSending(false);
    }
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit(e);
    }
  }

  if (!activePeer) return null;

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-slate-800 bg-slate-900/40 px-6 py-3"
    >
      <div className="mb-1.5 text-[10px] uppercase tracking-wider text-slate-500">
        message {peerContact?.alias ?? "peer"}
      </div>
      <div className="flex gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          rows={1}
          placeholder="type a message and press Enter…"
          className="flex-1 resize-none rounded bg-slate-950 px-3 py-2 text-sm text-slate-100 ring-1 ring-slate-800 placeholder:text-slate-600 focus:outline-none focus:ring-cyan-500/50"
          autoFocus
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="rounded bg-cyan-500/20 px-4 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {sending ? "…" : "send"}
        </button>
      </div>
    </form>
  );
}
