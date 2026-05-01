import { Box, Text } from "ink";
import type { ContextKind } from "./commandRegistry.js";
import { hintsFor } from "./commandRegistry.js";

export type HintsProps = {
  /** Active context kind — drives which command pile is surfaced. */
  context: ContextKind;
};

/**
 * Bottom one-liner showing context-specific commands and key bindings.
 *
 * Implementation note: the entire row is wrapped in a single <Text> with
 * wrap="truncate-end". Multiple sibling <Text> elements would each wrap
 * independently in ink and slice content mid-word on narrow terminals;
 * one outer Text guarantees the row stays on a single line and is cut
 * cleanly with an ellipsis if it doesn't fit.
 */
export function Hints({ context }: HintsProps) {
  const cmds = hintsFor(context).slice(0, 4);
  const cmdLine = cmds.map((c) => c.name).join("  ");
  return (
    <Box paddingX={1}>
      <Text wrap="truncate-end">
        <Text dimColor>hints  </Text>
        <Text color="cyanBright">{cmdLine}</Text>
        <Text dimColor>{"   ·   Tab/↑↓/^N^P"}</Text>
      </Text>
    </Box>
  );
}
