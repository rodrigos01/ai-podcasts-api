import { Alert, Box, Button, Chip, Link as MuiLink, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { ConfirmButton } from "../ConfirmButton";
import { EditDialog } from "../EditDialog";
import type { Episode, Podcast, Source } from "../types";

export function PodcastPage() {
  const { podcastId = "" } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceText, setSourceText] = useState("");

  const podcast = useQuery({ queryKey: ["podcast", podcastId], queryFn: () => api<Podcast>(`/${podcastId}`) });
  const episodes = useQuery({ queryKey: ["episodes", podcastId], queryFn: () => api<Episode[]>(`/${podcastId}/episodes`) });
  const sources = useQuery({ queryKey: ["sources", podcastId], queryFn: () => api<Source[]>(`/${podcastId}/sources`) });

  const update = useMutation({
    mutationFn: (body: Record<string, string>) => api(`/${podcastId}`, { method: "PATCH", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["podcast", podcastId] }),
  });
  const remove = useMutation({
    mutationFn: () => api(`/${podcastId}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["podcasts"] });
      navigate("/");
    },
  });
  const addSource = useMutation({
    mutationFn: () => api(`/${podcastId}/sources`, { method: "POST", body: { title: sourceTitle, contents: sourceText } }),
    onSuccess: () => {
      setSourceTitle("");
      setSourceText("");
      void qc.invalidateQueries({ queryKey: ["sources", podcastId] });
    },
  });
  const removeSource = useMutation({
    mutationFn: (id: string) => api(`/${podcastId}/sources/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sources", podcastId] }),
  });

  const p = podcast.data;
  const error = podcast.error ?? update.error ?? remove.error ?? addSource.error ?? removeSource.error;

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
        <Typography variant="h6" gutterBottom>
          Episodes
        </Typography>
        <Paper>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Title</TableCell>
                <TableCell>Length</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Created</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {episodes.data?.map((e) => (
                <TableRow key={e.id} hover>
                  <TableCell>
                    <MuiLink component={Link} to={`/podcasts/${podcastId}/episodes/${e.id}`}>
                      {e.title}
                    </MuiLink>
                  </TableCell>
                  <TableCell>{e.length}</TableCell>
                  <TableCell>
                    <Chip size="small" label={e.status} color={e.status === "failed" ? "error" : e.status === "generating" ? "warning" : "success"} />
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
