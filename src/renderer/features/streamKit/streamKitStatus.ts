import { StreamKitState } from "../../../types/streamKit";

/** One line on how Kenku stands with the Stream Kit */
export function describeConnection(state: StreamKitState): string {
  const { connection } = state;
  switch (connection.status) {
    case "connected":
      return `Connected to ${connection.campaign.name}`;
    case "connecting":
      if (connection.pairing) {
        return "Pairing…";
      }
      return state.campaign
        ? `Connecting to ${state.campaign.name}…`
        : "Connecting…";
    case "refused":
      return connection.reason;
    case "failed":
      return connection.reason;
    case "idle":
    default:
      return state.paired ? "Not connected" : "Not paired";
  }
}

/** One line on what is going into the Voice Room */
export function describeVoice(state: StreamKitState): string {
  if (!state.paired) {
    return "Pair to publish Music + SFX";
  }
  if (!state.enabled) {
    return "Off";
  }
  if (state.voiceAvailable === false) {
    return "Voice Room not set up on the Stream Kit";
  }
  switch (state.voice.status) {
    case "publishing":
      return "Publishing Music + SFX";
    case "connecting":
      return "Joining the Voice Room…";
    case "reconnecting":
      return "Reconnecting to the Voice Room…";
    case "error":
      return `Couldn't join the Voice Room: ${state.voice.message}`;
    case "off":
    default:
      return "Waiting for the Stream Kit";
  }
}

export function isProblem(state: StreamKitState): boolean {
  return (
    state.connection.status === "refused" ||
    state.connection.status === "failed" ||
    (state.enabled && state.voice.status === "error")
  );
}
