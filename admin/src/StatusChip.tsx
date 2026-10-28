import { Chip } from "@mui/material";
import type { Episode } from "./types";

/** An episode's status; a "generating" one with no progress yet is waiting its turn. */
export function StatusChip({ episode }: { episode: Pick<Episode, "status" | "progress" | "redraftPending"> }) {
  if (episode.status === "generating") {
    const queued = !episode.progress;
    const label = queued ? "queued" : episode.redraftPending ? "re-drafting" : "generating";
    return <Chip size="small" label={label} color="warning" variant={queued ? "outlined" : "filled"} />;
  }
  return <Chip size="small" label={episode.status} color={episode.status === "failed" ? "error" : "success"} />;
}
