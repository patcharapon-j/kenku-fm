import React, { useState } from "react";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import PlayArrow from "@mui/icons-material/PlayArrowRounded";
import Pause from "@mui/icons-material/PauseRounded";
import HeadphonesRounded from "@mui/icons-material/HeadphonesRounded";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import Divider from "@mui/material/Divider";

import MoreVert from "@mui/icons-material/MoreVertRounded";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";

import { Track, removeTrack, Playlist } from "./playlistsSlice";
import { useDispatch, useSelector } from "react-redux";
import { TrackSettings } from "./TrackSettings";
import { RootState } from "../../app/store";
import {
  playPause,
  removeTrackFromQueue,
  startQueue,
  stopTrack,
  updatePlayback,
} from "./playlistPlaybackSlice";
import {
  PREVIEW_ACCENT,
  PREVIEW_BORDER,
  PREVIEW_TINT,
  PREVIEW_TINT_HOVER,
} from "../preview/previewTheme";

type TrackItemProps = {
  track: Track;
  playlist: Playlist;
  onPlay: (id: string) => void;
  onPreview: (id: string) => void;
};

export function TrackItem({
  track,
  playlist,
  onPlay,
  onPreview,
}: TrackItemProps) {
  const isCurrentTrack = useSelector(
    (state: RootState) => state.playlistPlayback.track?.id === track.id,
  );
  const playing = useSelector(
    (state: RootState) => state.playlistPlayback.playing && isCurrentTrack,
  );
  const isPreviewTrack = useSelector(
    (state: RootState) =>
      state.preview.item?.kind === "track" &&
      state.preview.item.id === track.id,
  );
  const previewPlaying = useSelector(
    (state: RootState) => isPreviewTrack && state.preview.playing,
  );
  const dispatch = useDispatch();

  const [settingsOpen, setSettingsOpen] = useState(false);

  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const menuOpen = Boolean(anchorEl);
  function handleMenuClick(event: React.MouseEvent<HTMLButtonElement>) {
    setAnchorEl(event.currentTarget);
  }
  function handleMenuClose() {
    setAnchorEl(null);
  }

  function handleEdit() {
    setSettingsOpen(true);
    handleMenuClose();
  }

  function handleCopyID() {
    navigator.clipboard.writeText(track.id);
    handleMenuClose();
  }

  function handleDelete() {
    // TODO: Fix bug where playback does not update to zero when isCurrentTrack is removed
    if (isCurrentTrack) {
      dispatch(playPause(false));
      dispatch(stopTrack());
    }
    dispatch(removeTrack({ trackId: track.id, playlistId: playlist.id }));
    dispatch(
      removeTrackFromQueue({ trackId: track.id, playlistId: playlist.id }),
    );
    handleMenuClose();
  }

  function handlePlayPause() {
    if (isCurrentTrack) {
      dispatch(playPause(!playing));
    } else {
      onPlay(track.id);
    }
  }

  function handlePreview(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onPreview(track.id);
  }

  return (
    <ListItem key={track.id} disablePadding>
      <Paper
        sx={{
          minWidth: 0,
          width: "100%",
          m: 0.5,
          backgroundColor: "rgba(34, 38, 57, 0.8)",
          ...(isPreviewTrack && {
            boxShadow: `inset 3px 0 0 ${PREVIEW_ACCENT}`,
          }),
        }}
      >
        <ListItemButton
          role={undefined}
          sx={{ m: 0, borderRadius: "16px" }}
          dense
          selected={isCurrentTrack}
        >
          <ListItemText
            primary={track.title}
            secondary={track.tags?.join(" • ")}
            sx={{
              ".MuiListItemText-primary": {
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              },
            }}
            primaryTypographyProps={{
              typography: "body1",
            }}
          />
          <Tooltip
            title={
              previewPlaying
                ? "Stop preview (only you hear this)"
                : "Preview (only you hear this)"
            }
          >
            <IconButton
              aria-label={
                previewPlaying
                  ? `stop preview ${track.title}`
                  : `preview ${track.title}`
              }
              size="small"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={handlePreview}
              sx={{
                mr: 0.5,
                color: isPreviewTrack
                  ? PREVIEW_ACCENT
                  : "rgba(245, 183, 76, 0.75)",
                backgroundColor: isPreviewTrack ? PREVIEW_TINT : "transparent",
                border: `1px solid ${
                  isPreviewTrack ? PREVIEW_BORDER : "rgba(245, 183, 76, 0.25)"
                }`,
                "&:hover": {
                  color: PREVIEW_ACCENT,
                  backgroundColor: PREVIEW_TINT_HOVER,
                  borderColor: PREVIEW_BORDER,
                },
              }}
            >
              <HeadphonesRounded fontSize="small" />
            </IconButton>
          </Tooltip>
          <Divider
            orientation="vertical"
            flexItem
            sx={{ mx: 0.5, my: 1, opacity: 0.2 }}
          />
          <Tooltip title={playing ? "Pause live" : "Play live (table hears this)"}>
            <IconButton
              aria-label={playing ? "pause" : "play"}
              onClick={handlePlayPause}
            >
              {playing ? <Pause /> : <PlayArrow />}
            </IconButton>
          </Tooltip>
          <IconButton onClick={handleMenuClick}>
            <MoreVert />
          </IconButton>
        </ListItemButton>
      </Paper>
      <Menu
        id="playlist-menu"
        anchorEl={anchorEl}
        open={menuOpen}
        onClose={handleMenuClose}
        slotProps={{ list: { "aria-labelledby": "more-button" } }}
      >
        <MenuItem onClick={handleEdit}>Edit</MenuItem>
        <MenuItem onClick={handleCopyID}>Copy ID</MenuItem>
        <MenuItem onClick={handleDelete}>Delete</MenuItem>
      </Menu>
      <TrackSettings
        track={track}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </ListItem>
  );
}
