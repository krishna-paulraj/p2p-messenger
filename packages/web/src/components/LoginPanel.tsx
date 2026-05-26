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
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center text-center">
          <div className="relative mb-4 h-16 w-16">
            <span className="absolute inset-0 rounded-full ring-2 ring-indigo-500/70" />
            <span className="absolute inset-2 rounded-full ring-2 ring-indigo-400/60" />
            <span className="absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-400" />
            <span className="absolute inset-0 rounded-full ring-2 ring-teal-400/50 animate-ripple-ping" />
          </div>
          <div className="text-3xl font-bold tracking-tight text-zinc-100">
            Ripple
          </div>
          <div className="mt-1 text-sm text-teal-300/90">
            messages, peer to peer
          </div>
          <div className="mt-4 max-w-sm text-sm leading-relaxed text-zinc-400">
            {mode === "create"
              ? "we'll generate a fresh Nostr keypair and keep it in this browser. no servers, no accounts."
              : "paste your existing Nostr private key to bring your identity along."}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1 rounded-full bg-ripple-surface p-1 text-xs ring-1 ring-ripple-border">
          <button
            onClick={() => setMode("create")}
            className={`rounded-full py-1.5 transition ${
              mode === "create"
                ? "bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-500/40"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            create new
          </button>
          <button
            onClick={() => setMode("import")}
            className={`rounded-full py-1.5 transition ${
              mode === "import"
                ? "bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-500/40"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            import existing
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wider text-ripple-muted">
              your alias
            </label>
            <input
              autoFocus
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="e.g. alice"
              className="w-full rounded-xl bg-ripple-surface px-3.5 py-2.5 text-zinc-100 ring-1 ring-ripple-border transition focus:outline-none focus:ring-indigo-500/60"
            />
          </div>

          {mode === "import" && (
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-ripple-muted">
                private key
              </label>
              <textarea
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="nsec1…   (or 64-char hex)"
                rows={2}
                className="w-full resize-none rounded-xl bg-ripple-surface px-3.5 py-2.5 font-mono text-xs text-zinc-100 ring-1 ring-ripple-border placeholder:text-ripple-muted-2 focus:outline-none focus:ring-indigo-500/60"
                spellCheck={false}
              />
              <div className="mt-1 text-[11px] text-ripple-muted">
                stored only in this browser's IndexedDB. it never leaves your device.
              </div>
            </div>
          )}

          {error && <div className="text-sm text-rose-400">{error}</div>}
          <button
            type="submit"
            disabled={working}
            className="w-full rounded-xl bg-indigo-500 py-2.5 font-medium text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
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

        <div className="rounded-xl border border-ripple-border bg-ripple-surface/40 p-3.5 text-xs leading-relaxed text-zinc-500">
          messages are end-to-end encrypted with NIP-44 + a Signal-style Double
          Ratchet. defaults to the public Nostr relays{" "}
          <code className="text-teal-300/90">relay.damus.io</code> and{" "}
          <code className="text-teal-300/90">nos.lol</code>; add or remove
          relays from the header after signing in.
        </div>
      </div>
    </div>
  );
}
