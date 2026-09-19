import React, { useState, useEffect } from "react";

import Collapse from "@mui/material/Collapse";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";

import ExpandLess from "@mui/icons-material/ExpandLessRounded";
import ExpandMore from "@mui/icons-material/ExpandMoreRounded";

import { RootState } from "../../app/store";
import { useSelector, useDispatch } from "react-redux";
import {
  addInput,
  removeInput,
  setDevices,
  setInput,
  setInputGain,
} from "./inputSlice";

import { InputListItem } from "./InputListItem";
import { UNITY_GAIN } from "../../common/audioCapture";

export function InputListItems() {
  const [open, setOpen] = useState(true);

  function toggleOpen() {
    setOpen(!open);
  }

  const input = useSelector((state: RootState) => state.input);
  const settings = useSelector((state: RootState) => state.settings);
  const dispatch = useDispatch();

  useEffect(() => {
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      const audioDevices = devices
        .filter((d) => d.kind === "audioinput")
        .map((device) => ({ id: device.deviceId, label: device.label }));
      dispatch(setDevices(audioDevices));
    });

    return () => {
      // Stop all input devices when external inputs is disabled
      navigator.mediaDevices.enumerateDevices().then((devices) => {
        const ids = devices
          .filter((d) => d.kind === "audioinput")
          .map((device) => device.deviceId);
        for (let id of ids) {
          window.kenku.stopExternalAudioCapture(id);
        }
        dispatch(setDevices([]));
        dispatch(setInput([]));
      });
    };
  }, []);

  // A device starts at unity until the capture side is told otherwise, so the stored level
  // follows every start of its stream
  function startCapture(deviceId: string) {
    window.kenku.startExternalAudioCapture(deviceId);
    window.kenku.setExternalGain(deviceId, input.gains[deviceId] ?? UNITY_GAIN);
  }

  function handleGainChange(deviceId: string, gain: number) {
    dispatch(setInputGain({ deviceId, gain }));
    window.kenku.setExternalGain(deviceId, gain);
  }

  function handleInputChange(deviceId: string) {
    if (settings.multipleInputsEnabled) {
      // Already selected
      if (input.inputs.includes(deviceId)) {
        dispatch(removeInput(deviceId));
        window.kenku.stopExternalAudioCapture(deviceId);
      } else {
        dispatch(addInput(deviceId));
        startCapture(deviceId);
      }
    } else {
      const prev = input.inputs[0];

      // Stop audio if we select the device again
      if (prev === deviceId) {
        dispatch(removeInput(deviceId));
        window.kenku.stopExternalAudioCapture(deviceId);
        return; // Return early to prevent new capture
      } else if (prev) {
        // Stop previous audio capture
        dispatch(removeInput(prev));
        window.kenku.stopExternalAudioCapture(prev);
      }
      // Start new capture
      dispatch(addInput(deviceId));
      startCapture(deviceId);
    }
  }

  return (
    <>
      <ListItemButton onClick={toggleOpen}>
        <ListItemText
          primary={settings.multipleInputsEnabled ? "Inputs" : "Input"}
        />
        {open ? <ExpandLess /> : <ExpandMore />}
      </ListItemButton>
      <Collapse in={open} timeout="auto" unmountOnExit>
        <List component="div" disablePadding>
          {input.devices.map((device) => (
            <InputListItem
              key={device.id}
              device={device}
              selected={input.inputs.includes(device.id)}
              tick={
                settings.multipleInputsEnabled &&
                input.inputs.includes(device.id)
              }
              gain={input.gains[device.id] ?? UNITY_GAIN}
              onClick={handleInputChange}
              onGainChange={handleGainChange}
            />
          ))}
        </List>
      </Collapse>
    </>
  );
}
