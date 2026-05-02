import { useState } from "react";

export type CopyButtonProps = {
  /** The value to copy to clipboard. */
  value: string;
  /** Accessible label / tooltip — defaults to "copy". */
  label?: string;
  /** Extra class names for layout tweaks. */
  className?: string;
};

/**
 * Tiny inline copy-to-clipboard button. Shows a check on success, falls back
 * to a manual selection prompt if `navigator.clipboard` is unavailable
 * (e.g. http:// origins where the Clipboard API is gated).
 */
export function CopyButton({ value, label = "copy", className }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "ok" | "err">("idle");

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        // Fallback for non-secure contexts (file://, http:// without TLS):
        // create a temporary textarea, select it, exec copy.
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.left = "-1000px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setState("ok");
      setTimeout(() => setState("idle"), 1200);
    } catch {
      setState("err");
      setTimeout(() => setState("idle"), 1500);
    }
  }

  const glyph = state === "ok" ? "✓" : state === "err" ? "✗" : "⎘";
  const colorClass =
    state === "ok"
      ? "text-emerald-400"
      : state === "err"
        ? "text-rose-400"
        : "text-slate-500 hover:text-slate-200";

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void copy();
      }}
      title={state === "ok" ? "copied!" : state === "err" ? "copy failed" : label}
      aria-label={label}
      className={`inline-flex h-5 w-5 items-center justify-center rounded text-xs transition ${colorClass} ${className ?? ""}`}
    >
      {glyph}
    </button>
  );
}
