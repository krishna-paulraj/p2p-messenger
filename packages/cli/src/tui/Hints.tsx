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
 * Goal: discoverability — every screen surfaces 4-6 commands the user is
 * most likely to need, plus the global key bindings, without taking
 * meaningful screen real-estate from the chat itself.
 */
export function Hints({ context }: HintsProps) {
  const cmds = hintsFor(context);
  return (
    <Box paddingX={1}>
      <Text dimColor>hints: </Text>
      {cmds.map((c, i) => (
        <Text key={c.name}>
          <Text color="cyanBright">{c.name}</Text>
          {i < cmds.length - 1 ? <Text dimColor>{"  ·  "}</Text> : null}
        </Text>
      ))}
      <Text dimColor>{"   |   "}</Text>
      <Text dimColor>Tab </Text>
      <Text>complete</Text>
      <Text dimColor>{"  ↑↓ "}</Text>
      <Text>history</Text>
      <Text dimColor>{"  Ctrl+N/P "}</Text>
      <Text>window</Text>
    </Box>
  );
}
