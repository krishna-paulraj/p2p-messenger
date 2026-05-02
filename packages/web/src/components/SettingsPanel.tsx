import { useMemo, useState } from "react";
import { bytesToHex } from "@noble/hashes/utils";
import { useApp } from "../store/app";
import { nsecFor } from "../protocol/identity";
import { CopyButton } from "./CopyButton";

export type SettingsPanelProps = {
  onClose: () => void;
};

/**
 * Identity settings popover. Shows the public-side identity always; the
 * private-side (nsec / hex secret) is hidden behind an explicit reveal
 * toggle so it doesn't leak via a casual screenshot.
 *
 * The nsec value is computed from the in-memory secret only when the user
 * explicitly clicks "show". It never enters the DOM until then.
 */
export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const identity = useApp((s) => s.identity);
  const reset = useApp((s) => s.resetIdentity);
  const [revealed, setRevealed] = useState(false);

  const nsec = useMemo(
    () => (revealed && identity ? nsecFor(identity.secretKey) : ""),
    [revealed, identity],
  );
  const hexSecret = useMemo(
    () => (revealed && identity ? bytesToHex(identity.secretKey) : ""),
    [revealed, identity],
  );

  if (!identity) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-end bg-black/40 p-4 pt-16"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">settings</h3>
          <button
            onClick={onClose}
            className="text-slate-500 transition hover:text-slate-200"
            aria-label="close"
          >
            ×
          </button>
        </div>

        {/* Public identity — always visible */}
        <section className="mb-5 space-y-2">
          <h4 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            public identity
          </h4>
          <Field label="alias" value={identity.alias} />
          <Field label="npub" value={identity.npub} mono />
          <Field label="hex pubkey" value={identity.publicKey} mono />
        </section>

        {/* Private identity — gated behind reveal */}
        <section className="mb-5 space-y-2">
          <h4 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            private key
          </h4>
          <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-200">
            anyone with this key can impersonate you and read your future
            messages. paste it on a second device to use the same identity.
            don't share it; treat it like a password.
          </div>

          {!revealed ? (
            <button
              onClick={() => setRevealed(true)}
              className="w-full rounded border border-slate-700 bg-slate-950 py-2 text-sm text-slate-300 transition hover:border-slate-500 hover:text-slate-100"
            >
              show secret key
            </button>
          ) : (
            <>
              <Field label="nsec" value={nsec} mono />
              <Field label="hex secret" value={hexSecret} mono />
              <button
                onClick={() => setRevealed(false)}
                className="w-full rounded border border-slate-700 py-1.5 text-xs text-slate-400 transition hover:border-slate-500 hover:text-slate-200"
              >
                hide
              </button>
            </>
          )}
        </section>

        <section className="space-y-2">
          <h4 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            danger zone
          </h4>
          <button
            onClick={() => {
              if (
                confirm(
                  "Reset identity?\n\nThis deletes your local keys, contacts, and history. The action is irreversible — back up your nsec first if you want to use this identity again.",
                )
              ) {
                void reset();
                onClose();
              }
            }}
            className="w-full rounded border border-rose-500/40 bg-rose-500/10 py-2 text-sm text-rose-300 transition hover:border-rose-400 hover:bg-rose-500/20"
          >
            reset identity
          </button>
        </section>
      </div>
    </div>
  );
}

type FieldProps = {
  label: string;
  value: string;
  mono?: boolean;
};

function Field({ label, value, mono }: FieldProps) {
  return (
    <div className="rounded bg-slate-950/60 px-3 py-2 ring-1 ring-slate-800">
      <div className="mb-0.5 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
        <CopyButton value={value} label={`copy ${label}`} />
      </div>
      <div
        className={`break-all text-xs text-slate-200 ${mono ? "font-mono" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}
