import { Box, Text } from "ink";
import type { CommandSpec } from "./commandRegistry.js";

export type SuggestionsProps = {
  /** Filtered, prefix-matched command list. Empty → component renders nothing. */
  matches: CommandSpec[];
  /** Highlighted index inside `matches`. */
  selectedIndex: number;
  /** Maximum rows to render (truncated with a "+N more" indicator). */
  maxRows?: number;
};

/**
 * Floating suggestions list. Designed to sit directly above the Input row
 * so the visual grouping is obvious.
 *
 * Layout per row:
 *   [ ▸ ]  /command-name           syntax              one-line description
 *
 * Selected row: cyan background tint via inverse + bold name.
 */
export function Suggestions({ matches, selectedIndex, maxRows = 7 }: SuggestionsProps) {
  if (matches.length === 0) return null;

  const visible = matches.slice(0, maxRows);
  const hidden = matches.length - visible.length;

  // Compute column widths for alignment so descriptions don't jitter as the
  // user types and matches change.
  const nameWidth = Math.max(...visible.map((c) => c.name.length));
  const syntaxWidth = Math.max(...visible.map((c) => c.syntax.length));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {visible.map((cmd, i) => {
        const isSelected = i === selectedIndex;
        return (
          <Box key={cmd.name}>
            <Text color={isSelected ? "cyanBright" : "cyan"} bold={isSelected}>
              {isSelected ? "▸ " : "  "}
              {pad(cmd.name, nameWidth)}
            </Text>
            <Text>{"  "}</Text>
            <Text dimColor>{pad(cmd.syntax, syntaxWidth)}</Text>
            <Text>{"  "}</Text>
            <Text dimColor={!isSelected}>{cmd.description}</Text>
          </Box>
        );
      })}
      {hidden > 0 ? (
        <Box>
          <Text dimColor>  …{hidden} more — keep typing to narrow</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function pad(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - s.length));
}
