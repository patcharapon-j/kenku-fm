import { createSlice, PayloadAction } from "@reduxjs/toolkit";

import { CaptureEncoder } from "../../common/audioCapture";

export interface CaptureState {
  /** Reported once per capture stream, so it stays unset until one starts */
  encoder?: CaptureEncoder;
}

const initialState: CaptureState = {};

export const captureSlice = createSlice({
  name: "capture",
  initialState,
  reducers: {
    setEncoder: (state, action: PayloadAction<CaptureEncoder>) => {
      state.encoder = action.payload;
    },
  },
});

export const { setEncoder } = captureSlice.actions;

export default captureSlice.reducer;
