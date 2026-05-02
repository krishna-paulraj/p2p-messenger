import { useApp } from "../store/app";
import { shortNpub, shortPubkey } from "../lib/colors";

export function Header() {
  const identity = useApp((s) => s.identity);
  const relayOpen = useApp((s) => s.relayOpen);
  const relayTotal = useApp((s) => s.relayUrls.length);
  const reset = useApp((s) => s.resetIdentity);

  const allRelaysOk = relayOpen === relayTotal && relayTotal > 0;

  return (
    <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900/60 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="h-2.5 w-2.5 rounded-full bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.5)]" />
        <div className="text-base font-semibold tracking-tight text-slate-100">
          p2p-messenger
        </div>
      </div>
      <div className="flex items-center gap-4 text-xs text-slate-400">
        {identity && (
          <>
            <div>
              <span className="text-slate-500">alias</span>{" "}
              <span className="text-slate-200">{identity.alias}</span>
            </div>
            <div className="hidden md:block">
              <span className="text-slate-500">npub</span>{" "}
              <span className="text-slate-300">{shortNpub(identity.npub)}</span>
            </div>
            <div className="hidden lg:block text-slate-500">
              ({shortPubkey(identity.publicKey)})
            </div>
          </>
        )}
        <div className="flex items-center gap-1.5">
          <span
            className={`h-2 w-2 rounded-full ${
              allRelaysOk ? "bg-emerald-400" : relayOpen > 0 ? "bg-amber-400" : "bg-slate-600"
            }`}
          />
          <span className="text-slate-400">
            {relayOpen}/{relayTotal} relays
          </span>
        </div>
        {identity && (
          <button
            onClick={() => {
              if (confirm("Reset identity? This deletes your local keys + history.")) {
                void reset();
              }
            }}
            className="rounded border border-slate-700 px-2 py-1 text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
          >
            reset
          </button>
        )}
      </div>
    </header>
  );
}
