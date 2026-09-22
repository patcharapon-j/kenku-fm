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
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";
import { RootState } from "../../app/store";
import { Track } from "../playlists/playlistsSlice";
import { Sound } from "../soundboards/soundboardsSlice";
import { startQueue } from "../playlists/playlistPlaybackSlice";
import { useLibraryFilter } from "./LibraryControls";
import { useNormalizationControls } from "./NormalizationProvider";

export function Library({
  onPlayTrack,
  onPlaySound,
}: {
  onPlayTrack: (track: Track) => void;
  onPlaySound: (sound: Sound) => void;
}) {
  const dispatch = useDispatch();
  const playlists = useSelector((state: RootState) => state.playlists);
  const soundboards = useSelector((state: RootState) => state.soundboards);
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
          {visible.map((item) => (
            <ListItem
              key={item.key}
              secondaryAction={
                <Button
                  onClick={() => {
                    if (item.kind === "track") {
                      const parent = playlists.playlists.byId[item.parent.id];
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
          ))}
        </List>
        <Divider sx={{ my: 2 }} />
        {normalization}
      </CardContent>
    </Card>
  );
}
