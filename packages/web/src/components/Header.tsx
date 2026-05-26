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
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-ripple-border bg-ripple-surface/70 px-4">
      <div className="flex items-center gap-2.5">
        <div className="relative h-7 w-7 shrink-0">
          <span className="absolute inset-0 rounded-full ring-2 ring-indigo-500/70" />
          <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-400" />
          {allRelaysOk && (
            <span className="absolute inset-0 rounded-full ring-2 ring-teal-400/60 animate-ripple-ping" />
          )}
        </div>
        <div className="text-[15px] font-semibold tracking-tight text-zinc-100">
          Ripple
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs">
        {identity && (
          <div className="hidden items-center gap-1.5 rounded-full bg-ripple-surface-2/60 px-3 py-1 ring-1 ring-ripple-border md:flex">
            <span className="text-zinc-200">{identity.alias}</span>
            <span className="text-ripple-muted-2">·</span>
            <span className="font-mono text-[10.5px] text-zinc-400">
              {shortNpub(identity.npub)}
            </span>
            <CopyButton value={identity.npub} label="copy npub" />
          </div>
        )}

        <button
          onClick={() => setShowRelays(true)}
          className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-zinc-400 transition hover:bg-ripple-surface-2/60 hover:text-zinc-100"
          title="manage relays"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              allRelaysOk
                ? "bg-teal-400"
                : relayOpen > 0
                  ? "bg-amber-400"
                  : "bg-ripple-muted-2"
            }`}
          />
          <span>
            {relayOpen}/{relayTotal}
          </span>
        </button>

        {identity && (
          <button
            onClick={() => setShowSettings(true)}
            className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-400 transition hover:bg-ripple-surface-2/60 hover:text-zinc-100"
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
