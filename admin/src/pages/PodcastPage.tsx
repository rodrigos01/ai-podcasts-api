import { Alert, Box, Button, Checkbox, Link as MuiLink, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from "@mui/material";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, bulkApi } from "../api";
import { BulkResult } from "../BulkResult";
import { runAll, useSelection, type BulkOutcome } from "../bulk";
import { RegenerateDialog } from "../RegenerateDialog";
import { StatusChip } from "../StatusChip";
import { ConfirmButton } from "../ConfirmButton";
import { EditDialog } from "../EditDialog";
import { useEpisodes, usePodcast, useSources } from "../firestore";

export function PodcastPage() {
  const { podcastId = "" } = useParams();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceText, setSourceText] = useState("");

  const podcast = usePodcast(podcastId);
  const episodes = useEpisodes(podcastId);
  const sources = useSources(podcastId);
  const selection = useSelection(episodes.data?.map((e) => e.id));
  const allSelected = !!episodes.data?.length && selection.ids.length === episodes.data.length;
  const [regenerating, setRegenerating] = useState(false);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  const runBulk = async (action: () => Promise<BulkOutcome>) => {
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
  const episodeBase = (id: string) => `/${podcastId}/episodes/${id}`;
  const deleteEpisodes = () => runBulk(() => runAll("Deleted", selection.ids, (id) => api(episodeBase(id), { method: "DELETE" })));
  const regenerateAudio = () =>
    runBulk(() => runAll("Audio reset", selection.ids, (id) => api(`${episodeBase(id)}/audio`, { method: "DELETE" })));
  const regenerateEpisodes = (redraft: boolean) =>
    runBulk(async () => {
      const { order } = await bulkApi<{ order: string[] }>("/episodes/regenerate", {
        method: "POST",
        body: { podcastId, episodeIds: selection.ids, redraft },
      });
      return { label: `Queued ${redraft ? "(with re-draft) " : ""}in series order`, done: order.length, failures: [] };
    });

  const update = useMutation({
    mutationFn: (body: Record<string, string>) => api(`/${podcastId}`, { method: "PATCH", body }),
  });
  const remove = useMutation({
    mutationFn: () => api(`/${podcastId}`, { method: "DELETE" }),
    onSuccess: () => navigate("/"),
  });
  const addSource = useMutation({
    mutationFn: () => api(`/${podcastId}/sources`, { method: "POST", body: { title: sourceTitle, contents: sourceText } }),
    onSuccess: () => {
      setSourceTitle("");
      setSourceText("");
    },
  });
  const removeSource = useMutation({
    mutationFn: (id: string) => api(`/${podcastId}/sources/${id}`, { method: "DELETE" }),
  });

  const p = podcast.data;
  const error = podcast.error ?? episodes.error ?? sources.error ?? update.error ?? remove.error ?? addSource.error ?? removeSource.error;

  return (
    <Stack spacing={3}>
      {error && <Alert severity="error">{error.message}</Alert>}
      {p && (
        <Paper sx={{ p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="start">
            <Box>
              <Typography variant="h5">{p.title}</Typography>
              <Typography color="text.secondary" sx={{ fontFamily: "monospace" }}>
                {p.id} · owner {p.ownerId}
              </Typography>
            </Box>
            <Stack direction="row" spacing={1}>
              <Button variant="outlined" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <ConfirmButton
                color="error"
                variant="outlined"
                title="Delete podcast?"
                message={`Deletes "${p.title}" with all its episodes, sources and cached audio. This can't be undone.`}
                onConfirm={() => remove.mutate()}
              >
                Delete
              </ConfirmButton>
            </Stack>
          </Stack>
          <Typography sx={{ mt: 2 }}>{p.description}</Typography>
          <Typography variant="subtitle2" sx={{ mt: 2 }}>
            Structure
          </Typography>
          <Typography sx={{ whiteSpace: "pre-wrap" }}>{p.structure}</Typography>
          <Typography variant="subtitle2" sx={{ mt: 2 }}>
            Hosts
          </Typography>
          {p.hosts.map((h) => (
            <Typography key={h.id}>
              <b>{h.name}</b>: {h.persona}
              {h.accent ? ` (${h.accent})` : ""}
            </Typography>
          ))}
          {editing && (
            <EditDialog
              title="Edit podcast"
              fields={[
                { key: "title", label: "Title" },
                { key: "description", label: "Description", multiline: true },
                { key: "structure", label: "Structure", multiline: true },
              ]}
              values={{ title: p.title, description: p.description, structure: p.structure }}
              onSave={(changes) => update.mutate(changes)}
              onClose={() => setEditing(false)}
            />
          )}
        </Paper>
      )}

      <Box>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="h6">Episodes</Typography>
          {selection.ids.length > 0 && (
            <>
              <Typography color="text.secondary">{selection.ids.length} selected</Typography>
              <Button variant="outlined" disabled={busy} onClick={() => setRegenerating(true)}>
                Regenerate
              </Button>
              <ConfirmButton
                variant="outlined"
                disabled={busy}
                title="Regenerate audio?"
                message="Deletes the cached audio of the selected episodes; it is synthesized again the next time each is played. This spends TTS quota."
                onConfirm={() => void regenerateAudio()}
              >
                Regenerate audio
              </ConfirmButton>
              <ConfirmButton
                color="error"
                variant="outlined"
                disabled={busy}
                title={`Delete ${selection.ids.length} episode${selection.ids.length === 1 ? "" : "s"}?`}
                message="Deletes the selected episodes and their audio. This can't be undone."
                onConfirm={() => void deleteEpisodes()}
              >
                Delete
              </ConfirmButton>
            </>
          )}
        </Stack>
        <BulkResult outcome={outcome} onClose={() => setOutcome(null)} />
        {regenerating && (
          <RegenerateDialog
            count={selection.ids.length}
            onConfirm={(redraft) => void regenerateEpisodes(redraft)}
            onClose={() => setRegenerating(false)}
          />
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
                <TableCell>Length</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Created</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {episodes.data?.map((e) => (
                <TableRow key={e.id} hover selected={selection.selected.has(e.id)}>
                  <TableCell padding="checkbox">
                    <Checkbox checked={selection.selected.has(e.id)} onChange={() => selection.toggle(e.id)} />
                  </TableCell>
                  <TableCell>
                    <MuiLink component={Link} to={`/podcasts/${podcastId}/episodes/${e.id}`}>
                      {e.title}
                    </MuiLink>
                  </TableCell>
                  <TableCell>{e.length}</TableCell>
                  <TableCell>
                    <StatusChip episode={e} />
                  </TableCell>
                  <TableCell>{new Date(e.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      </Box>

      <Box>
        <Typography variant="h6" gutterBottom>
          Sources
        </Typography>
        <Paper sx={{ p: 2 }}>
          {sources.data?.map((s) => (
            <Stack key={s.id} direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography>
                {s.title} <Typography component="span" color="text.secondary">({s.sourceType}, {s.contents.length.toLocaleString()} chars)</Typography>
              </Typography>
              <ConfirmButton size="small" color="error" title="Delete source?" message={`Deletes "${s.title}".`} onConfirm={() => removeSource.mutate(s.id)}>
                Delete
              </ConfirmButton>
            </Stack>
          ))}
          <Stack spacing={1} sx={{ mt: 2 }}>
            <TextField size="small" label="New text source: title" value={sourceTitle} onChange={(e) => setSourceTitle(e.target.value)} />
            <TextField size="small" label="Contents" multiline minRows={3} value={sourceText} onChange={(e) => setSourceText(e.target.value)} />
            <Box>
              <Button variant="contained" disabled={!sourceTitle || !sourceText || addSource.isPending} onClick={() => addSource.mutate()}>
                Add source
              </Button>
            </Box>
          </Stack>
        </Paper>
      </Box>
    </Stack>
  );
}
