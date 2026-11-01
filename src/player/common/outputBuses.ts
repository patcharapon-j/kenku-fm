import { Howler } from "howler";

/**
 * Where a piece of the player's audio belongs once it leaves the player.
 * Playlists are music and soundboards are sound effects; the Stream Kit takes
 * them as separate tracks so that music can be ducked under voices while
 * effects never are.
 */
export type OutputBus = "music" | "sfx";

/** Every bus is stereo on its way out, whatever its sources are */
const BUS_CHANNELS = 2;

type Bus = {
  context: AudioContext;
  /** Everything on the bus is summed here, then sent to the speakers */
  input: GainNode;
  /** Copy of the bus as a stream, only while something is listening to it */
  tap: MediaStreamAudioDestinationNode | null;
};

const buses: Partial<Record<OutputBus, Bus>> = {};

/**
 * Howler's own context, bridged onto the effects bus while it is tapped.
 * Soundboard sounds without a cross fade are decoded and looped by Howler,
 * which plays them on a context of its own that the shared one can't connect
 * to directly, so its master output is carried across as a stream.
 */
let howlerBridge: {
  context: AudioContext;
  destination: MediaStreamAudioDestinationNode;
  source: MediaStreamAudioSourceNode;
} | null = null;

function getBus(context: AudioContext, bus: OutputBus): Bus {
  let existing = buses[bus];
  if (!existing || existing.context !== context) {
    const input = context.createGain();
    // A unity gain straight to the speakers, so a bus on its own changes
    // nothing about what is heard or what the Discord capture picks up
    input.connect(context.destination);
    existing = { context, input, tap: null };
    buses[bus] = existing;
  }
  return existing;
}

/** The node a source on `bus` connects to in place of the speakers */
export function busInput(context: AudioContext, bus: OutputBus): AudioNode {
  return getBus(context, bus).input;
}

/**
 * A live stereo stream of everything on `bus`, created on first use.
 * The speakers keep their own feed: this is a copy alongside it.
 */
export function busStream(context: AudioContext, bus: OutputBus): MediaStream {
  const state = getBus(context, bus);
  if (!state.tap) {
    const tap = context.createMediaStreamDestination();
    tap.channelCount = BUS_CHANNELS;
    tap.channelCountMode = "explicit";
    tap.channelInterpretation = "speakers";
    state.input.connect(tap);
    state.tap = tap;
  }
  if (bus === "sfx") {
    bridgeHowler();
  }
  return state.tap.stream;
}

/**
 * Stop copying the buses into streams, leaving them feeding the speakers only
 * Called once nothing is publishing so the copies cost nothing while idle
 */
export function releaseBusStreams(): void {
  for (const state of Object.values(buses)) {
    if (state?.tap) {
      state.input.disconnect(state.tap);
      state.tap = null;
    }
  }
  if (howlerBridge) {
    try {
      Howler.masterGain?.disconnect(howlerBridge.destination);
    } catch {
      // Howler's context has been replaced or closed, either way it is gone
    }
    howlerBridge.source.disconnect();
    howlerBridge = null;
  }
}

/**
 * Carry Howler's output onto the effects bus's stream.
 * Howler only creates its context with its first sound, so this is called
 * again every time a sound is created and does nothing until there is both a
 * context to bridge and a stream to bridge it to.
 */
export function bridgeHowler(): void {
  const sfx = buses.sfx;
  if (!sfx?.tap) {
    return;
  }
  const howlerContext = Howler.ctx;
  const master = Howler.masterGain;
  if (!howlerContext || !master) {
    return;
  }
  if (howlerBridge?.context === howlerContext) {
    return;
  }
  if (howlerBridge) {
    howlerBridge.source.disconnect();
  }
  try {
    const destination = howlerContext.createMediaStreamDestination();
    destination.channelCount = BUS_CHANNELS;
    destination.channelCountMode = "explicit";
    master.connect(destination);
    const source = sfx.context.createMediaStreamSource(destination.stream);
    source.connect(sfx.tap);
    howlerBridge = { context: howlerContext, destination, source };
  } catch {
    // Without the bridge Howler's sounds are still heard locally and on
    // Discord, they are just missing from the Stream Kit's effects track
    howlerBridge = null;
  }
}
