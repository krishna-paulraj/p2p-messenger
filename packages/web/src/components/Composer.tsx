import { useState, type SyntheticEvent, type KeyboardEvent } from "react";
import { useApp } from "../store/app";

export function Composer() {
  const activePeer = useApp((s) => s.activePeer);
  const send = useApp((s) => s.send);
  const p2pConnected = useApp((s) => s.p2pConnected);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const isP2P = activePeer ? p2pConnected.has(activePeer) : false;

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
      setDraft(text);
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
      className="border-t border-slate-800/80 bg-slate-900/30 px-5 py-3"
    >
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2">
          <div className="flex-1 rounded-2xl bg-slate-950 ring-1 ring-slate-800 transition focus-within:ring-cyan-500/40">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKey}
              rows={1}
              placeholder="message…"
              className="block w-full resize-none rounded-2xl bg-transparent px-3.5 py-2 text-sm leading-relaxed text-slate-100 placeholder:text-slate-600 focus:outline-none"
              autoFocus
            />
            <div className="flex items-center justify-between px-3 pb-1.5 pt-0">
              <span className="text-[10px] uppercase tracking-wider text-slate-600">
                {isP2P ? "via p2p · enter to send" : "via relay · enter to send"}
              </span>
              <span className="text-[10px] text-slate-700">
                {draft.length > 0 ? `${draft.length}` : ""}
              </span>
            </div>
          </div>
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            className="h-9 rounded-full bg-cyan-500/20 px-4 text-sm font-semibold text-cyan-200 transition hover:bg-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending ? "…" : "send"}
          </button>
        </div>
      </div>
    </form>
  );
}
