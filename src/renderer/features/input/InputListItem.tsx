import React, { useState } from "react";

import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItem from "@mui/material/ListItem";
import IconButton from "@mui/material/IconButton";
import Box from "@mui/material/Box";

import MicIcon from "@mui/icons-material/MicExternalOnRounded";
import TickIcon from "@mui/icons-material/CheckCircleRounded";
import TuneIcon from "@mui/icons-material/TuneRounded";

import { Device } from "./inputSlice";
import { UNITY_GAIN } from "../../common/audioCapture";
import { GainMenu } from "../../common/GainMenu";

type InputListItemProps = {
  device: Device;
  selected: boolean;
  tick?: boolean;
  gain: number;
  onClick: (channelId: string) => void;
  onGainChange: (deviceId: string, gain: number) => void;
};

export function InputListItem({
  device,
  selected,
  tick,
  gain,
  onClick,
  onGainChange,
}: InputListItemProps) {
  const [gainAnchor, setGainAnchor] = useState<HTMLButtonElement | null>(null);

  // A level is only worth showing once the device is part of the mix
  const showGain = selected;
  const shownIcons = Number(Boolean(tick)) + Number(showGain);

  return (
    <ListItem
      disablePadding
      secondaryAction={
        <>
          {tick && (
            <Box sx={{ height: "1rem" }}>
              <TickIcon sx={{ fontSize: "1rem" }} />
            </Box>
          )}
          {showGain && (
            <IconButton
              edge="end"
              size="small"
              aria-label="level"
              onClick={(event) => setGainAnchor(event.currentTarget)}
            >
              <TuneIcon
                sx={{ fontSize: "1rem" }}
                color={gain === UNITY_GAIN ? undefined : "primary"}
              />
            </IconButton>
          )}
        </>
      }
      sx={{
        "& .MuiListItemSecondaryAction-root": {
          display: "flex",
          alignItems: "center",
          gap: 0.5,
        },
        "& .MuiListItemButton-root": {
          pr: shownIcons ? `${shownIcons * 28 + 8}px` : undefined,
        },
      }}
    >
      <ListItemButton
        selected={selected}
        dense
        onClick={() => onClick(device.id)}
      >
        <ListItemIcon
          sx={{
            minWidth: "36px",
            color: selected ? "primary.main" : undefined,
          }}
        >
          <MicIcon />
        </ListItemIcon>
        <ListItemText primary={device.label} />
      </ListItemButton>
      <GainMenu
        anchorEl={gainAnchor}
        open={Boolean(gainAnchor)}
        gain={gain}
        onGainChange={(value) => onGainChange(device.id, value)}
        onClose={() => setGainAnchor(null)}
      />
    </ListItem>
  );
}
