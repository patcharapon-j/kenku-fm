import React from "react";
import { useDispatch, useSelector } from "react-redux";
import { Link as RouterLink } from "react-router-dom";
import Link from "@mui/material/Link";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";
import HeadphonesRounded from "@mui/icons-material/HeadphonesRounded";
import { RootState } from "../../app/store";
import { Playlist, Track } from "../playlists/playlistsSlice";
import { Sound, Soundboard } from "../soundboards/soundboardsSlice";
import { startQueue } from "../playlists/playlistPlaybackSlice";
import { useLibraryFilter } from "./LibraryControls";
import { useNormalizationControls } from "./NormalizationProvider";
import {
  PREVIEW_ACCENT,
  PREVIEW_BORDER,
  PREVIEW_TINT,
  PREVIEW_TINT_HOVER,
} from "../preview/previewTheme";

export function Library({
  onPlayTrack,
  onPlaySound,
  onPreviewTrack,
  onPreviewSound,
}: {
  onPlayTrack: (track: Track) => void;
  onPlaySound: (sound: Sound) => void;
  onPreviewTrack: (track: Track, playlist: Playlist) => void;
  onPreviewSound: (sound: Sound, soundboard: Soundboard) => void;
}) {
  const dispatch = useDispatch();
  const playlists = useSelector((state: RootState) => state.playlists);
  const soundboards = useSelector((state: RootState) => state.soundboards);
  const preview = useSelector((state: RootState) => state.preview);
  const items = [
    ...Object.values(playlists.playlists.byId).flatMap((parent) =>
      parent.tracks.map((id) => ({
        ...playlists.tracks[id],
        kind: "track",
        parent,
        key: `track:${id}`,
      })),
    ),
    ...Object.values(soundboards.soundboards.byId).flatMap((parent) =>
      parent.sounds.map((id) => ({
        ...soundboards.sounds[id],
        kind: "sound",
        parent,
        key: `sound:${id}`,
      })),
    ),
  ];
  const { visible, controls } = useLibraryFilter(items);
  const normalization = useNormalizationControls();
  return (
    <Card>
      <CardContent>
        <Typography variant="h5" sx={{ mb: 2 }}>
          All audio
        </Typography>
        {controls}
        <List sx={{ maxHeight: 360, overflowY: "auto" }}>
          {visible.map((item) => {
            const isPreviewing =
              preview.item?.kind === item.kind && preview.item.id === item.id;
            const isPreviewPlaying = isPreviewing && preview.playing;
            return (
              <ListItem
                key={item.key}
                sx={{
                  pr: "172px",
                  ...(isPreviewing && {
                    boxShadow: `inset 3px 0 0 ${PREVIEW_ACCENT}`,
                  }),
                }}
                secondaryAction={
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Tooltip
                      title={
                        isPreviewPlaying
                          ? "Stop preview (only you hear this)"
                          : "Preview (only you hear this)"
                      }
                    >
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<HeadphonesRounded fontSize="small" />}
                        onClick={() => {
                          if (item.kind === "track") {
                            onPreviewTrack(
                              playlists.tracks[item.id],
                              playlists.playlists.byId[item.parent.id],
                            );
                          } else {
                            onPreviewSound(
                              soundboards.sounds[item.id],
                              soundboards.soundboards.byId[item.parent.id],
                            );
                          }
                        }}
                        sx={{
                          color: PREVIEW_ACCENT,
                          borderColor: isPreviewing
                            ? PREVIEW_ACCENT
                            : PREVIEW_BORDER,
                          backgroundColor: isPreviewing
                            ? PREVIEW_TINT
                            : "transparent",
                          textTransform: "none",
                          "&:hover": {
                            borderColor: PREVIEW_ACCENT,
                            backgroundColor: PREVIEW_TINT_HOVER,
                          },
                        }}
                      >
                        {isPreviewPlaying ? "Stop" : "Preview"}
                      </Button>
                    </Tooltip>
                    <Tooltip title="Play live (table hears this)">
                      <Button
                        size="small"
                        onClick={() => {
                          if (item.kind === "track") {
                            const parent =
                              playlists.playlists.byId[item.parent.id];
                            dispatch(
                              startQueue({
                                playlistId: parent.id,
                                tracks: parent.tracks,
                                trackId: item.id,
                              }),
                            );
                            onPlayTrack(playlists.tracks[item.id]);
                          } else onPlaySound(soundboards.sounds[item.id]);
                        }}
                      >
                        Play
                      </Button>
                    </Tooltip>
                  </Stack>
                }
              >
                <ListItemText
                  primary={item.title}
                  secondary={
                    <>
                      <Link
                        component={RouterLink}
                        color="inherit"
                        underline="hover"
                        to={`/${item.kind === "track" ? "playlists" : "soundboards"}/${item.parent.id}`}
                      >
                        {item.parent.title}
                      </Link>
                      {item.tags?.length ? ` • ${item.tags.join(" • ")}` : ""}
                    </>
                  }
                />
              </ListItem>
            );
          })}
        </List>
        <Divider sx={{ my: 2 }} />
        {normalization}
      </CardContent>
    </Card>
  );
}
