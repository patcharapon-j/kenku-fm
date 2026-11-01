import React, { useEffect, useState } from "react";

import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import TextField from "@mui/material/TextField";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import Alert from "@mui/material/Alert";

import { StreamKitState } from "../../../types/streamKit";
import { showWindowControls } from "../../common/showWindowControls";
import { describeConnection, describeVoice } from "./streamKitStatus";

type StreamKitSettingsProps = {
  open: boolean;
  onClose: () => void;
  state: StreamKitState;
};

/** Pairing codes look like `ABCD-EFGH` */
const CODE_PATTERN = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/i;

export function StreamKitSettings({
  open,
  onClose,
  state,
}: StreamKitSettingsProps) {
  const [url, setURL] = useState(state.url);
  const [code, setCode] = useState("");

  // The saved address can change under the dialog, from a pairing that went
  // through, so the field follows it whenever the dialog is opened
  useEffect(() => {
    if (open) {
      setURL(state.url);
    }
  }, [open, state.url]);

  const pairing =
    state.connection.status === "connecting" && state.connection.pairing;

  function handlePair() {
    window.kenku.streamKitPair(url.trim(), code.trim());
    setCode("");
  }

  function handleUnpair() {
    window.kenku.streamKitUnpair();
  }

  function handleEnabledChange(event: React.ChangeEvent<HTMLInputElement>) {
    window.kenku.streamKitSetEnabled(event.target.checked);
  }

  const problem =
    state.connection.status === "refused" ||
    state.connection.status === "failed"
      ? state.connection.reason
      : null;

  const pairingForm = (
    <Stack spacing={1}>
      <TextField
        margin="dense"
        size="small"
        label="Stream Kit address"
        fullWidth
        variant="standard"
        autoComplete="off"
        InputLabelProps={{ shrink: true }}
        value={url}
        onChange={(e) => setURL(e.target.value)}
        disabled={pairing}
      />
      <TextField
        margin="dense"
        size="small"
        label="Pairing code"
        placeholder="XXXX-XXXX"
        fullWidth
        variant="standard"
        autoComplete="off"
        InputLabelProps={{ shrink: true }}
        inputProps={{ style: { textTransform: "uppercase" } }}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && CODE_PATTERN.test(code.trim()) && url.trim()) {
            handlePair();
          }
        }}
        disabled={pairing}
        helperText="Copy it from the Stream Kit console"
      />
      <Button
        disabled={pairing || !url.trim() || !CODE_PATTERN.test(code.trim())}
        onClick={handlePair}
        fullWidth
        variant="outlined"
        size="small"
      >
        {pairing ? <CircularProgress size={24} /> : "Pair"}
      </Button>
    </Stack>
  );

  const pairedDetails = (
    <Stack spacing={1.5}>
      <Stack>
        <Typography variant="caption" color="text.secondary">
          Stream Kit
        </Typography>
        <Typography variant="body2">{describeConnection(state)}</Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ wordBreak: "break-all" }}
        >
          {state.url}
        </Typography>
      </Stack>
      <Stack>
        <Typography variant="caption" color="text.secondary">
          Voice Room
        </Typography>
        <Typography variant="body2">{describeVoice(state)}</Typography>
      </Stack>
      <Button
        onClick={handleUnpair}
        fullWidth
        variant="outlined"
        color="error"
        size="small"
      >
        Unpair
      </Button>
    </Stack>
  );

  return (
    <Dialog fullScreen sx={{ width: 240 }} open={open} onClose={onClose}>
      <DialogTitle
        sx={{
          textAlign: showWindowControls ? "left" : "right",
          py: showWindowControls ? 2 : 1.5,
        }}
      >
        Stream Kit
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          <DialogContentText variant="caption">
            Sends Music and SFX to the Campaign&apos;s Voice Room on the
            GLUniverse Stream Kit as two separate tracks, and lets the Stream
            Kit console control playback.
          </DialogContentText>
          {problem && <Alert severity="error">{problem}</Alert>}
          {state.paired ? pairedDetails : pairingForm}
          <Divider />
          <Stack>
            <Typography variant="caption" color="text.secondary">
              Outputs
            </Typography>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={state.enabled}
                  onChange={handleEnabledChange}
                />
              }
              label={<Typography variant="body2">Stream Kit</Typography>}
            />
            <Typography variant="body2" sx={{ mt: 1 }}>
              Discord: {state.discord ? "On" : "Off"}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Discord follows the voice channels picked under Outputs, with or
              without the Stream Kit.
            </Typography>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}
