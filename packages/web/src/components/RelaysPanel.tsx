import { useState, type SyntheticEvent } from "react";
import { useApp } from "../store/app";

export type RelaysPanelProps = {
  onClose: () => void;
};

/**
 * Small popover for managing the relay set. Add new relay URLs (ws/wss),
 * remove existing ones. Persists to IndexedDB; the live messenger
 * connects/disconnects in real time so the badge updates within the next
 * status poll (≤ 3 s).
 */
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
        className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">relays</h3>
          <button
            onClick={onClose}
            className="text-slate-500 transition hover:text-slate-200"
            aria-label="close"
          >
            ×
          </button>
        </div>

        <ul className="mb-3 space-y-1 text-xs">
          {relays.length === 0 && (
            <li className="rounded bg-amber-500/10 px-2 py-1.5 text-amber-300">
              no relays configured — add one below to start receiving messages
            </li>
          )}
          {relays.map((url) => (
            <li
              key={url}
              className="flex items-center justify-between rounded bg-slate-950/60 px-2 py-1.5 ring-1 ring-slate-800"
            >
              <span className="truncate text-slate-300">{url}</span>
              <button
                onClick={() => {
                  if (confirm(`remove relay ${url}?`)) {
                    void removeRelay(url);
                  }
                }}
                className="ml-2 shrink-0 rounded text-slate-500 transition hover:text-rose-400"
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
            className="w-full rounded bg-slate-950 px-3 py-2 text-sm text-slate-100 ring-1 ring-slate-800 focus:outline-none focus:ring-cyan-500/50"
          />
          {error && <div className="text-xs text-rose-400">{error}</div>}
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            className="w-full rounded bg-cyan-500/20 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "connecting…" : "+ add relay"}
          </button>
        </form>

        <div className="mt-3 text-[11px] leading-relaxed text-slate-500">
          relay URLs must start with <code className="text-slate-300">ws://</code> or{" "}
          <code className="text-slate-300">wss://</code>. messages on each relay are
          encrypted end-to-end (NIP-44 + Double Ratchet); the relay only forwards
          opaque ciphertext.
        </div>
      </div>
    </div>
  );
}
