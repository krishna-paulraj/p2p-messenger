import { Box, Text } from "ink";
import type { AppState, ContextRef } from "./state.js";
import { sameContext } from "./state.js";

export function StatusBar({
  state,
  resolveDisplay,
}: {
  state: AppState;
  resolveDisplay: (ref: ContextRef) => string;
}) {
  const activeLabel = state.active ? resolveDisplay(state.active) : "—";
  const activeKind = state.active?.kind ?? "system";

  // Connection / online indicator for active peer
  let badge = "";
  let badgeColor: "greenBright" | "yellow" | "gray" = "gray";
  if (state.active?.kind === "peer") {
    if (state.connectedPeers.has(state.active.pubkey)) {
      badge = "p2p";
      badgeColor = "greenBright";
    } else if (state.online.get(state.active.pubkey)) {
      badge = "relay";
      badgeColor = "yellow";
    } else {
      badge = "offline";
      badgeColor = "gray";
    }
  } else if (state.active?.kind === "group") {
    badge = "group";
    badgeColor = "yellow";
  } else {
    badge = "system";
    badgeColor = "gray";
  }

  // Window list — short labels with unread counts
  const windowLabels = state.contexts.map((c, idx) => {
    const isActive = sameContext(c.ref, state.active);
    const label = c.label.length > 10 ? `${c.label.slice(0, 9)}…` : c.label;
    const unread = c.unread > 0 ? `(${c.unread})` : "";
    return { idx, isActive, label, unread, ref: c.ref };
  });

  const invitesBadge =
    state.invites.length > 0 ? ` ✉ ${state.invites.length} invite(s)` : "";

  return (
    <Box
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      flexDirection="column"
    >
      <Box justifyContent="space-between">
        <Text>
          <Text color={badgeColor} bold>
            ● {badge}
          </Text>
          <Text color="white">
            {"  "}
            {activeKind === "group" ? "#" : activeKind === "peer" ? "→ " : ""}
            {activeLabel}
          </Text>
        </Text>
        {invitesBadge ? <Text color="yellowBright">{invitesBadge}</Text> : null}
      </Box>
      <Box>
        <Text color="gray">windows: </Text>
        {windowLabels.map((w, i) => (
          <Text key={i}>
            <Text color={w.isActive ? "cyanBright" : "gray"} bold={w.isActive}>
              {w.label}
            </Text>
            {w.unread ? <Text color="yellowBright">{w.unread}</Text> : null}
            {i < windowLabels.length - 1 ? <Text color="gray">{"  "}</Text> : null}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
