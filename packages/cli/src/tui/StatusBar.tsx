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
  let badgeColor: "greenBright" | "yellowBright" | "white" = "white";
  let badgeDim = false;
  if (state.active?.kind === "peer") {
    if (state.connectedPeers.has(state.active.pubkey)) {
      badge = "p2p";
      badgeColor = "greenBright";
    } else if (state.online.get(state.active.pubkey)) {
      badge = "relay";
      badgeColor = "yellowBright";
    } else {
      badge = "offline";
      badgeDim = true;
    }
  } else if (state.active?.kind === "group") {
    badge = "group";
    badgeColor = "yellowBright";
  } else {
    badge = "system";
    badgeDim = true;
  }

  // Window list — short labels with unread counts
  const windowLabels = state.contexts.map((c, idx) => {
    const isActive = sameContext(c.ref, state.active);
    const label = c.label.length > 10 ? `${c.label.slice(0, 9)}…` : c.label;
    return { idx, isActive, label, unread: c.unread, ref: c.ref };
  });

  const invitesBadge =
    state.invites.length > 0 ? ` ✉ ${state.invites.length} invite(s)` : "";

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      {/* Row 1: active context badge + label + invites — single Text so the
          whole row truncates cleanly on narrow terminals instead of slicing
          per-segment. */}
      <Text wrap="truncate-end">
        <Text color={badgeColor} dimColor={badgeDim} bold>
          ● {badge}
        </Text>
        <Text>
          {"  "}
          {activeKind === "group" ? "#" : activeKind === "peer" ? "→ " : ""}
          {activeLabel}
        </Text>
        {invitesBadge ? <Text color="yellowBright">{"   " + invitesBadge}</Text> : null}
      </Text>

      {/* Row 2: window list — same single-Text-with-truncate trick. */}
      <Text wrap="truncate-end">
        <Text dimColor>windows  </Text>
        {windowLabels.map((w, i) => (
          <Text key={i}>
            <Text
              color={w.isActive ? "cyanBright" : undefined}
              dimColor={!w.isActive}
              bold={w.isActive}
            >
              {w.label}
            </Text>
            {w.unread > 0 ? <Text color="yellowBright">{`(${w.unread})`}</Text> : null}
            {i < windowLabels.length - 1 ? <Text dimColor>{"  "}</Text> : null}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
