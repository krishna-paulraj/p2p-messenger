import { useState, type SyntheticEvent } from "react";
import { useApp } from "../store/app";

export function LoginPanel() {
  const init = useApp((s) => s.init);
  const [alias, setAlias] = useState("");
  const [relays, setRelays] = useState("ws://localhost:7777");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: SyntheticEvent) {
    e.preventDefault();
    if (!alias.trim()) {
      setError("alias required");
      return;
    }
    setError(null);
    setWorking(true);
    try {
      const relayUrls = relays
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
      await init({ alias: alias.trim(), relayUrls });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-md space-y-5">
        <div className="text-center">
          <div className="text-2xl font-semibold text-slate-100">welcome</div>
          <div className="mt-2 text-sm text-slate-400">
            generates a fresh Nostr keypair stored in your browser. no servers, no accounts.
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wider text-slate-500">
              your alias
            </label>
            <input
              autoFocus
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="e.g. alice"
              className="w-full rounded bg-slate-900 px-3 py-2 text-slate-100 ring-1 ring-slate-800 focus:outline-none focus:ring-cyan-500/50"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wider text-slate-500">
              relays (comma-separated)
            </label>
            <input
              value={relays}
              onChange={(e) => setRelays(e.target.value)}
              className="w-full rounded bg-slate-900 px-3 py-2 text-xs text-slate-100 ring-1 ring-slate-800 focus:outline-none focus:ring-cyan-500/50"
            />
          </div>
          {error && <div className="text-sm text-rose-400">{error}</div>}
          <button
            type="submit"
            disabled={working}
            className="w-full rounded bg-cyan-500/20 py-2.5 font-medium text-cyan-200 transition hover:bg-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {working ? "generating keypair…" : "create identity & connect"}
          </button>
        </form>

        <div className="rounded border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-500">
          your secret key is stored only in this browser's IndexedDB. it never
          leaves the device. messages are end-to-end encrypted with NIP-44 + a
          Signal-style Double Ratchet.
        </div>
      </div>
    </div>
  );
}
