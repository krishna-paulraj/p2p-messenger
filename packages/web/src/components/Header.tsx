import { useState } from "react";
import { useApp } from "../store/app";
import { shortNpub } from "../lib/colors";
import { CopyButton } from "./CopyButton";
import { RelaysPanel } from "./RelaysPanel";
import { SettingsPanel } from "./SettingsPanel";

export function Header() {
  const identity = useApp((s) => s.identity);
  const relayOpen = useApp((s) => s.relayOpen);
  const relayTotal = useApp((s) => s.relayUrls.length);
  const [showRelays, setShowRelays] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const allRelaysOk = relayOpen === relayTotal && relayTotal > 0;

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-slate-800/80 bg-slate-900/60 px-4">
      <div className="flex items-center gap-2.5">
        <div className="relative flex h-2.5 w-2.5 shrink-0">
          <span
            className={`absolute inline-flex h-full w-full rounded-full ${
              allRelaysOk ? "animate-pulse bg-cyan-400" : "bg-slate-600"
            } opacity-60`}
          />
          <span
            className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
              allRelaysOk ? "bg-cyan-400" : "bg-slate-500"
            }`}
          />
        </div>
        <div className="text-sm font-semibold tracking-tight text-slate-100">
          p2p-messenger
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs">
        {identity && (
          <div className="hidden items-center gap-1.5 rounded-md bg-slate-800/60 px-2.5 py-1 ring-1 ring-slate-700/60 md:flex">
            <span className="text-slate-200">{identity.alias}</span>
            <span className="text-slate-600">·</span>
            <span className="font-mono text-[11px] text-slate-400">
              {shortNpub(identity.npub)}
            </span>
            <CopyButton value={identity.npub} label="copy npub" />
          </div>
        )}

        <button
          onClick={() => setShowRelays(true)}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-slate-400 transition hover:bg-slate-800/60 hover:text-slate-100"
          title="manage relays"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              allRelaysOk
                ? "bg-emerald-400"
                : relayOpen > 0
                  ? "bg-amber-400"
                  : "bg-slate-600"
            }`}
          />
          <span>
            {relayOpen}/{relayTotal}
          </span>
        </button>

        {identity && (
          <button
            onClick={() => setShowSettings(true)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-800/60 hover:text-slate-100"
            title="settings — view identity, copy nsec, reset"
            aria-label="settings"
          >
            ⚙
          </button>
        )}
      </div>
      {showRelays && <RelaysPanel onClose={() => setShowRelays(false)} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </header>
  );
}
