import { Box, Text } from "ink";
import type { AppState, ContextRef, LogEntry } from "./state.js";
import { sameContext } from "./state.js";
import { colorFor, timeFmt } from "./colors.js";

export function Scrollback({
  state,
  visibleRows,
}: {
  state: AppState;
  visibleRows: number;
}) {
  const visible = state.log.filter((e) => sameContext(e.context, state.active));
  // Tail: only render what fits — ink doesn't scroll, so the bottom N lines.
  const tail = visible.slice(-visibleRows);

  if (tail.length === 0) {
    return (
      <Box flexGrow={1} flexDirection="column">
        <EmptyHint state={state} active={state.active} />
      </Box>
    );
  }

  return (
    <Box flexGrow={1} flexDirection="column">
      {tail.map((entry) => (
        <LogLine key={entry.id} entry={entry} alias={state.alias} />
      ))}
    </Box>
  );
}

function LogLine({ entry, alias }: { entry: LogEntry; alias: string }) {
  const time = timeFmt(entry.ts);

  if (entry.kind === "system") {
    return (
      <Text>
        <Text dimColor>{time}</Text>
        <Text dimColor>{"  — "}</Text>
        <Text>{entry.text}</Text>
      </Text>
    );
  }

  if (entry.kind === "presence") {
    return (
      <Text>
        <Text dimColor>{time}</Text>
        <Text color="greenBright">{"  ● "}</Text>
        <Text>{entry.text}</Text>
      </Text>
    );
  }

  if (entry.kind === "error") {
    return (
      <Text>
        <Text dimColor>{time}</Text>
        <Text color="redBright">{"  ✗ "}</Text>
        <Text color="redBright">{entry.text}</Text>
      </Text>
    );
  }

  if (entry.kind === "group-event") {
    return (
      <Text>
        <Text dimColor>{time}</Text>
        <Text color="yellowBright">{"  ⚐ "}</Text>
        <Text color="yellowBright">{entry.text}</Text>
      </Text>
    );
  }

  // Chat lines: self / peer (with optional source tag for relay-delivered)
  const isSelf = entry.kind === "self" || entry.kind === "group-self";
  const senderName = entry.sender ?? (isSelf ? alias : "?");
  const senderColor = isSelf ? "cyanBright" : colorFor(senderName);
  const sourceTag =
    entry.source === "offline"
      ? entry.fromDrain
        ? " [drained]"
        : " [relay]"
      : "";

  return (
    <Text>
      <Text dimColor>{time}</Text>
      <Text>{"  "}</Text>
      <Text color={senderColor} bold={isSelf}>
        {pad(senderName, 12)}
      </Text>
      <Text>{" "}</Text>
      <Text>{entry.text}</Text>
      {sourceTag ? <Text dimColor>{sourceTag}</Text> : null}
    </Text>
  );
}

function EmptyHint({ state, active }: { state: AppState; active?: ContextRef }) {
  if (!active || active.kind === "system") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>Welcome, {state.alias}.</Text>
        <Text>
          Type a slash command to get started:{" "}
          <Text color="cyanBright">/help</Text>,{" "}
          <Text color="cyanBright">/contact list</Text>,{" "}
          <Text color="cyanBright">/whoami</Text>.
        </Text>
        <Text dimColor>
          Use /dial &lt;peer&gt; for a P2P connection or /sendto &lt;peer&gt; &lt;msg&gt; via relay.
        </Text>
      </Box>
    );
  }
  return (
    <Box paddingX={1}>
      <Text dimColor>(no messages yet — type to send)</Text>
    </Box>
  );
}

function pad(s: string, n: number): string {
  if (s.length >= n) return `${s.slice(0, n - 1)}…`;
  return s + " ".repeat(n - s.length);
}
