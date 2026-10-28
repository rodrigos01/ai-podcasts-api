import {
  Alert,
  Button,
  Checkbox,
  Link as MuiLink,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, bulkApi } from "../api";
import { BulkResult } from "../BulkResult";
import { runAll, useSelection, type BulkOutcome } from "../bulk";
import { ChangeOwnerDialog } from "../ChangeOwnerDialog";
import { ConfirmButton } from "../ConfirmButton";
import { usePodcasts } from "../firestore";

export function PodcastsPage() {
  const [ownerId, setOwnerId] = useState("");
  const [changingOwner, setChangingOwner] = useState(false);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, error, loading: isLoading } = usePodcasts(ownerId);
  const selection = useSelection(data?.map((p) => p.id));
  const allSelected = !!data?.length && selection.ids.length === data.length;

  const run = async (action: () => Promise<BulkOutcome>) => {
    setBusy(true);
    try {
      setOutcome(await action());
      selection.clear();
    } catch (err) {
      setOutcome({ label: "Failed", done: 0, failures: [{ id: "request", message: err instanceof Error ? err.message : String(err) }] });
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = () => run(() => runAll("Deleted", selection.ids, (id) => api(`/${id}`, { method: "DELETE" })));
  const changeOwner = (newOwner: string) =>
    run(async () => {
      const { changed, missing } = await bulkApi<{ changed: string[]; missing: string[] }>("/podcasts/owner", {
        method: "POST",
        body: { podcastIds: selection.ids, ownerId: newOwner },
      });
      return { label: "Owner changed", done: changed.length, failures: missing.map((id) => ({ id, message: "no longer exists" })) };
    });

  return (
    <>
      <Typography variant="h5" gutterBottom>
        Podcasts
      </Typography>
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
        <TextField size="small" label="Filter by owner uid" value={ownerId} onChange={(e) => setOwnerId(e.target.value.trim())} sx={{ width: 360 }} />
        {selection.ids.length > 0 && (
          <>
            <Typography color="text.secondary">{selection.ids.length} selected</Typography>
            <Button variant="outlined" disabled={busy} onClick={() => setChangingOwner(true)}>
              Change owner
            </Button>
            <ConfirmButton
              color="error"
              variant="outlined"
              disabled={busy}
              title={`Delete ${selection.ids.length} podcast${selection.ids.length === 1 ? "" : "s"}?`}
              message="Deletes the selected podcasts with all their episodes, sources and cached audio. This can't be undone."
              onConfirm={() => void deleteSelected()}
            >
              Delete
            </ConfirmButton>
          </>
        )}
      </Stack>
      <BulkResult outcome={outcome} onClose={() => setOutcome(null)} />
      {error && <Alert severity="error">{error.message}</Alert>}
      {changingOwner && (
        <ChangeOwnerDialog count={selection.ids.length} onConfirm={(uid) => void changeOwner(uid)} onClose={() => setChangingOwner(false)} />
      )}
      <Paper>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">
                <Checkbox
                  checked={allSelected}
                  indeterminate={selection.ids.length > 0 && !allSelected}
                  onChange={(e) => selection.setAll(e.target.checked)}
                />
              </TableCell>
              <TableCell>Title</TableCell>
              <TableCell>Hosts</TableCell>
              <TableCell>Owner</TableCell>
              <TableCell>Created</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data?.map((p) => (
              <TableRow key={p.id} hover selected={selection.selected.has(p.id)}>
                <TableCell padding="checkbox">
                  <Checkbox checked={selection.selected.has(p.id)} onChange={() => selection.toggle(p.id)} />
                </TableCell>
                <TableCell>
                  <MuiLink component={Link} to={`/podcasts/${p.id}`}>
                    {p.title}
                  </MuiLink>
                </TableCell>
                <TableCell>{p.hosts.map((h) => h.name).join(", ")}</TableCell>
                <TableCell sx={{ fontFamily: "monospace" }}>{p.ownerId}</TableCell>
                <TableCell>{new Date(p.createdAt).toLocaleString()}</TableCell>
              </TableRow>
            ))}
            {!isLoading && data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5}>No podcasts.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>
    </>
  );
}
