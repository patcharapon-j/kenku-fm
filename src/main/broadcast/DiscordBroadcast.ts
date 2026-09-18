import { BrowserWindow, ipcMain } from "electron";
import { Client, Events, GatewayIntentBits } from "discord.js";
import {
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnection,
  VoiceConnectionDisconnectedState,
  VoiceConnectionState,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { TypedEmitter } from "tiny-typed-emitter";

type VoiceChannel = {
  id: string;
  name: string;
  position: number;
};

type Guild = {
  id: string;
  name: string;
  icon: string;
  voiceChannels: VoiceChannel[];
};

interface DiscordBroadcastEvents {
  channelJoined: (channelId: string, bitrate: number) => void;
  channelLeft: (channelId: string) => void;
}

/**
 * A voice connection along with the state needed to rejoin it after a
 * recoverable disconnect
 */
type VoiceOutput = {
  channelId: string;
  guildId: string;
  connection: VoiceConnection;
  /** Number of rejoin attempts made since this connection was last ready */
  attempts: number;
  /** Timer for the next rejoin attempt, if one is scheduled */
  timeout?: NodeJS.Timeout;
  /** True while a rejoin is scheduled or in flight */
  rejoining: boolean;
  /** Removes the handlers this output registered on its connection */
  removeListeners?: () => void;
};

/** Maximum number of rejoin attempts to make before giving up on a connection */
const MAX_REJOIN_ATTEMPTS = 5;
/** Delay in ms before the first rejoin attempt, doubled for each attempt after that */
const REJOIN_BASE_DELAY = 1000;
/** Time in ms to wait for a voice connection to become ready before giving up */
const READY_TIMEOUT = 15000;
/** Time in ms to wait for a disconnected connection to start reconnecting itself */
const RECONNECT_TIMEOUT = 5000;

export class DiscordBroadcast extends TypedEmitter<DiscordBroadcastEvents> {
  window: BrowserWindow;
  client?: Client;
  audioPlayer = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
      // Set max missed frames to 60 seconds (20ms per frame)
      maxMissedFrames: 3000,
    },
  });
  /** Voice connections keyed by the channel id they were created for */
  _voiceOutputs: Map<string, VoiceOutput> = new Map();
  /**
   * Channels that have been joined and not left
   * Used to restore the outputs after the Discord client reconnects
   */
  _joinedChannelIds: Set<string> = new Set();

  constructor(window: BrowserWindow) {
    super();
    this.window = window;
    ipcMain.on("DISCORD_CONNECT", this._handleConnect);
    ipcMain.on("DISCORD_DISCONNECT", this._handleDisconnect);
    ipcMain.on("DISCORD_JOIN_CHANNEL", this._handleJoinChannel);
    ipcMain.on("DISCORD_LEAVE_CHANNEL", this._handleLeaveChannel);
    this.audioPlayer.on("error", this._handleBroadcastError);
  }

  destroy() {
    ipcMain.off("DISCORD_CONNECT", this._handleConnect);
    ipcMain.off("DISCORD_DISCONNECT", this._handleDisconnect);
    ipcMain.off("DISCORD_JOIN_CHANNEL", this._handleJoinChannel);
    ipcMain.off("DISCORD_LEAVE_CHANNEL", this._handleLeaveChannel);
    this.audioPlayer.off("error", this._handleBroadcastError);
    this._destroyVoiceOutputs();
    this._joinedChannelIds.clear();
    this.audioPlayer.stop(true);
    this.client?.destroy();
    this.client = undefined;
  }

  _handleConnect = async (event: Electron.IpcMainEvent, token: string) => {
    if (!token) {
      event.reply("DISCORD_DISCONNECTED");
      event.reply("ERROR", "Error connecting to bot: Invalid token");
      return;
    }
    if (this.client) {
      // The voice connections belong to the old client so they can't be reused
      this._destroyVoiceOutputs();
      this.client.destroy();
      this.client = undefined;
    }

    try {
      this.client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
      });
      // Listen for every ready event and not just the first one so that the
      // outputs can be restored when the client reconnects after a drop
      this.client.on(Events.ClientReady, async () => {
        event.reply("DISCORD_READY");
        event.reply("MESSAGE", "Connected");
        const rawGuilds = await this.client.guilds.fetch();
        const guilds: Guild[] = await Promise.all(
          rawGuilds.map(async (baseGuild) => {
            const guild = await baseGuild.fetch();
            const voiceChannels: VoiceChannel[] = [];
            const channels = await guild.channels.fetch();
            channels.forEach((channel) => {
              if (channel && channel.isVoiceBased()) {
                voiceChannels.push({
                  id: channel.id,
                  name: channel.name,
                  position: channel.rawPosition,
                });
              }
            });
            return {
              id: guild.id,
              name: guild.name,
              icon: guild.iconURL(),
              voiceChannels: voiceChannels.sort(
                (a, b) => a.position - b.position,
              ),
            };
          }),
        );
        event.reply("DISCORD_GUILDS", guilds);
        await this._restoreChannels(event);
      });
      this.client.on("error", (err) => {
        event.reply("DISCORD_DISCONNECTED");
        event.reply("ERROR", `Error connecting to bot: ${err.message}`);
      });
      await this.client.login(token);
    } catch (err) {
      event.reply("DISCORD_DISCONNECTED");
      event.reply("ERROR", `Error connecting to bot: ${err.message}`);
    }
  };

  _handleDisconnect = async (event: Electron.IpcMainEvent) => {
    this._destroyVoiceOutputs();
    // The bot was disconnected by the user so don't restore these channels
    this._joinedChannelIds.clear();
    event.reply("DISCORD_DISCONNECTED");
    event.reply("DISCORD_GUILDS", []);
    event.reply("DISCORD_CHANNEL_JOINED", "local");
    this.client?.destroy();
    this.client = undefined;
  };

  _handleJoinChannel = async (
    event: Electron.IpcMainEvent,
    channelId: string,
  ) => {
    await this._joinChannel(event, channelId);
  };

  _handleLeaveChannel = async (
    event: Electron.IpcMainEvent,
    channelId: string,
  ) => {
    this._destroyVoiceOutput(channelId);
    this._replyChannelLeft(event, channelId);
  };

  _joinChannel = async (event: Electron.IpcMainEvent, channelId: string) => {
    if (!this.client) {
      this._replyChannelLeft(event, channelId);
      event.reply(
        "ERROR",
        `Unable to join voice channel. This channel might be full or this bot might not have permission to join.`,
      );
      return;
    }
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isVoiceBased() || !channel.joinable) {
        this._replyChannelLeft(event, channelId);
        event.reply(
          "ERROR",
          `Unable to join voice channel. This channel might be full or this bot might not have permission to join.`,
        );
        return;
      }

      // Discord only allows one connection per guild so joining a channel in a
      // guild we're already connected to reuses that connection
      // Stop tracking the other channels in this guild without destroying the
      // connection that they share with this one
      this._untrackVoiceOutput(channelId);
      for (const output of Array.from(this._voiceOutputs.values())) {
        if (output.guildId === channel.guild.id) {
          this._untrackVoiceOutput(output.channelId);
          this._replyChannelLeft(event, output.channelId);
        }
      }

      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
      });
      const output: VoiceOutput = {
        channelId,
        guildId: channel.guild.id,
        connection,
        attempts: 0,
        rejoining: false,
      };
      this._voiceOutputs.set(channelId, output);

      // Register the connection handlers before anything that can throw so an
      // error during the setup below is never missed
      const handleError = (e: Error) => {
        console.error(e);
        event.reply("ERROR", `Error connecting to voice channel: ${e.message}`);
        // Most errors are followed by a disconnect that can be rejoined, only
        // give up on the channel once the connection can't be used again
        if (connection.state.status === VoiceConnectionStatus.Destroyed) {
          this._destroyVoiceOutput(channelId);
          this._replyChannelLeft(event, channelId);
        }
      };
      const handleReady = () => {
        output.attempts = 0;
        output.rejoining = false;
      };
      const handleDisconnected = (
        _: VoiceConnectionState,
        newState: VoiceConnectionDisconnectedState,
      ) => {
        this._handleVoiceDisconnect(event, output, newState);
      };
      connection.on("error", handleError);
      connection.on(VoiceConnectionStatus.Ready, handleReady);
      connection.on(VoiceConnectionStatus.Disconnected, handleDisconnected);
      // A connection is shared by every channel in a guild and is reused when
      // rejoining, so the handlers are removed again when this output goes away
      output.removeListeners = () => {
        connection.off("error", handleError);
        connection.off(VoiceConnectionStatus.Ready, handleReady);
        connection.off(VoiceConnectionStatus.Disconnected, handleDisconnected);
      };

      connection.subscribe(this.audioPlayer);
      // Only report the channel as joined once the connection is ready so that
      // a join that never completes isn't shown as a success
      await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT);

      this._joinedChannelIds.add(channelId);
      event.reply("DISCORD_CHANNEL_JOINED", channelId);
      this.emit("channelJoined", channelId, channel.bitrate);
    } catch (e) {
      console.error(e);
      this._destroyVoiceOutput(channelId);
      this._replyChannelLeft(event, channelId);
      event.reply("ERROR", `Error connecting to voice channel: ${e.message}`);
    }
  };

  /** Rejoin the channels that were joined before the client reconnected */
  _restoreChannels = async (event: Electron.IpcMainEvent) => {
    for (const channelId of Array.from(this._joinedChannelIds)) {
      const output = this._voiceOutputs.get(channelId);
      // Don't touch a channel that still has a live connection
      if (
        output &&
        output.connection.state.status !== VoiceConnectionStatus.Destroyed
      ) {
        continue;
      }
      await this._joinChannel(event, channelId);
    }
  };

  _handleVoiceDisconnect = async (
    event: Electron.IpcMainEvent,
    output: VoiceOutput,
    state: VoiceConnectionDisconnectedState,
  ): Promise<void> => {
    // The connection was disconnected by us so there's nothing to recover
    if (state.reason === VoiceConnectionDisconnectReason.Manual) {
      return;
    }
    // A rejoin is already scheduled for this connection
    if (output.rejoining) {
      return;
    }
    // The connection might be moving to a new voice server, in which case it
    // starts signalling again on its own and there's nothing for us to do
    const reconnecting = [
      entersState(
        output.connection,
        VoiceConnectionStatus.Signalling,
        RECONNECT_TIMEOUT,
      ),
      entersState(
        output.connection,
        VoiceConnectionStatus.Connecting,
        RECONNECT_TIMEOUT,
      ),
    ];
    // Handle the rejection of whichever state isn't reached so that the slower
    // of the two promises never rejects unhandled
    for (const promise of reconnecting) {
      promise.catch((): void => {
        // Handled by the race below
      });
    }
    try {
      await Promise.race(reconnecting);
      return;
    } catch (e) {
      // The connection isn't reconnecting on its own so rejoin it below
    }
    if (output.connection.state.status === VoiceConnectionStatus.Destroyed) {
      return;
    }
    this._scheduleRejoin(event, output);
  };

  /** Rejoin a disconnected voice connection, backing off between each attempt */
  _scheduleRejoin = (
    event: Electron.IpcMainEvent,
    output: VoiceOutput,
  ): void => {
    // The connection was left or replaced while the rejoin was in flight
    if (this._voiceOutputs.get(output.channelId) !== output) {
      return;
    }
    if (output.attempts >= MAX_REJOIN_ATTEMPTS) {
      console.error(`Unable to rejoin voice channel ${output.channelId}`);
      this._destroyVoiceOutput(output.channelId);
      this._replyChannelLeft(event, output.channelId);
      event.reply("ERROR", "Lost connection to voice channel");
      return;
    }
    // Back off exponentially between attempts: 1s, 2s, 4s, 8s, 16s
    const delay = REJOIN_BASE_DELAY * Math.pow(2, output.attempts);
    output.attempts += 1;
    output.rejoining = true;
    output.timeout = setTimeout(async (): Promise<void> => {
      output.timeout = undefined;
      try {
        if (
          this._voiceOutputs.get(output.channelId) !== output ||
          output.connection.state.status === VoiceConnectionStatus.Destroyed
        ) {
          output.rejoining = false;
          return;
        }
        output.connection.rejoin();
        await entersState(
          output.connection,
          VoiceConnectionStatus.Ready,
          READY_TIMEOUT,
        );
        output.attempts = 0;
        output.rejoining = false;
      } catch (e) {
        output.rejoining = false;
        this._scheduleRejoin(event, output);
      }
    }, delay);
  };

  /**
   * Stop tracking a voice connection without destroying it, clearing any
   * pending rejoin so that a timer never outlives the connection
   */
  _untrackVoiceOutput = (channelId: string) => {
    const output = this._voiceOutputs.get(channelId);
    if (!output) {
      return undefined;
    }
    if (output.timeout) {
      clearTimeout(output.timeout);
      output.timeout = undefined;
    }
    output.rejoining = false;
    output.removeListeners?.();
    this._voiceOutputs.delete(channelId);
    return output;
  };

  /** Destroy a voice connection and stop tracking it */
  _destroyVoiceOutput = (channelId: string) => {
    const output = this._untrackVoiceOutput(channelId);
    if (!output) {
      return;
    }
    if (output.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      output.connection.destroy();
    }
  };

  /** Destroy every voice connection */
  _destroyVoiceOutputs = () => {
    for (const channelId of Array.from(this._voiceOutputs.keys())) {
      this._destroyVoiceOutput(channelId);
      this.emit("channelLeft", channelId);
    }
  };

  _replyChannelLeft = (event: Electron.IpcMainEvent, channelId: string) => {
    // A channel the renderer has been told we left must not come back when the
    // client reconnects
    this._joinedChannelIds.delete(channelId);
    event.reply("DISCORD_CHANNEL_LEFT", channelId);
    this.emit("channelLeft", channelId);
  };

  _handleBroadcastError = (error: Error) => {
    this.window.webContents.send("ERROR", error.message);
    console.error(error);
  };
}
