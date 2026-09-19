import React from "react";

import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Select, { SelectChangeEvent } from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import Slider from "@mui/material/Slider";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import { RootState } from "../../app/store";
import { useSelector, useDispatch } from "react-redux";
import { setMonitorDeviceId, setMonitorGain } from "./outputSlice";

import { showWindowControls } from "../../common/showWindowControls";

type MonitorSettingsProps = {
  open: boolean;
  onClose: () => void;
};

export function MonitorSettings({ open, onClose }: MonitorSettingsProps) {
  const output = useSelector((state: RootState) => state.output);
  const dispatch = useDispatch();

  function handleGainChange(_: Event, value: number | number[]) {
    const gain = value as number;
    dispatch(setMonitorGain(gain));
    window.kenku.setMonitorGain(gain);
  }

  function handleDeviceChange(event: SelectChangeEvent) {
    const deviceId = event.target.value;
    dispatch(setMonitorDeviceId(deviceId));
    window.kenku.setMonitorDevice(deviceId);
  }

  return (
    <Dialog fullScreen sx={{ width: 240 }} open={open} onClose={onClose}>
      <DialogTitle
        sx={{
          textAlign: showWindowControls ? "left" : "right",
          py: showWindowControls ? 2 : 1.5,
        }}
      >
        Monitor
      </DialogTitle>
      <DialogContent>
        <DialogContentText variant="caption">
          Monitoring plays the mix back on this computer. It doesn&apos;t change
          what Discord receives.
        </DialogContentText>
        <Stack mt={2}>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="caption">Volume</Typography>
            <Typography variant="caption" color="text.secondary">
              {Math.round(output.monitorGain * 100)}%
            </Typography>
          </Stack>
          <Slider
            aria-label="Monitor Volume"
            size="small"
            value={output.monitorGain}
            min={0}
            max={1}
            step={0.01}
            onChange={handleGainChange}
          />
        </Stack>
        <FormControl fullWidth variant="standard" margin="dense">
          <InputLabel id="monitor-device-select-label">Device</InputLabel>
          <Select
            labelId="monitor-device-select-label"
            label="Device"
            value={output.monitorDeviceId}
            onChange={handleDeviceChange}
          >
            <MenuItem value="">System Default</MenuItem>
            {output.monitorDevices.map((device, index) => (
              <MenuItem key={device.id} value={device.id}>
                {/* Labels are blank until media access has been granted at least once */}
                {device.label || `Output ${index + 1}`}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </DialogContent>
      <DialogActions sx={{ p: 2 }}>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}
