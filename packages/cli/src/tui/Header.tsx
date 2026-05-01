import { Box, Text } from "ink";
import type { AppState } from "./state.js";
import { shortPubkey } from "./colors.js";

export function Header({ state }: { state: AppState }) {
  const okRelays = state.relays.filter((r) => r.status === "ok").length;
  const total = state.relays.length;
  const npubShort = state.npub ? `${state.npub.slice(0, 12)}…${state.npub.slice(-6)}` : "—";
  const pubkeyShort = state.selfPubkey ? shortPubkey(state.selfPubkey) : "";

  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      justifyContent="space-between"
    >
      <Text>
        <Text color="cyanBright" bold>
          {state.alias}
        </Text>
        {state.npub ? (
          <Text color="gray">
            {"  "}
            {npubShort}
          </Text>
        ) : null}
        {pubkeyShort ? (
          <Text color="gray">
            {"  "}({pubkeyShort})
          </Text>
        ) : null}
      </Text>
      <Text>
        <Text color="gray">{state.signalDescription}</Text>
        {total > 0 ? (
          <Text color={okRelays === total ? "greenBright" : "yellow"}>
            {"  "}● {okRelays}/{total} relays
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
