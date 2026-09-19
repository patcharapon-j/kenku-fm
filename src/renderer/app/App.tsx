import React, { useEffect, useRef, useState } from "react";

import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import styled from "@mui/material/styles/styled";
import Alert from "@mui/material/Alert";

import { ActionDrawer } from "../common/ActionDrawer";

import { Tabs } from "../features/tabs/Tabs";

import icon from "../../assets/icon.svg";

import "./App.css";
import Typography from "@mui/material/Typography";

const WallPaper = styled("div")({
  position: "absolute",
  width: "100%",
  height: "100%",
  top: 0,
  left: 0,
  overflow: "hidden",
  background: "linear-gradient(#2D3143 0%, #1e2231 100%)",
  zIndex: -1,
});

/** A capture warning repeats every time the stream restarts, so hold each one back for a while */
const WARNING_REPEAT_TIMEOUT = 60000;

export function App() {
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const [fatalError, setFatalError] = useState<string>();

  const warningTimes = useRef<Record<string, number>>({});

  useEffect(() => {
    window.kenku.on("MESSAGE", (args) => {
      const message = args[0];
      setMessage(message);
    });
    window.kenku.on("ERROR", (args) => {
      const error = args[0];
      setError(error);
    });
    window.kenku.on("FATAL_ERROR", (args) => {
      const error = args[0];
      setFatalError(error);
    });
    window.kenku.on("AUDIO_CAPTURE_WARNING", (args) => {
      const warning = args[0];
      const time = Date.now();
      const shown = warningTimes.current[warning];
      if (shown !== undefined && time - shown < WARNING_REPEAT_TIMEOUT) {
        return;
      }
      warningTimes.current[warning] = time;
      setWarning(warning);
    });

    return () => {
      window.kenku.removeAllListeners("MESSAGE");
      window.kenku.removeAllListeners("ERROR");
      window.kenku.removeAllListeners("FATAL_ERROR");
      window.kenku.removeAllListeners("AUDIO_CAPTURE_WARNING");
    };
  }, []);

  if (fatalError) {
    return (
      <Stack direction="row">
        <WallPaper />
        <Stack
          position="absolute"
          left="0"
          right="0"
          width="100%"
          height="100%"
          alignItems="center"
          justifyContent="center"
          gap={1}
        >
          <Stack sx={{ width: "68px", height: "68px", m: 1 }}>
            <img src={icon} />
          </Stack>
          <Typography variant="h4" color="white">
            Oops, something went wrong..
          </Typography>
          <Typography variant="body1" color="white">
            {fatalError}
          </Typography>
        </Stack>
      </Stack>
    );
  }

  return (
    <Stack direction="row">
      <WallPaper />
      <ActionDrawer />
      <Tabs />
      <Snackbar
        open={Boolean(message)}
        autoHideDuration={4000}
        onClose={() => setMessage(undefined)}
        message={message}
        sx={{ maxWidth: "192px" }}
      />
      <Snackbar
        open={Boolean(error)}
        autoHideDuration={8000}
        onClose={() => setError(undefined)}
        sx={{ maxWidth: "192px" }}
      >
        <Alert severity="error">{error}</Alert>
      </Snackbar>
      <Snackbar
        open={Boolean(warning)}
        autoHideDuration={8000}
        onClose={() => setWarning(undefined)}
        sx={{ maxWidth: "192px" }}
      >
        <Alert severity="warning">{warning}</Alert>
      </Snackbar>
    </Stack>
  );
}
