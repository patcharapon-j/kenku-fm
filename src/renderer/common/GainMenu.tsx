import React from "react";

import Menu from "@mui/material/Menu";
import Slider from "@mui/material/Slider";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { MAX_GAIN, UNITY_GAIN } from "./audioCapture";

type GainMenuProps = {
  anchorEl: HTMLElement | null;
  open: boolean;
  gain: number;
  onGainChange: (gain: number) => void;
  onClose: () => void;
};

export function GainMenu({
  anchorEl,
  open,
  gain,
  onGainChange,
  onClose,
}: GainMenuProps) {
  return (
    <Menu
      anchorEl={anchorEl}
      open={open}
      onClose={onClose}
      anchorOrigin={{
        vertical: "bottom",
        horizontal: "right",
      }}
      transformOrigin={{
        vertical: "top",
        horizontal: "right",
      }}
    >
      <Stack sx={{ width: "160px", px: 2, py: 0.5 }}>
        <Stack direction="row" justifyContent="space-between">
          <Typography variant="caption">Level</Typography>
          <Typography variant="caption" color="text.secondary">
            {Math.round(gain * 100)}%
          </Typography>
        </Stack>
        <Slider
          aria-label="Level"
          size="small"
          value={gain}
          min={0}
          max={MAX_GAIN}
          step={0.01}
          marks={[{ value: UNITY_GAIN }]}
          onChange={(_, value) => onGainChange(value as number)}
          // Stop the tab bar drag and drop from stealing the drag
          onPointerDown={(event) => event.stopPropagation()}
        />
      </Stack>
    </Menu>
  );
}
