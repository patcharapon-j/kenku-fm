import React, { useEffect, useRef, useState } from "react";

import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import {
  CaptureLevels,
  dbToMeterPercent,
  MAX_REDUCTION_DB,
  METER_FLOOR_DB,
  peakToDb,
} from "../../common/audioCapture";

/** Levels arrive at roughly 15Hz, so a longer gap than this means nothing is being captured */
const LEVELS_TIMEOUT = 1000;
/** Hold a clip long enough that a single spike is still noticed after the fact */
const CLIP_HOLD = 1500;
/** Slow enough to read a peak, fast enough to follow a mix */
const DECAY_DB_PER_SECOND = 48;

const METER_HEIGHT = "6px";

function MeterBar({
  label,
  maskRef,
}: {
  label: string;
  maskRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <Stack direction="row" alignItems="center" spacing={1}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ width: "8px" }}
      >
        {label}
      </Typography>
      <Box
        sx={(theme) => ({
          position: "relative",
          flexGrow: 1,
          height: METER_HEIGHT,
          borderRadius: METER_HEIGHT,
          overflow: "hidden",
          // Colour by position rather than by level so the warning and clip zones stay put
          background: `linear-gradient(90deg, ${theme.palette.success.main} 0%, ${theme.palette.success.main} 80%, ${theme.palette.warning.main} 80%, ${theme.palette.warning.main} 95%, ${theme.palette.error.main} 95%)`,
        })}
      >
        <Box
          ref={maskRef}
          sx={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 0,
            width: "100%",
            bgcolor: "rgba(0, 0, 0, 0.72)",
          }}
        />
      </Box>
    </Stack>
  );
}

export function OutputMeter() {
  const [capturing, setCapturing] = useState(false);

  const levelsRef = useRef<{ levels: CaptureLevels; time: number } | null>(
    null,
  );
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLSpanElement>(null);
  const reductionRef = useRef<HTMLDivElement>(null);
  const reductionTextRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    window.kenku.on("AUDIO_CAPTURE_LEVELS", (args) => {
      const levels: CaptureLevels = args[0];
      levelsRef.current = { levels, time: performance.now() };
    });

    return () => {
      window.kenku.removeAllListeners("AUDIO_CAPTURE_LEVELS");
    };
  }, []);

  // Levels arrive far too often to put through the store, so the meter is drawn straight onto
  // the nodes and only the coarse capturing state is allowed to re-render
  useEffect(() => {
    let request: number;
    let previousTime = performance.now();
    let leftDb = METER_FLOOR_DB;
    let rightDb = METER_FLOOR_DB;
    let clipUntil = 0;
    let live = false;

    function draw() {
      request = requestAnimationFrame(draw);

      const time = performance.now();
      const decay = (DECAY_DB_PER_SECOND * (time - previousTime)) / 1000;
      previousTime = time;

      const latest = levelsRef.current;
      const receiving = latest !== null && time - latest.time < LEVELS_TIMEOUT;
      if (receiving !== live) {
        live = receiving;
        setCapturing(receiving);
      }

      leftDb = Math.max(leftDb - decay, METER_FLOOR_DB);
      rightDb = Math.max(rightDb - decay, METER_FLOOR_DB);

      let reduction = 0;
      if (receiving) {
        leftDb = Math.max(leftDb, peakToDb(latest.levels.peakLeft));
        rightDb = Math.max(rightDb, peakToDb(latest.levels.peakRight));
        reduction = latest.levels.reduction;
        if (latest.levels.clipped) {
          clipUntil = time + CLIP_HOLD;
        }
      } else {
        clipUntil = 0;
      }

      if (leftRef.current) {
        leftRef.current.style.width = `${100 - dbToMeterPercent(leftDb)}%`;
      }
      if (rightRef.current) {
        rightRef.current.style.width = `${100 - dbToMeterPercent(rightDb)}%`;
      }
      if (clipRef.current) {
        clipRef.current.style.opacity = time < clipUntil ? "1" : "0.15";
      }
      if (reductionRef.current) {
        const amount = Math.min(-reduction / MAX_REDUCTION_DB, 1);
        reductionRef.current.style.width = `${Math.max(amount, 0) * 100}%`;
      }
      if (reductionTextRef.current) {
        // Guard against a negative zero reading as "-0.0"
        const amount = reduction > -0.05 ? 0 : reduction;
        reductionTextRef.current.textContent = `${amount.toFixed(1)} dB`;
      }
    }

    request = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(request);
    };
  }, []);

  return (
    <Stack px={2} py={1} spacing={0.5}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <Box
            sx={{
              width: "6px",
              height: "6px",
              borderRadius: "3px",
              bgcolor: capturing ? "success.main" : "text.disabled",
            }}
          />
          <Typography variant="caption" color="text.secondary">
            {capturing ? "Capturing" : "Not capturing"}
          </Typography>
        </Stack>
        <Typography
          ref={clipRef}
          variant="caption"
          sx={{ color: "error.main", opacity: 0.15 }}
        >
          CLIP
        </Typography>
      </Stack>
      <Stack spacing={0.5} sx={{ opacity: capturing ? 1 : 0.35 }}>
        <MeterBar label="L" maskRef={leftRef} />
        <MeterBar label="R" maskRef={rightRef} />
        {/* Gain reduction, so the limiter can be seen holding the mix down */}
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="caption" color="text.secondary">
            Limiter
          </Typography>
          <Box
            sx={{
              flexGrow: 1,
              height: METER_HEIGHT,
              borderRadius: METER_HEIGHT,
              overflow: "hidden",
              bgcolor: "rgba(0, 0, 0, 0.72)",
            }}
          >
            <Box
              ref={reductionRef}
              sx={{ width: 0, height: "100%", bgcolor: "warning.main" }}
            />
          </Box>
          <Typography
            ref={reductionTextRef}
            variant="caption"
            color="text.secondary"
            sx={{ textAlign: "right" }}
          >
            0.0 dB
          </Typography>
        </Stack>
      </Stack>
    </Stack>
  );
}
