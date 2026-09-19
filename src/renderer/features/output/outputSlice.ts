import { createSlice, PayloadAction } from "@reduxjs/toolkit";

import { Device } from "../input/inputSlice";

export type VoiceChannel = {
  id: string;
  name: string;
};

export type Guild = {
  id: string;
  name: string;
  icon: string;
  voiceChannels: VoiceChannel[];
};

export interface OutputState {
  guilds: Guild[];
  outputs: string[];
  /** Audio outputs available for local monitoring */
  monitorDevices: Device[];
  /** Local monitoring level, 0 to 1 */
  monitorGain: number;
  /** An empty device id follows the system default output */
  monitorDeviceId: string;
}

const initialState: OutputState = {
  guilds: [],
  outputs: ["local"],
  monitorDevices: [],
  monitorGain: 1,
  monitorDeviceId: "",
};

export const outputSlice = createSlice({
  name: "output",
  initialState,
  reducers: {
    setGuilds: (state, action: PayloadAction<Guild[]>) => {
      state.guilds = action.payload;
    },
    setOutput: (state, action: PayloadAction<string>) => {
      state.outputs = [action.payload];
    },
    addOutput: (state, action: PayloadAction<string>) => {
      if (state.outputs.includes(action.payload)) {
        return;
      }
      state.outputs.push(action.payload);
    },
    removeOutput: (state, action: PayloadAction<string>) => {
      state.outputs = state.outputs.filter(
        (channel) => channel !== action.payload
      );
    },
    setMonitorDevices: (state, action: PayloadAction<Device[]>) => {
      state.monitorDevices = action.payload;
    },
    setMonitorGain: (state, action: PayloadAction<number>) => {
      state.monitorGain = action.payload;
    },
    setMonitorDeviceId: (state, action: PayloadAction<string>) => {
      state.monitorDeviceId = action.payload;
    },
  },
});

export const {
  setGuilds,
  setOutput,
  addOutput,
  removeOutput,
  setMonitorDevices,
  setMonitorGain,
  setMonitorDeviceId,
} = outputSlice.actions;

export default outputSlice.reducer;
