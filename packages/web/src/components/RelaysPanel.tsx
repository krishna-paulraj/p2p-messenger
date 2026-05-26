import { useState, type SyntheticEvent } from "react";
import { useApp } from "../store/app";

export type RelaysPanelProps = {
  onClose: () => void;
};

export function RelaysPanel({ onClose }: RelaysPanelProps) {
  const relays = useApp((s) => s.relayUrls);
  const addRelay = useApp((s) => s.addRelay);
  const removeRelay = useApp((s) => s.removeRelay);

  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleAdd(e: SyntheticEvent) {
    e.preventDefault();
    setError(null);
    if (!draft.trim()) return;
    setBusy(true);
    try {
      let url = draft.trim();
      if (!url.includes("://")) url = `wss://${url}`;
      await addRelay(url);
      setDraft("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-end bg-black/40 p-4 pt-16"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-ripple-border bg-ripple-surface p-5 shadow-2xl shadow-black/40"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-200">relays</h3>
          <button
            onClick={onClose}
            className="text-ripple-muted transition hover:text-zinc-200"
            aria-label="close"
          >
            ×
          </button>
        </div>

        <ul className="mb-3 space-y-1 text-xs">
          {relays.length === 0 && (
            <li className="rounded-xl bg-amber-500/10 px-3 py-2 text-amber-300">
              no relays configured — add one below to start receiving messages
            </li>
          )}
          {relays.map((url) => (
            <li
              key={url}
              className="flex items-center justify-between rounded-xl bg-ripple-bg/60 px-3 py-2 ring-1 ring-ripple-border"
            >
              <span className="truncate text-zinc-300">{url}</span>
              <button
                onClick={() => {
                  if (confirm(`remove relay ${url}?`)) {
                    void removeRelay(url);
                  }
                }}
                className="ml-2 shrink-0 rounded text-ripple-muted transition hover:text-rose-400"
                aria-label={`remove ${url}`}
              >
                remove
              </button>
            </li>
          ))}
        </ul>

        <form onSubmit={handleAdd} className="space-y-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="wss://relay.example or ws://localhost:7777"
            autoFocus
            className="w-full rounded-xl bg-ripple-bg px-3.5 py-2.5 text-sm text-zinc-100 ring-1 ring-ripple-border focus:outline-none focus:ring-indigo-500/60"
          />
          {error && <div className="text-xs text-rose-400">{error}</div>}
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className="w-full rounded-xl bg-indigo-500/15 py-2.5 text-sm font-medium text-indigo-200 ring-1 ring-indigo-500/30 transition hover:bg-indigo-500/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "connecting…" : "+ add relay"}
          </button>
        </form>

        <div className="mt-3 text-[11px] leading-relaxed text-ripple-muted">
          relay URLs must start with <code className="text-teal-300/90">ws://</code> or{" "}
          <code className="text-teal-300/90">wss://</code>. messages on each relay are
          encrypted end-to-end (NIP-44 + Double Ratchet); the relay only forwards
          opaque ciphertext.
        </div>
      </div>
    </div>
  );
}
