import React from "react";
import { useSelector } from "react-redux";

import Paper from "@mui/material/Paper";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";

import { RootState } from "../../app/store";
import { SoundboardPlayer } from "./SoundboardPlayer";
import { PlaylistPlayer } from "./PlaylistPlayer";
import {
  LiveDeckBanner,
  PreviewDeck,
  PreviewDeckProps,
} from "../preview/PreviewDeck";

type PlayerProps = {
  onPlaylistNext: () => void;
  onPlaylistPrevious: () => void;
  onPlaylistSeek: (to: number) => void;
  onSoundboardStop: (id: string) => void;
  preview: PreviewDeckProps;
};

export function Player({
  onPlaylistNext,
  onPlaylistPrevious,
  onPlaylistSeek,
  onSoundboardStop,
  preview,
}: PlayerProps) {
  const previewOpen = useSelector((state: RootState) =>
    Boolean(state.preview.item),
  );

  return (
    <Container
      sx={{
        position: "fixed",
        bottom: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 10,
      }}
      maxWidth="md"
    >
      <Stack spacing={1.25}>
        <PreviewDeck {...preview} />
        <Paper
          elevation={8}
          sx={{
            width: "100%",
            display: "flex",
            flexDirection: "column",
            p: 2,
            ...(previewOpen && {
              border: "1px solid rgba(187, 153, 255, 0.35)",
            }),
          }}
        >
          {previewOpen && <LiveDeckBanner />}
          <SoundboardPlayer onSoundboardStop={onSoundboardStop} />
          <PlaylistPlayer
            onPlaylistNext={onPlaylistNext}
            onPlaylistPrevious={onPlaylistPrevious}
            onPlaylistSeek={onPlaylistSeek}
          />
        </Paper>
      </Stack>
    </Container>
  );
}
