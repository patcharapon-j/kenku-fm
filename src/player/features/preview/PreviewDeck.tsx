import React, { useState } from "react";
import { useSelector } from "react-redux";

import styled from "@mui/material/styles/styled";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Slider from "@mui/material/Slider";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";

import CloseRounded from "@mui/icons-material/CloseRounded";
import GraphicEqRounded from "@mui/icons-material/GraphicEqRounded";
import HeadphonesRounded from "@mui/icons-material/HeadphonesRounded";
import PauseRounded from "@mui/icons-material/PauseRounded";
import PlayArrowRounded from "@mui/icons-material/PlayArrowRounded";
import SensorsRounded from "@mui/icons-material/SensorsRounded";
import VolumeDownRounded from "@mui/icons-material/VolumeDownRounded";
import VolumeOffRounded from "@mui/icons-material/VolumeOffRounded";

import { RootState } from "../../app/store";
import {
  PREVIEW_ACCENT,
  PREVIEW_BORDER,
  PREVIEW_SURFACE,
  PREVIEW_TINT,
  PREVIEW_TINT_HOVER,
} from "./previewTheme";

const minWidthForLargeContext = 650;

const PreviewTimeSlider = styled(Slider)({
  color: PREVIEW_ACCENT,
  height: 4,
  padding: "6px 0",
  "& .MuiSlider-thumb": {
    width: 10,
    height: 10,
    backgroundColor: PREVIEW_ACCENT,
    "&:hover, &.Mui-focusVisible": {
      boxShadow: "0px 0px 0px 8px rgba(245, 183, 76, 0.2)",
    },
    "&.Mui-active": {
      width: 16,
      height: 16,
    },
  },
  "& .MuiSlider-rail": {
    opacity: 0.25,
  },
});

const PreviewVolumeSlider = styled(Slider)({
  color: PREVIEW_ACCENT,
  height: 4,
  padding: "6px 0",
  "& .MuiSlider-track": {
    border: "none",
  },
  "& .MuiSlider-thumb": {
    width: 14,
    height: 14,
    backgroundColor: PREVIEW_ACCENT,
    "&:hover, &.Mui-focusVisible, &.Mui-active": {
      boxShadow: "0 2px 8px rgba(0, 0, 0, 0.45)",
    },
  },
});

const TinyTime = styled(Typography)({
  fontSize: "0.7rem",
  color: "rgba(255, 232, 196, 0.72)",
  fontWeight: 500,
  letterSpacing: 0.2,
  fontVariantNumeric: "tabular-nums",
});

function formatDuration(value: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const minutes = Math.floor(safe / 60);
  const seconds = safe - minutes * 60;
  return `${minutes}:${seconds < 10 ? `0${seconds}` : seconds}`;
}

export type PreviewDeckProps = {
  onTogglePlay: () => void;
  onSeek: (to: number) => void;
  onVolumeChange: (volume: number) => void;
  onMuteToggle: () => void;
  onDuckToggle: () => void;
  onPromoteToLive: () => void;
  onClose: () => void;
};

export function PreviewDeck({
  onTogglePlay,
  onSeek,
  onVolumeChange,
  onMuteToggle,
  onDuckToggle,
  onPromoteToLive,
  onClose,
}: PreviewDeckProps) {
  const preview = useSelector((state: RootState) => state.preview);
  const isSameLiveTrack = useSelector(
    (state: RootState) =>
      preview.item?.kind === "track" &&
      state.playlistPlayback.track?.id === preview.item.id,
  );
  const isSameLiveSound = useSelector(
    (state: RootState) =>
      preview.item?.kind === "sound" &&
      preview.item.id in state.soundboardPlayback.playback,
  );
  const large = useMediaQuery(`(min-width: ${minWidthForLargeContext}px)`);
  const [timeOverride, setTimeOverride] = useState<number | null>(null);

  if (!preview.item) {
    return null;
  }

  const isSameLive = isSameLiveTrack || isSameLiveSound;
  const duration = Math.max(preview.duration, 0);
  const time = timeOverride === null ? preview.progress : timeOverride;
  const clampedTime = duration > 0 ? Math.min(time, duration) : time;

  const canPromoteAtPosition =
    preview.item.kind === "track" &&
    !preview.ended &&
    clampedTime >= 1 &&
    (duration <= 0 || clampedTime < duration - 1);

  const promoteLabel = canPromoteAtPosition
    ? `Play live from ${formatDuration(clampedTime)}`
    : "Play live";

  const promoteTooltip =
    preview.item.kind === "track"
      ? isSameLiveTrack
        ? "Stop preview and jump the live track to this position"
        : "Stop preview and play this track live to the table from here"
      : "Stop preview and play this sound live to the table";

  function handleDeckKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== " ") {
      return;
    }
    const target = event.target as HTMLElement | null;
    // Buttons and inputs handle Space natively; avoid double-toggling them.
    if (
      target &&
      (target.tagName === "BUTTON" ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA")
    ) {
      return;
    }
    event.preventDefault();
    onTogglePlay();
  }

  return (
    <Paper
      elevation={10}
      role="region"
      aria-label="GM Preview — only you hear this"
      data-testid="gm-preview-deck"
      onKeyDown={handleDeckKeyDown}
      sx={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 0.5,
        px: 1.75,
        py: 1,
        backgroundColor: PREVIEW_SURFACE,
        backgroundImage: "none",
        border: `1.5px solid ${PREVIEW_BORDER}`,
        borderLeft: `5px solid ${PREVIEW_ACCENT}`,
        boxShadow: "0 10px 28px rgba(0, 0, 0, 0.65)",
      }}
    >
      {/* Top identity & action strip */}
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1}
        flexWrap="wrap"
        useFlexGap
      >
        <Stack direction="row" alignItems="center" spacing={1} minWidth={0}>
          <Stack
            direction="row"
            alignItems="center"
            spacing={0.5}
            sx={{
              px: 1,
              py: 0.25,
              borderRadius: "999px",
              backgroundColor: PREVIEW_TINT,
              border: `1px solid ${PREVIEW_BORDER}`,
              color: PREVIEW_ACCENT,
              flexShrink: 0,
            }}
          >
            <HeadphonesRounded sx={{ fontSize: "0.95rem" }} />
            <Typography
              variant="caption"
              sx={{
                fontWeight: 700,
                letterSpacing: 0.4,
                color: PREVIEW_ACCENT,
                lineHeight: 1.2,
              }}
            >
              PREVIEW · Only you hear this
            </Typography>
          </Stack>
          {isSameLive && (
            <Chip
              size="small"
              icon={<SensorsRounded sx={{ fontSize: "0.9rem !important" }} />}
              label="Also playing live"
              sx={{
                height: 22,
                fontSize: "0.7rem",
                backgroundColor: "rgba(187, 153, 255, 0.16)",
                color: "#d9c6ff",
                border: "1px solid rgba(187, 153, 255, 0.4)",
                "& .MuiChip-icon": { color: "#bb99ff" },
              }}
            />
          )}
        </Stack>

        <Stack direction="row" alignItems="center" spacing={0.75}>
          <Tooltip title="Lower live mix in your local monitor while preview plays (never affects Discord or Stream Kit)">
            <Chip
              size="small"
              clickable
              icon={<GraphicEqRounded sx={{ fontSize: "0.9rem !important" }} />}
              label={preview.duckLiveMonitor ? "Duck live: On" : "Duck live: Off"}
              aria-label={
                preview.duckLiveMonitor
                  ? "Duck live monitor on"
                  : "Duck live monitor off"
              }
              onClick={onDuckToggle}
              sx={{
                height: 24,
                fontSize: "0.7rem",
                fontWeight: 600,
                color: preview.duckLiveMonitor
                  ? PREVIEW_ACCENT
                  : "rgba(255, 255, 255, 0.65)",
                backgroundColor: preview.duckLiveMonitor
                  ? PREVIEW_TINT
                  : "transparent",
                border: `1px solid ${
                  preview.duckLiveMonitor
                    ? PREVIEW_BORDER
                    : "rgba(255, 255, 255, 0.2)"
                }`,
                "& .MuiChip-icon": {
                  color: preview.duckLiveMonitor
                    ? PREVIEW_ACCENT
                    : "rgba(255, 255, 255, 0.5)",
                },
                "&:hover": {
                  backgroundColor: PREVIEW_TINT_HOVER,
                },
              }}
            />
          </Tooltip>

          <Tooltip title={promoteTooltip}>
            <Button
              size="small"
              variant="contained"
              color="primary"
              startIcon={<SensorsRounded sx={{ fontSize: "1rem" }} />}
              onClick={onPromoteToLive}
              sx={{
                py: 0.25,
                px: 1.25,
                minHeight: 26,
                fontSize: "0.75rem",
                fontWeight: 700,
                textTransform: "none",
                borderRadius: "999px",
                color: "#161826",
              }}
            >
              {promoteLabel}
            </Button>
          </Tooltip>

          <Tooltip title="Stop and close preview (Esc)">
            <IconButton
              size="small"
              aria-label="close preview"
              onClick={onClose}
              sx={{
                color: "rgba(255, 232, 196, 0.8)",
                "&:hover": { color: "#fff", backgroundColor: PREVIEW_TINT },
              }}
            >
              <CloseRounded fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Stack>

      {/* Main transport, title, seek, and independent volume */}
      <Stack
        direction={large ? "row" : "column"}
        alignItems="center"
        spacing={large ? 1.5 : 0.5}
      >
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{ width: large ? "32%" : "100%", minWidth: 0 }}
        >
          <IconButton
            size="small"
            aria-label={preview.playing ? "pause preview" : "play preview"}
            onClick={onTogglePlay}
            sx={{
              color: "#1c1509",
              backgroundColor: PREVIEW_ACCENT,
              "&:hover": { backgroundColor: "#ffd07a" },
              flexShrink: 0,
            }}
          >
            {preview.playing ? <PauseRounded /> : <PlayArrowRounded />}
          </IconButton>
          <Box sx={{ minWidth: 0, flexGrow: 1 }}>
            <Typography
              variant="body2"
              noWrap
              sx={{ fontWeight: 600, color: "#fff5e4", lineHeight: 1.25 }}
            >
              {preview.item.title}
            </Typography>
            <Typography
              variant="caption"
              noWrap
              display="block"
              sx={{ color: "rgba(255, 224, 178, 0.72)", lineHeight: 1.2 }}
            >
              {preview.item.parentTitle} ·{" "}
              {preview.item.kind === "track" ? "Track" : "Sound"}
            </Typography>
          </Box>
          {!large && (
            <Stack
              direction="row"
              alignItems="center"
              spacing={0.75}
              sx={{ width: 120, flexShrink: 0 }}
            >
              <IconButton
                size="small"
                aria-label={preview.muted ? "unmute preview" : "mute preview"}
                onClick={onMuteToggle}
                sx={{ color: PREVIEW_ACCENT, p: 0.5 }}
              >
                {preview.muted || preview.volume === 0 ? (
                  <VolumeOffRounded fontSize="small" />
                ) : (
                  <VolumeDownRounded fontSize="small" />
                )}
              </IconButton>
              <PreviewVolumeSlider
                aria-label="preview volume"
                value={preview.muted ? 0 : preview.volume}
                step={0.01}
                min={0}
                max={1}
                onChange={(_, value) => onVolumeChange(value as number)}
              />
            </Stack>
          )}
        </Stack>

        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{ flexGrow: 1, width: large ? undefined : "100%" }}
        >
          <TinyTime>{formatDuration(clampedTime)}</TinyTime>
          <PreviewTimeSlider
            aria-label="preview position"
            size="small"
            value={clampedTime}
            min={0}
            step={0.5}
            max={duration > 0 ? duration : 1}
            disabled={duration <= 0}
            onChange={(_, value) => setTimeOverride(value as number)}
            onChangeCommitted={(_, value) => {
              setTimeOverride(null);
              onSeek(value as number);
            }}
          />
          <TinyTime>-{formatDuration(Math.max(duration - clampedTime, 0))}</TinyTime>
        </Stack>

        {large && (
          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ width: "22%", minWidth: 130 }}
          >
            <IconButton
              size="small"
              aria-label={preview.muted ? "unmute preview" : "mute preview"}
              onClick={onMuteToggle}
              sx={{ color: PREVIEW_ACCENT }}
            >
              {preview.muted || preview.volume === 0 ? (
                <VolumeOffRounded fontSize="small" />
              ) : (
                <VolumeDownRounded fontSize="small" />
              )}
            </IconButton>
            <PreviewVolumeSlider
              aria-label="preview volume"
              value={preview.muted ? 0 : preview.volume}
              step={0.01}
              min={0}
              max={1}
              onChange={(_, value) => onVolumeChange(value as number)}
            />
          </Stack>
        )}
      </Stack>
    </Paper>
  );
}

/**
 * Slim header banner rendered on the Live Player card while the Preview Deck is
 * open so both decks carry explicit, contrasting labels side by side.
 */
export function LiveDeckBanner() {
  const playlistPlaying = useSelector(
    (state: RootState) => state.playlistPlayback.playing,
  );
  const soundCount = useSelector(
    (state: RootState) =>
      Object.keys(state.soundboardPlayback.playback).length,
  );
  const isLiveAudioPlaying = playlistPlaying || soundCount > 0;

  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={0.75}
      sx={{ mb: 0.75 }}
      data-testid="live-deck-banner"
    >
      <Box
        sx={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          backgroundColor: isLiveAudioPlaying
            ? "primary.main"
            : "rgba(255, 255, 255, 0.3)",
          boxShadow: isLiveAudioPlaying
            ? "0 0 8px rgba(187, 153, 255, 0.9)"
            : "none",
        }}
      />
      <Typography
        variant="caption"
        sx={{
          fontWeight: 700,
          letterSpacing: 0.4,
          color: isLiveAudioPlaying ? "primary.main" : "rgba(255, 255, 255, 0.6)",
          lineHeight: 1.2,
        }}
      >
        {isLiveAudioPlaying
          ? "LIVE · Table hears this"
          : "LIVE · Idle (table hears this deck)"}
      </Typography>
    </Stack>
  );
}
