import { useState, type SyntheticEvent } from "react";
import { useApp } from "../store/app";

type Mode = "create" | "import";

export function LoginPanel() {
  const init = useApp((s) => s.init);
  const [mode, setMode] = useState<Mode>("create");
  const [alias, setAlias] = useState("");
  const [secret, setSecret] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: SyntheticEvent) {
    e.preventDefault();
    setError(null);
    if (!alias.trim()) {
      setError("alias required");
      return;
    }
    if (mode === "import" && !secret.trim()) {
      setError("paste your nsec1… or 64-char hex secret to import");
      return;
    }
    setWorking(true);
    try {
      if (mode === "import") {
        await init({ alias: alias.trim(), importSecret: secret.trim() });
      } else {
        await init({ alias: alias.trim() });
      }
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
            {mode === "create"
              ? "generates a fresh Nostr keypair stored in your browser. no servers, no accounts."
              : "import an existing Nostr identity by pasting your private key."}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1 rounded bg-slate-900 p-1 text-xs">
          <button
            onClick={() => setMode("create")}
            className={`rounded py-1.5 transition ${
              mode === "create"
                ? "bg-cyan-500/20 text-cyan-200"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            create new
          </button>
          <button
            onClick={() => setMode("import")}
            className={`rounded py-1.5 transition ${
              mode === "import"
                ? "bg-cyan-500/20 text-cyan-200"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            import existing
          </button>
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

          {mode === "import" && (
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-slate-500">
                private key
              </label>
              <textarea
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="nsec1…   (or 64-char hex)"
                rows={2}
                className="w-full resize-none rounded bg-slate-900 px-3 py-2 font-mono text-xs text-slate-100 ring-1 ring-slate-800 placeholder:text-slate-600 focus:outline-none focus:ring-cyan-500/50"
                spellCheck={false}
              />
              <div className="mt-1 text-[11px] text-slate-500">
                stored only in this browser's IndexedDB. it never leaves your device.
              </div>
            </div>
          )}

          {error && <div className="text-sm text-rose-400">{error}</div>}
          <button
            type="submit"
            disabled={working}
            className="w-full rounded bg-cyan-500/20 py-2.5 font-medium text-cyan-200 transition hover:bg-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {working
              ? mode === "import"
                ? "importing…"
                : "generating keypair…"
              : mode === "import"
                ? "import & connect"
                : "create identity & connect"}
          </button>
        </form>

        <div className="rounded border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-500">
          messages are end-to-end encrypted with NIP-44 + a Signal-style Double
          Ratchet. defaults to the public Nostr relays{" "}
          <code className="text-slate-300">relay.damus.io</code> and{" "}
          <code className="text-slate-300">nos.lol</code>; you can add or remove
          relays from the header after signing in.
        </div>
      </div>
    </div>
  );
}
