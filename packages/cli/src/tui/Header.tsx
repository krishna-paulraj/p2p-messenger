import { Box, Text } from "ink";
import type { AppState } from "./state.js";
import { shortPubkey } from "./colors.js";

/**
 * Top header bar. Two halves separated by `justifyContent="space-between"`,
 * both wrapped in <Text wrap="truncate-end"> so neither half can spill into
 * the other on a narrow terminal. The outer Box stretches to the parent
 * column-flex's width, giving the space-between something to push against.
 */
export function Header({ state }: { state: AppState }) {
  const okRelays = state.relays.filter((r) => r.status === "ok").length;
  const total = state.relays.length;
  const npubShort = state.npub
    ? `${state.npub.slice(0, 12)}…${state.npub.slice(-4)}`
    : null;
  const pubkeyShort = state.selfPubkey ? shortPubkey(state.selfPubkey) : null;

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      justifyContent="space-between"
    >
      <Text wrap="truncate-end">
        <Text color="cyanBright" bold>
          {state.alias}
        </Text>
        {npubShort ? <Text dimColor>{`  ${npubShort}`}</Text> : null}
        {pubkeyShort ? <Text dimColor>{`  (${pubkeyShort})`}</Text> : null}
      </Text>
      <Text wrap="truncate-end">
        <Text dimColor>{state.signalDescription}</Text>
        {total > 0 ? (
          <Text color={okRelays === total ? "greenBright" : "yellowBright"}>
            {`  ● ${okRelays}/${total}`}
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
