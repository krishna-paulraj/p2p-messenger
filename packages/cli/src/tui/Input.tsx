import { useState, useMemo, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { Suggestions } from "./Suggestions.js";
import { COMMANDS, filterByPrefix, type CommandSpec } from "./commandRegistry.js";

/** Cap on simultaneously-visible suggestion rows. Anything more wastes screen and
 * pushes the input row off-screen on smaller terminals. */
const POPUP_MAX_ROWS = 5;

export type InputProps = {
  /** Display label inside the input bar (e.g. "→ alice" or "#trio"). */
  label: string;
  /**
   * Aliases the user may want to tab-complete (contact aliases, group names).
   * Whitespace-trimmed, deduplicated by the caller.
   */
  completionAliases: string[];
  /** Called when Enter pressed with non-empty trimmed text. */
  onSubmit: (text: string) => void;
  /**
   * Notifies the parent when the suggestion popup opens / closes — so the
   * parent can shrink the Scrollback row count and keep the input row from
   * being pushed off the bottom of the terminal.
   */
  onPopupChange?: (open: boolean, rows: number) => void;
};

/**
 * Detached input row with:
 *   - draft + cursor management
 *   - history recall via ↑↓ when no popup is visible
 *   - tab-completion via longest-common-prefix on slash commands and @aliases
 *   - slash-command suggestion popup (Claude-style) — when draft starts with
 *     "/", a list appears above; ↑↓ navigates IT, Tab/Enter accepts the
 *     selected suggestion, Esc dismisses. Only navigates history when popup
 *     is hidden.
 */
export function Input({ label, completionAliases, onSubmit, onPopupChange }: InputProps) {
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [pendingDraft, setPendingDraft] = useState("");

  // Suggestion popup state.
  const [suggestIdx, setSuggestIdx] = useState(0);
  /** True if the user explicitly dismissed the popup (Esc) for the current /token. */
  const [popupDismissed, setPopupDismissed] = useState(false);

  // Compute the current "slash token" — i.e. /text up to but not including the
  // first space. Suggestions only apply while the *first* token is /something.
  const slashToken = useMemo(() => {
    if (!draft.startsWith("/")) return null;
    const space = draft.indexOf(" ");
    return space === -1 ? draft : draft.slice(0, space);
  }, [draft]);

  // Filtered matches when popup is eligible.
  const matches: CommandSpec[] = useMemo(() => {
    if (!slashToken) return [];
    if (popupDismissed) return [];
    // After typing a space, hide popup — the user has committed to a command
    // and is now typing args.
    if (draft.includes(" ")) return [];
    return filterByPrefix(slashToken);
  }, [slashToken, popupDismissed, draft]);

  // Reset popup-dismissed when token changes.
  useEffect(() => {
    setPopupDismissed(false);
    setSuggestIdx(0);
  }, [slashToken]);

  // Clamp suggestIdx if matches shrink.
  useEffect(() => {
    if (suggestIdx >= matches.length) setSuggestIdx(Math.max(0, matches.length - 1));
  }, [matches, suggestIdx]);

  const popupVisible = matches.length > 0;
  /**
   * How many terminal rows the popup actually occupies when visible. Used by
   * the parent to shrink Scrollback so the input row stays on-screen.
   *   - top + bottom border: 2 rows
   *   - max visible matches:  POPUP_MAX_ROWS
   *   - "more above/below" indicator: 0..2 rows
   */
  const popupRows = useMemo(() => {
    if (!popupVisible) return 0;
    const visible = Math.min(matches.length, POPUP_MAX_ROWS);
    const hiddenAbove = Math.max(0, suggestIdx - Math.floor(POPUP_MAX_ROWS / 2)) > 0 ? 1 : 0;
    const hiddenBelow = matches.length > visible ? 1 : 0;
    return visible + 2 /* borders */ + hiddenAbove + hiddenBelow;
  }, [popupVisible, matches.length, suggestIdx]);

  // Notify parent on popup state changes so it can resize Scrollback.
  useEffect(() => {
    onPopupChange?.(popupVisible, popupRows);
  }, [popupVisible, popupRows, onPopupChange]);

  useInput((input, key) => {
    // ---- Suggestion popup specific keys (only when visible) ----
    if (popupVisible) {
      if (key.upArrow) {
        setSuggestIdx((i) => (i === 0 ? matches.length - 1 : i - 1));
        return;
      }
      if (key.downArrow) {
        setSuggestIdx((i) => (i === matches.length - 1 ? 0 : i + 1));
        return;
      }
      if (key.escape) {
        setPopupDismissed(true);
        return;
      }
      if (key.return || key.tab) {
        const chosen = matches[suggestIdx];
        if (chosen) {
          // Insert command name + trailing space if it takes args; otherwise
          // just the name.
          const replacement = chosen.takesArgs ? `${chosen.name} ` : chosen.name;
          setDraft(replacement);
          setCursor(replacement.length);
          setPopupDismissed(true);
        }
        return;
      }
      // Other keys fall through to normal text handling — the popup re-filters.
    }

    // ---- Enter: submit ----
    if (key.return) {
      const text = draft.trim();
      if (!text) return;
      setHistory((h) => (h[h.length - 1] === text ? h : [...h, text]));
      setHistoryIdx(null);
      setPendingDraft("");
      setDraft("");
      setCursor(0);
      onSubmit(text);
      return;
    }

    // ---- Tab: longest-common-prefix completion (when popup not active) ----
    if (key.tab) {
      const aliasCompletions = completionAliases.map((a) => `@${a}`);
      const dict = [...COMMANDS.map((c) => c.name), ...aliasCompletions];
      const match = completeToken(draft, cursor, dict);
      if (match) {
        setDraft(match.next);
        setCursor(match.cursor);
      }
      return;
    }

    // ---- History navigation: ↑↓ when popup hidden ----
    if (key.upArrow) {
      if (history.length === 0) return;
      const idx = historyIdx === null ? history.length - 1 : Math.max(0, historyIdx - 1);
      if (historyIdx === null) setPendingDraft(draft);
      setHistoryIdx(idx);
      setDraft(history[idx]);
      setCursor(history[idx].length);
      return;
    }
    if (key.downArrow) {
      if (historyIdx === null) return;
      const idx = historyIdx + 1;
      if (idx >= history.length) {
        setHistoryIdx(null);
        setDraft(pendingDraft);
        setCursor(pendingDraft.length);
      } else {
        setHistoryIdx(idx);
        setDraft(history[idx]);
        setCursor(history[idx].length);
      }
      return;
    }

    // ---- Cursor / line edit ----
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(draft.length, c + 1));
      return;
    }
    if (key.ctrl && input === "a") {
      setCursor(0);
      return;
    }
    if (key.ctrl && input === "e") {
      setCursor(draft.length);
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setDraft((d) => d.slice(0, cursor - 1) + d.slice(cursor));
      setCursor((c) => c - 1);
      return;
    }
    if (key.ctrl && input === "u") {
      setDraft("");
      setCursor(0);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (!input) return;

    // ---- Normal text insertion ----
    setDraft((d) => d.slice(0, cursor) + input + d.slice(cursor));
    setCursor((c) => c + input.length);
  });

  // Render
  const before = draft.slice(0, cursor);
  const at = draft[cursor] ?? " ";
  const after = draft.slice(cursor + 1);

  return (
    <Box flexDirection="column">
      {popupVisible ? (
        <Suggestions matches={matches} selectedIndex={suggestIdx} maxRows={POPUP_MAX_ROWS} />
      ) : null}
      <Box>
        <Text color="cyan">{label} </Text>
        <Text>{"› "}</Text>
        <Text>{before}</Text>
        <Text inverse>{at}</Text>
        <Text>{after}</Text>
      </Box>
    </Box>
  );
}

/**
 * Tab-complete the token under the cursor against a dictionary of known
 * tokens. Slash-command tokens at position 0 match against /-prefixed tokens;
 * aliases match against @-prefixed tokens.
 */
function completeToken(
  text: string,
  cursor: number,
  completions: string[],
): { next: string; cursor: number } | null {
  let tokStart = cursor;
  while (tokStart > 0 && !/\s/.test(text[tokStart - 1])) tokStart -= 1;
  const tokenSoFar = text.slice(tokStart, cursor);
  if (!tokenSoFar) return null;

  const candidates = completions.filter((c) => {
    if (tokenSoFar.startsWith("/")) return c.startsWith(tokenSoFar);
    if (tokenSoFar.startsWith("@")) return c.startsWith(tokenSoFar);
    return false;
  });

  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const replacement = candidates[0];
    const next = text.slice(0, tokStart) + replacement + text.slice(cursor);
    return { next, cursor: tokStart + replacement.length };
  }
  const prefix = commonPrefix(candidates);
  if (prefix.length > tokenSoFar.length) {
    const next = text.slice(0, tokStart) + prefix + text.slice(cursor);
    return { next, cursor: tokStart + prefix.length };
  }
  return null;
}

function commonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let p = strs[0];
  for (let i = 1; i < strs.length; i++) {
    while (!strs[i].startsWith(p)) {
      p = p.slice(0, -1);
      if (!p) return "";
    }
  }
  return p;
}
