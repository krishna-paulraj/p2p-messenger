import { useState } from "react";
import { useApp } from "../store/app";
import { shortNpub, shortPubkey } from "../lib/colors";
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
            <div className="flex items-center gap-1.5">
              <span className="text-slate-500">alias</span>
              <span className="text-slate-200">{identity.alias}</span>
              <CopyButton value={identity.alias} label="copy alias" />
            </div>
            <div className="hidden items-center gap-1.5 md:flex">
              <span className="text-slate-500">npub</span>
              <span className="text-slate-300">{shortNpub(identity.npub)}</span>
              <CopyButton value={identity.npub} label="copy npub" />
            </div>
            <div className="hidden items-center gap-1.5 text-slate-500 lg:flex">
              ({shortPubkey(identity.publicKey)})
              <CopyButton value={identity.publicKey} label="copy hex pubkey" />
            </div>
          </>
        )}
        <button
          onClick={() => setShowRelays(true)}
          className="group flex items-center gap-1.5 rounded px-2 py-1 transition hover:bg-slate-800/60"
          title="manage relays"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              allRelaysOk ? "bg-emerald-400" : relayOpen > 0 ? "bg-amber-400" : "bg-slate-600"
            }`}
          />
          <span className="text-slate-400 group-hover:text-slate-200">
            {relayOpen}/{relayTotal} relays
          </span>
          <span className="text-slate-600 group-hover:text-slate-300">+</span>
        </button>
        {identity && (
          <button
            onClick={() => setShowSettings(true)}
            className="rounded border border-slate-700 px-2 py-1 text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
            title="settings — view identity, copy nsec, reset"
          >
            settings
          </button>
        )}
      </div>
      {showRelays && <RelaysPanel onClose={() => setShowRelays(false)} />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </header>
  );
}
