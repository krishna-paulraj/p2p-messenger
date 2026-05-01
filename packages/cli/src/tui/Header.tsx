import { Box, Text } from "ink";
import type { AppState } from "./state.js";
import { shortPubkey } from "./colors.js";

export function Header({ state }: { state: AppState }) {
  const okRelays = state.relays.filter((r) => r.status === "ok").length;
  const total = state.relays.length;
  const npubShort = state.npub
    ? `${state.npub.slice(0, 12)}…${state.npub.slice(-4)}`
    : null;
  const pubkeyShort = state.selfPubkey ? shortPubkey(state.selfPubkey) : null;
  const relayBadge =
    total > 0 ? ` ● ${okRelays}/${total}` : "";

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box flexGrow={1}>
        <Text wrap="truncate-end">
          <Text color="cyanBright" bold>
            {state.alias}
          </Text>
          {npubShort ? (
            <Text dimColor>
              {"  "}
              {npubShort}
            </Text>
          ) : null}
          {pubkeyShort ? <Text dimColor>{"  "}({pubkeyShort})</Text> : null}
        </Text>
      </Box>
      <Text wrap="truncate-end">
        <Text dimColor>{state.signalDescription}</Text>
        {relayBadge ? (
          <Text color={okRelays === total ? "greenBright" : "yellowBright"}>
            {relayBadge}
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
