import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useSelector } from "react-redux";
import Snackbar from "@mui/material/Snackbar";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { RootState, store } from "../../app/store";
import { editTrack } from "../playlists/playlistsSlice";
import { editSound } from "../soundboards/soundboardsSlice";

type Item = {
  id: string;
  title: string;
  url: string;
  normalization?: { source: string; version: number };
  kind: "track" | "sound";
};
/** A file waiting for a free slot in the pool */
type Job = { key: string; item: Item; bulk: boolean; generation: number };
const Context = createContext<React.ReactNode>(null);
export const useNormalizationControls = () => useContext(Context);
const needsProcessing = (item: Item) =>
  item.url.startsWith("file://") &&
  !(
    item.normalization?.version === 1 && item.normalization.source === item.url
  );

export function NormalizationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const tracks = useSelector((state: RootState) => state.playlists.tracks);
  const sounds = useSelector((state: RootState) => state.soundboards.sounds);
  const items: Item[] = [
    ...Object.values(tracks).map((item) => ({
      ...item,
      kind: "track" as const,
    })),
    ...Object.values(sounds).map((item) => ({
      ...item,
      kind: "sound" as const,
    })),
  ];
  const unprocessed = items.filter(needsProcessing);
  const previous = useRef<Map<string, string>>();
  const jobs = useRef(new Set<string>());
  const waiting = useRef<Job[]>([]);
  const running = useRef(0);
  // The main process decides how many files it will work on at once. Until it
  // answers, stay with one so a drop never starts more than it can run.
  const concurrency = useRef(1);
  const [pending, setPending] = useState(0);
  const [current, setCurrent] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [offer, setOffer] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const batchGeneration = useRef(0);

  useEffect(() => {
    let stale = false;
    window.player
      .normalizationConcurrency()
      .then((count) => {
        if (stale) return;
        concurrency.current = Math.max(1, Math.floor(count) || 1);
        // A drop may already be queued behind the old limit of one
        pump();
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  async function process(job: Job) {
    const { item } = job;
    try {
      if (job.bulk && job.generation !== batchGeneration.current) return;
      const before =
        item.kind === "track"
          ? store.getState().playlists.tracks[item.id]
          : store.getState().soundboards.sounds[item.id];
      if (!before || before.url !== item.url) return;
      setCurrent((titles) => ({ ...titles, [job.key]: item.title }));
      const normalization = await window.player.normalizeAudio(item.url);
      const latest =
        item.kind === "track"
          ? store.getState().playlists.tracks[item.id]
          : store.getState().soundboards.sounds[item.id];
      if (!latest || latest.url !== item.url) return;
      store.dispatch(
        item.kind === "track"
          ? editTrack({ id: item.id, normalization })
          : editSound({ id: item.id, normalization }),
      );
    } catch (error) {
      setErrors((messages) => [
        ...messages,
        `${item.title}: ${error instanceof Error ? error.message : "Processing failed"}`,
      ]);
    }
  }

  /** Start as many queued files as the pool allows */
  function pump() {
    while (running.current < concurrency.current && waiting.current.length) {
      const job = waiting.current.shift();
      running.current++;
      void process(job).finally(() => {
        running.current--;
        jobs.current.delete(job.key);
        setPending((count) => count - 1);
        setCurrent(({ [job.key]: _done, ...rest }) => rest);
        pump();
      });
    }
  }

  function enqueue(list: Item[], bulk = false) {
    const generation = batchGeneration.current;
    if (list.some(needsProcessing)) setCancelled(false);
    for (const item of list.filter(needsProcessing)) {
      const key = `${item.kind}:${item.id}:${item.url}`;
      if (jobs.current.has(key)) continue;
      jobs.current.add(key);
      setPending((count) => count + 1);
      waiting.current.push({ key, item, bulk, generation });
    }
    pump();
  }

  /** Drop the queued bulk files. Ones already running are left to finish. */
  function cancelBulk() {
    batchGeneration.current++;
    const remaining = waiting.current.filter((job) => !job.bulk);
    const dropped = waiting.current.length - remaining.length;
    for (const job of waiting.current) {
      if (job.bulk) jobs.current.delete(job.key);
    }
    waiting.current = remaining;
    if (dropped) setPending((count) => count - dropped);
    setCancelled(true);
  }

  useEffect(() => {
    const next = new Map(
      items.map((item) => [`${item.kind}:${item.id}`, item.url]),
    );
    if (!previous.current) {
      setOffer(unprocessed.length > 0);
    } else {
      enqueue(
        items.filter(
          (item) =>
            previous.current.get(`${item.kind}:${item.id}`) !== item.url,
        ),
      );
    }
    previous.current = next;
  }, [tracks, sounds]);

  const active = Object.values(current);
  const activeLabel =
    active.length === 0
      ? "audio"
      : active.length === 1
        ? active[0]
        : `${active[0]} and ${active.length - 1} more`;

  const controls = (
    <Stack spacing={1}>
      <Typography variant="subtitle1">Audio leveling</Typography>
      <Typography variant="body2">
        New local files are processed automatically, several at a time.
        Originals stay unchanged. Playback copies use a fixed level for the
        whole track, preserving its dynamics.
      </Typography>
      {pending > 0 ? (
        <>
          <LinearProgress />
          <Typography variant="body2">
            Processing {activeLabel} • {pending} remaining
          </Typography>
          <Button onClick={cancelBulk}>Cancel remaining bulk processing</Button>
        </>
      ) : (
        <Button
          disabled={!unprocessed.length}
          onClick={() => {
            setErrors([]);
            enqueue(unprocessed, true);
          }}
        >
          Process existing audio ({unprocessed.length})
        </Button>
      )}
      {cancelled && (
        <Typography variant="caption">
          Bulk processing will stop after the files already in progress. New
          imports still process automatically.
        </Typography>
      )}
      {errors.length > 0 && (
        <Alert severity="warning" onClose={() => setErrors([])}>
          {errors.join("\n")}
        </Alert>
      )}
    </Stack>
  );
  return (
    <Context.Provider value={controls}>
      {children}
      <Snackbar
        open={pending > 0}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
      >
        <Alert severity="info">
          Processing audio: {pending} remaining. Progress and cancellation are
          available in All audio.
        </Alert>
      </Snackbar>
      <Dialog open={offer} onClose={() => setOffer(false)}>
        <DialogTitle>Level your existing audio?</DialogTitle>
        <DialogContent>
          <Typography>
            {unprocessed.length} local audio files have not been processed.
            Create lossless playback copies with consistent loudness while
            keeping each track's dynamics and original file. Copies use
            additional disk space. You can do this later from All audio.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOffer(false)}>Later</Button>
          <Button
            onClick={() => {
              setOffer(false);
              enqueue(unprocessed, true);
            }}
          >
            Process existing audio
          </Button>
        </DialogActions>
      </Dialog>
    </Context.Provider>
  );
}
