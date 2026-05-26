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
      className="border-t border-ripple-border bg-ripple-surface/30 px-5 py-3"
    >
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2">
          <div className="flex-1 rounded-3xl bg-ripple-bg ring-1 ring-ripple-border transition focus-within:ring-indigo-500/50">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKey}
              rows={1}
              placeholder="message…"
              className="block w-full resize-none rounded-3xl bg-transparent px-4 py-2.5 text-sm leading-relaxed text-zinc-100 placeholder:text-ripple-muted-2 focus:outline-none"
              autoFocus
            />
            <div className="flex items-center justify-between px-4 pb-1.5 pt-0">
              <span className="text-[10px] uppercase tracking-wider text-ripple-muted-2">
                {isP2P ? "via p2p · enter to send" : "via relay · enter to send"}
              </span>
              <span className="text-[10px] text-ripple-muted-2">
                {draft.length > 0 ? `${draft.length}` : ""}
              </span>
            </div>
          </div>
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            className="h-10 rounded-full bg-indigo-500 px-5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            {sending ? "…" : "send"}
          </button>
        </div>
      </div>
    </form>
  );
}
