import { Box, Text } from "ink";
import type { CommandSpec } from "./commandRegistry.js";

export type SuggestionsProps = {
  /** Filtered, prefix-matched command list. Empty → component renders nothing. */
  matches: CommandSpec[];
  /** Highlighted index inside `matches` (absolute, not windowed). */
  selectedIndex: number;
  /** Maximum rows to render before scrolling. */
  maxRows?: number;
};

/**
 * Floating suggestions list. Sits directly above the Input row.
 *
 * Scrolling: the visible window slides with the selection so the highlighted
 * item is always on-screen. We keep the selected row roughly mid-window
 * (above-and-below context) and clamp at the list edges.
 *
 * Each row is rendered as ONE outer <Text wrap="truncate-end"> so the row
 * truncates cleanly on narrow terminals instead of slicing per-segment.
 */
export function Suggestions({ matches, selectedIndex, maxRows = 7 }: SuggestionsProps) {
  if (matches.length === 0) return null;

  const { visible, offset } = windowedSlice(matches, selectedIndex, maxRows);
  const localHighlight = selectedIndex - offset;
  const hiddenAbove = offset;
  const hiddenBelow = matches.length - (offset + visible.length);

  // Compute alignment widths against the visible window so the layout doesn't
  // jitter as the user scrolls past long entries.
  const nameWidth = Math.max(...visible.map((c) => c.name.length));
  const syntaxWidth = Math.max(...visible.map((c) => c.syntax.length));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {hiddenAbove > 0 ? (
        <Text dimColor>{`  ↑ ${hiddenAbove} more above`}</Text>
      ) : null}
      {visible.map((cmd, i) => {
        const isSelected = i === localHighlight;
        return (
          <Text key={cmd.name} wrap="truncate-end">
            <Text color={isSelected ? "cyanBright" : "cyan"} bold={isSelected}>
              {isSelected ? "▸ " : "  "}
              {pad(cmd.name, nameWidth)}
            </Text>
            <Text>{"  "}</Text>
            <Text dimColor>{pad(cmd.syntax, syntaxWidth)}</Text>
            <Text>{"  "}</Text>
            <Text dimColor={!isSelected}>{cmd.description}</Text>
          </Text>
        );
      })}
      {hiddenBelow > 0 ? (
        <Text dimColor>{`  ↓ ${hiddenBelow} more below`}</Text>
      ) : null}
    </Box>
  );
}

/**
 * Slide a fixed-size window over `items` so the `selected` index stays
 * roughly mid-visible. Returns the visible slice plus the index offset.
 */
function windowedSlice<T>(
  items: T[],
  selected: number,
  size: number,
): { visible: T[]; offset: number } {
  if (items.length <= size) return { visible: items, offset: 0 };
  const half = Math.floor(size / 2);
  let start = Math.max(0, selected - half);
  let end = start + size;
  if (end > items.length) {
    end = items.length;
    start = end - size;
  }
  return { visible: items.slice(start, end), offset: start };
}

function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - s.length));
}
