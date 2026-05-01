import { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";

const SLASH_COMMANDS = [
  "/help",
  "/whoami",
  "/contact list",
  "/contact add",
  "/contact rm",
  "/profile set",
  "/profile get",
  "/online",
  "/peers",
  "/dial",
  "/sendto",
  "/all",
  "/history",
  "/to",
  "/group create",
  "/group invite",
  "/group accept",
  "/group invites",
  "/group list",
  "/group focus",
  "/group members",
  "/group leave",
  "/group exit",
  "/win",
  "/quit",
];

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
};

export function Input({ label, completionAliases, onSubmit }: InputProps) {
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  /** Saved draft when user starts navigating history. */
  const [pendingDraft, setPendingDraft] = useState("");

  const completions = useMemo(
    () => [...SLASH_COMMANDS, ...completionAliases.map((a) => `@${a}`)],
    [completionAliases],
  );

  useInput((input, key) => {
    // Enter
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

    // Tab completion
    if (key.tab) {
      const match = completeToken(draft, cursor, completions);
      if (match) {
        setDraft(match.next);
        setCursor(match.cursor);
      }
      return;
    }

    // History navigation
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

    // Cursor
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

    // Backspace
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setDraft((d) => d.slice(0, cursor - 1) + d.slice(cursor));
      setCursor((c) => c - 1);
      return;
    }

    // Ctrl+U — clear line
    if (key.ctrl && input === "u") {
      setDraft("");
      setCursor(0);
      return;
    }

    // Ignore other control keys
    if (key.ctrl || key.meta) return;
    if (!input) return;

    // Normal text insertion
    setDraft((d) => d.slice(0, cursor) + input + d.slice(cursor));
    setCursor((c) => c + input.length);
  });

  // Render: prompt + text with a block cursor at `cursor` index.
  const before = draft.slice(0, cursor);
  const at = draft[cursor] ?? " ";
  const after = draft.slice(cursor + 1);

  return (
    <Box>
      <Text color="cyan">{label} </Text>
      <Text>{"› "}</Text>
      <Text>{before}</Text>
      <Text inverse>{at}</Text>
      <Text>{after}</Text>
    </Box>
  );
}

/**
 * Tab-complete the token under the cursor against the provided dictionary.
 * Slash-command tokens at position 0 match against the slash dictionary;
 * otherwise tokens prefixed with @ match against alias names. Returns null
 * if there's nothing to extend.
 */
function completeToken(
  text: string,
  cursor: number,
  completions: string[],
): { next: string; cursor: number } | null {
  // Find the start of the current token (preceding whitespace, or 0).
  let tokStart = cursor;
  while (tokStart > 0 && !/\s/.test(text[tokStart - 1])) tokStart -= 1;
  const tokenSoFar = text.slice(tokStart, cursor);
  if (!tokenSoFar) return null;

  // Slash commands match if the token is at the start AND begins with /.
  // Alias completions match if the token starts with @.
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
  // Find common prefix among candidates and extend the token to it.
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
