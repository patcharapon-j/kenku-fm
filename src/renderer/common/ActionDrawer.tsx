import React, { useRef, useState } from "react";
import Box from "@mui/material/Box";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import SettingsIcon from "@mui/icons-material/SettingsRounded";
import Badge from "@mui/material/Badge";
import { Toolbar, Stack, Typography, Link } from "@mui/material";
import { OutputListItems } from "../features/output/OutputListItems";
import { OutputMeter } from "../features/output/OutputMeter";
import { InputListItems } from "../features/input/InputListItems";
import { BookmarkListItems } from "../features/bookmarks/BookmarkListItems";
import { Settings } from "../features/settings/Settings";

import { RootState } from "../app/store";
import { useSelector } from "react-redux";

import icon from "../../assets/icon.svg";
import { useHideScrollbar } from "./useHideScrollbar";
import { showWindowControls } from "./showWindowControls";

export const drawerWidth = 240;

export function ActionDrawer() {
  const settings = useSelector((state: RootState) => state.settings);
  const connection = useSelector((state: RootState) => state.connection);
  const encoder = useSelector((state: RootState) => state.capture.encoder);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const hideScrollbar = useHideScrollbar(scrollRef);

  return (
    <Box component="nav" sx={{ width: drawerWidth, flexShrink: 0 }}>
      <Drawer
        variant="permanent"
        sx={{
          "& .MuiDrawer-paper": {
            boxSizing: "border-box",
            width: drawerWidth,
            border: "none",
            bgcolor: "background.default",
            overflowY: "initial",
          },
        }}
        open
      >
        <Toolbar
          sx={{
            justifyContent: showWindowControls ? "space-between" : "end",
            bgcolor: "background.paper",
            px: 1,
            WebkitAppRegion: "drag",
            minHeight: "52px",
          }}
          disableGutters
          variant="dense"
          onDoubleClick={(e) =>
            e.target === e.currentTarget && window.kenku.toggleMaximize()
          }
        >
          {showWindowControls && (
            <Box sx={{ width: "36px", height: "36px", m: 1 }}>
              <img src={icon} />
            </Box>
          )}
          <IconButton
            onClick={() => setSettingsOpen(true)}
            sx={{ WebkitAppRegion: "no-drag" }}
          >
            {/* A software Opus encoder is a problem worth noticing without opening settings */}
            <Badge
              color="warning"
              variant="dot"
              invisible={encoder?.encoding !== "opus-js"}
            >
              <SettingsIcon />
            </Badge>
          </IconButton>
          <Settings
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
          />
        </Toolbar>
        <Box sx={{ overflowY: "auto" }} ref={scrollRef} {...hideScrollbar}>
          <Stack>
            <BookmarkListItems />
            {settings.externalInputsEnabled && <InputListItems />}
            <OutputListItems />
            {connection.status === "disconnected" && (
              <Typography variant="caption" align="center" marginY={2}>
                Connect{" "}
                <Link
                  component="button"
                  variant="caption"
                  onClick={() => setSettingsOpen(true)}
                >
                  Discord
                </Link>{" "}
                for more outputs
              </Typography>
            )}
          </Stack>
        </Box>
        <Box
          sx={{
            mt: "auto",
            flexShrink: 0,
            borderTop: 1,
            borderColor: "divider",
          }}
        >
          <OutputMeter />
        </Box>
      </Drawer>
    </Box>
  );
}
