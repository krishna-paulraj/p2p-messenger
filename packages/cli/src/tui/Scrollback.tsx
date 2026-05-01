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
        <Text color="gray">{time}</Text>
        <Text color="gray">{"  "}— </Text>
        <Text color="gray">{entry.text}</Text>
      </Text>
    );
  }

  if (entry.kind === "presence") {
    return (
      <Text>
        <Text color="gray">{time}</Text>
        <Text color="green">{"  "}● </Text>
        <Text color="gray">{entry.text}</Text>
      </Text>
    );
  }

  if (entry.kind === "error") {
    return (
      <Text>
        <Text color="gray">{time}</Text>
        <Text color="redBright">{"  ✗ "}</Text>
        <Text color="redBright">{entry.text}</Text>
      </Text>
    );
  }

  if (entry.kind === "group-event") {
    return (
      <Text>
        <Text color="gray">{time}</Text>
        <Text color="yellow">{"  ⚐ "}</Text>
        <Text color="yellow">{entry.text}</Text>
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
      <Text color="gray">{time}</Text>
      <Text>{"  "}</Text>
      <Text color={senderColor} bold={isSelf}>
        {pad(senderName, 12)}
      </Text>
      <Text color="white">{" "}</Text>
      <Text>{entry.text}</Text>
      {sourceTag ? <Text color="gray">{sourceTag}</Text> : null}
    </Text>
  );
}

function EmptyHint({ state, active }: { state: AppState; active?: ContextRef }) {
  if (!active || active.kind === "system") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="gray">Welcome, {state.alias}.</Text>
        <Text color="gray">
          Type a slash command to get started: <Text color="cyan">/help</Text>,{" "}
          <Text color="cyan">/contact list</Text>, <Text color="cyan">/whoami</Text>.
        </Text>
        <Text color="gray">
          Use <Text color="cyan">/dial &lt;peer&gt;</Text> to start a P2P connection or{" "}
          <Text color="cyan">/sendto &lt;peer&gt; &lt;msg&gt;</Text> for a relay-routed message.
        </Text>
      </Box>
    );
  }
  return (
    <Box paddingX={1}>
      <Text color="gray">(no messages yet — type to send)</Text>
    </Box>
  );
}

function pad(s: string, n: number): string {
  if (s.length >= n) return `${s.slice(0, n - 1)}…`;
  return s + " ".repeat(n - s.length);
}
