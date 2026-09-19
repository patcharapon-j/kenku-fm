import React from "react";

import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItem from "@mui/material/ListItem";
import IconButton from "@mui/material/IconButton";
import Box from "@mui/material/Box";

import VolumeIcon from "@mui/icons-material/VolumeUpRounded";
import TickIcon from "@mui/icons-material/CheckCircleRounded";
import TuneIcon from "@mui/icons-material/TuneRounded";

import { VoiceChannel } from "./outputSlice";

type OutputListItemProps = {
  voiceChannel: VoiceChannel;
  selected: boolean;
  tick?: boolean;
  onClick: (channelId: string) => void;
  onSettingsClick?: () => void;
};

export function OutputListItem({
  voiceChannel,
  selected,
  tick,
  onClick,
  onSettingsClick,
}: OutputListItemProps) {
  const shownIcons = Number(Boolean(tick)) + Number(Boolean(onSettingsClick));

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
          {onSettingsClick && (
            <IconButton
              edge="end"
              size="small"
              aria-label="monitor settings"
              onClick={onSettingsClick}
            >
              <TuneIcon sx={{ fontSize: "1rem" }} />
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
        onClick={() => onClick(voiceChannel.id)}
      >
        <ListItemIcon
          sx={{
            minWidth: "36px",
            color: selected ? "primary.main" : undefined,
          }}
        >
          <VolumeIcon />
        </ListItemIcon>
        <ListItemText primary={voiceChannel.name} />
      </ListItemButton>
    </ListItem>
  );
}
