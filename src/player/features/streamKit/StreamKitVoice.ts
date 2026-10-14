import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  TrackPublishOptions,
} from "livekit-client";

import { VoiceRoomState } from "../../../types/streamKit";
import { getAudioContext } from "../../common/WebAudioTrack";
import {
  busStream,
  OutputBus,
  releaseBusStreams,
} from "../../common/outputBuses";


/**
 * How music and effects are published: stereo, high bitrate, and without the
 * voice oriented features that would eat into music (DTX gates quiet passages
 * to silence). RED adds redundancy so a lost packet isn't a dropout.
 */
const PUBLISH_OPTIONS: TrackPublishOptions = {
  source: Track.Source.Unknown,
  dtx: false,
  red: true,
  forceStereo: true,
  audioPreset: { maxBitrate: 256_000 },
};

/** Delay before asking for fresh credentials after the room is lost, doubled each time */
const MIN_RETRY_DELAY = 2000;
const MAX_RETRY_DELAY = 30000;

/**
 * Publishes the player's music and effects buses into the Campaign's LiveKit
 * Voice Room as two tracks, `music` and `sfx`.
 *
 * Credentials come from the Stream Kit through the main process. A fresh
 * token while the room is up is kept for later rather than used to reconnect,
 * as the connection it would replace is already authenticated; a new room
 * address, or a room that has been lost, is connected afresh and the old room
 * is only let go once the new one is publishing.
 */
export class StreamKitVoice {
  private _room: Room | null = null;
  private _url: string | null = null;
  private _token: string | null = null;
  /** Bumped by every change of plan so a connect that is overtaken gives up */
  private _generation = 0;
  private _retryDelay = MIN_RETRY_DELAY;
  private _retryTimeout: NodeJS.Timeout | null = null;
  private _state: VoiceRoomState = { status: "off" };

  constructor(
    private _onState: (state: VoiceRoomState) => void,
    /** Ask the Stream Kit for credentials again */
    private _requestVoice: () => void,
  ) {}

  /** Publish into the room at `url` with `token`, or stop with nulls */
  setCredentials(url: string | null, token: string | null): void {
    if (!url || !token) {
      this.stop();
      return;
    }
    const sameRoom = url === this._url;
    this._url = url;
    this._token = token;
    if (sameRoom && this._room && this._state.status !== "error") {
      // Already in, or on the way into, this room. The token is held for the
      // next time the room has to be joined from scratch
      return;
    }
    void this._connect();
  }

  stop(): void {
    this._generation += 1;
    this._clearRetry();
    this._url = null;
    this._token = null;
    const room = this._room;
    this._room = null;
    if (room) {
      void room.disconnect(true);
    }
    releaseBusStreams();
    this._setState({ status: "off" });
  }

  private async _connect(): Promise<void> {
    const generation = ++this._generation;
    this._clearRetry();
    const url = this._url;
    const token = this._token;
    if (!url || !token) {
      return;
    }
    const context = getAudioContext();
    if (!context) {
      this._setState({
        status: "error",
        message: "Web Audio isn't available in the player",
      });
      return;
    }
    if (!this._room) {
      this._setState({ status: "connecting" });
    }

    const room = new Room({
      adaptiveStream: false,
      dynacast: false,
      // Kenku only sends; the table's voices are of no use to it
      webAudioMix: false,
    });
    try {
      await room.connect(url, token, { autoSubscribe: false });
      if (generation !== this._generation) {
        await room.disconnect(true);
        return;
      }
      // Each room is given clones of the bus tracks, as leaving a room stops
      // the tracks it was publishing and the buses outlive any one room
      await Promise.all(
        (["music", "sfx"] as OutputBus[]).map((bus) => {
          const [track] = busStream(context, bus).getAudioTracks();
          return room.localParticipant.publishTrack(track.clone(), {
            ...PUBLISH_OPTIONS,
            name: bus,
          });
        }),
      );
      if (generation !== this._generation) {
        await room.disconnect(true);
        return;
      }
    } catch (error) {
      void room.disconnect(true);
      if (generation !== this._generation) {
        return;
      }
      this._setState({
        status: "error",
        message:
          error instanceof Error ? error.message : "Couldn't join the Voice Room",
      });
      this._scheduleRetry();
      return;
    }

    const previous = this._room;
    this._room = room;
    this._retryDelay = MIN_RETRY_DELAY;
    room.on(RoomEvent.Reconnecting, () => {
      if (this._room === room) {
        this._setState({ status: "reconnecting" });
      }
    });
    room.on(RoomEvent.Reconnected, () => {
      if (this._room === room) {
        this._setState({ status: "publishing" });
      }
    });
    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (this._room !== room) {
        return;
      }
      this._room = null;
      if (reason === DisconnectReason.CLIENT_INITIATED) {
        return;
      }
      // LiveKit gave up on resuming, or the room went away. The token in hand
      // may be the reason, so a new one is asked for before trying again
      this._setState({ status: "connecting" });
      this._scheduleRetry();
    });
    this._setState({ status: "publishing" });
    if (previous) {
      void previous.disconnect(true);
    }
  }

  private _scheduleRetry(): void {
    this._clearRetry();
    const delay = this._retryDelay;
    this._retryDelay = Math.min(this._retryDelay * 2, MAX_RETRY_DELAY);
    this._retryTimeout = setTimeout(() => {
      this._retryTimeout = null;
      if (!this._url) {
        return;
      }
      // The Stream Kit answers with a `voice` message, which reconnects. The
      // credentials in hand are tried as well in case it never does
      this._requestVoice();
      void this._connect();
    }, delay);
  }

  private _clearRetry(): void {
    if (this._retryTimeout) {
      clearTimeout(this._retryTimeout);
      this._retryTimeout = null;
    }
  }

  private _setState(state: VoiceRoomState): void {
    this._state = state;
    this._onState(state);
  }
}
