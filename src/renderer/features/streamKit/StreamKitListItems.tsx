import React, { useEffect, useState } from "react";

import Collapse from "@mui/material/Collapse";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Switch from "@mui/material/Switch";

import ExpandLess from "@mui/icons-material/ExpandLessRounded";
import ExpandMore from "@mui/icons-material/ExpandMoreRounded";
import StreamIcon from "@mui/icons-material/PodcastsRounded";

import { StreamKitState } from "../../../types/streamKit";
import { StreamKitSettings } from "./StreamKitSettings";
import { describeConnection, describeVoice, isProblem } from "./streamKitStatus";

/**
 * The Stream Kit output, beside Discord's in the drawer. The state lives in
 * the main process, which owns the connection, and is mirrored here.
 */
export function StreamKitListItems() {
  const [open, setOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [state, setState] = useState<StreamKitState | null>(null);

  useEffect(() => {
    let mounted = true;
    window.kenku.on("STREAM_KIT_STATE", (args) => {
      setState(args[0]);
    });
    window.kenku.streamKitGetState().then((initial) => {
      if (mounted) {
        setState((current) => current ?? initial);
      }
    });

    return () => {
      mounted = false;
      window.kenku.removeAllListeners("STREAM_KIT_STATE");
    };
  }, []);

  if (!state) {
    return null;
  }

  const live =
    state.enabled &&
    state.connection.status === "connected" &&
    state.voice.status === "publishing";
  const secondary =
    state.connection.status === "connected"
      ? describeVoice(state)
      : describeConnection(state);

  return (
    <>
      <ListItemButton onClick={() => setOpen(!open)}>
        <ListItemText primary="Stream Kit" />
        {open ? <ExpandLess /> : <ExpandMore />}
      </ListItemButton>
      <Collapse in={open} timeout="auto" unmountOnExit>
        <List component="div" disablePadding>
          <ListItem
            disablePadding
            secondaryAction={
              <Switch
                edge="end"
                size="small"
                checked={state.enabled}
                disabled={!state.paired}
                onChange={(e) =>
                  window.kenku.streamKitSetEnabled(e.target.checked)
                }
                inputProps={{ "aria-label": "Stream Kit output" }}
              />
            }
            sx={{ "& .MuiListItemButton-root": { pr: "56px" } }}
          >
            <ListItemButton dense onClick={() => setSettingsOpen(true)}>
              <ListItemIcon
                sx={{
                  minWidth: "36px",
                  color: live ? "primary.main" : undefined,
                }}
              >
                <StreamIcon />
              </ListItemIcon>
              <ListItemText
                primary={
                  state.connection.status === "connected"
                    ? state.connection.campaign.name
                    : state.campaign?.name ?? "GLUniverse"
                }
                secondary={secondary}
                secondaryTypographyProps={{
                  variant: "caption",
                  color: isProblem(state) ? "error" : "text.secondary",
                  sx: {
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  },
                }}
              />
            </ListItemButton>
          </ListItem>
        </List>
      </Collapse>
      <StreamKitSettings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        state={state}
      />
    </>
  );
}
