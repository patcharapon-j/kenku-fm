import React from "react";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Box from "@mui/material/Box";
import FormControl from "@mui/material/FormControl";
import Input from "@mui/material/Input";
import InputAdornment from "@mui/material/InputAdornment";
import FormHelperText from "@mui/material/FormHelperText";

import { useDispatch, useSelector } from "react-redux";
import { RootState } from "../../app/store";
import { adjustCrossfade } from "../playlists/playlistPlaybackSlice";

type PlaybackSettingsProps = {
  open: boolean;
  onClose: () => void;
};

export function PlaybackSettings({ open, onClose }: PlaybackSettingsProps) {
  const dispatch = useDispatch();
  const crossfade = useSelector(
    (state: RootState) => state.playlistPlayback.crossfade,
  );

  function handleCrossfadeChange(event: React.ChangeEvent<HTMLInputElement>) {
    const num = Number.parseInt(event.target.value);
    dispatch(adjustCrossfade(isNaN(num) ? 0 : Math.max(num, 0)));
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    onClose();
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogTitle>Playback Settings</DialogTitle>
      <form onSubmit={handleSubmit}>
        <DialogContent>
          <Box sx={{ display: "flex", gap: 1, my: 1 }}>
            <FormControl variant="standard" fullWidth>
              <FormHelperText id="crossfade-helper-text">
                Crossfade, 0 to disable
              </FormHelperText>
              <Input
                margin="dense"
                fullWidth
                autoComplete="off"
                id="crossfade"
                value={`${crossfade}`}
                onChange={handleCrossfadeChange}
                endAdornment={
                  <InputAdornment position="end">ms</InputAdornment>
                }
                aria-describedby="crossfade-helper-text"
                inputProps={{
                  "aria-label": "crossfade",
                  inputMode: "numeric",
                  pattern: "[0-9]*",
                }}
              />
            </FormControl>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button type="submit">Done</Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
