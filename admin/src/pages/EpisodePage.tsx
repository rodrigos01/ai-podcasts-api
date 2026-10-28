import { Alert, Box, Button, Paper, Stack, Typography } from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, bulkApi } from "../api";
import { RegenerateDialog } from "../RegenerateDialog";
import { StatusChip } from "../StatusChip";
import { ConfirmButton } from "../ConfirmButton";
import { EditDialog } from "../EditDialog";
import { useEpisode } from "../firestore";

export function EpisodePage() {
  const { podcastId = "", episodeId = "" } = useParams();
  const base = `/${podcastId}/episodes/${episodeId}`;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const episode = useEpisode(podcastId, episodeId);

  const audio = useQuery({
    queryKey: ["episodeAudioUrl", episodeId, episode.data?.audioComplete],
    queryFn: () => api<{ url: string }>(`${base}/audio/url`),
    enabled: !!episode.data && !!episode.data.transcript,
    staleTime: 60 * 60 * 1000,
  });

  const refreshAudio = () => void qc.invalidateQueries({ queryKey: ["episodeAudioUrl", episodeId] });
  const update = useMutation({ mutationFn: (body: Record<string, string>) => api(base, { method: "PATCH", body }), });
  // Through the bulk route (a queue of one) so the re-draft option is available.
  const regenerate = useMutation({
    mutationFn: (redraft: boolean) =>
      bulkApi("/episodes/regenerate", { method: "POST", body: { podcastId, episodeIds: [episodeId], redraft } }),
    onSuccess: refreshAudio,
  });
  const clearAudio = useMutation({ mutationFn: () => api(`${base}/audio`, { method: "DELETE" }), onSuccess: refreshAudio });
  // Generation runs in this API process and is picked back up by whoever asks about it
  // (see ensureGenerationRunning); this does that for an episode that looks stuck.
  const nudge = useMutation({ mutationFn: () => api(`${base}/status`) });
  const remove = useMutation({
    mutationFn: () => api(base, { method: "DELETE" }),
    onSuccess: () => navigate(`/podcasts/${podcastId}`),
  });

  const e = episode.data ?? undefined;
  const error = episode.error ?? update.error ?? regenerate.error ?? clearAudio.error ?? remove.error ?? nudge.error;

  return (
    <Stack spacing={3}>
      <Link to={`/podcasts/${podcastId}`}>← Podcast</Link>
      {error && <Alert severity="error">{error.message}</Alert>}
      {e && (
        <Paper sx={{ p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="start" flexWrap="wrap" gap={1}>
            <Box>
              <Typography variant="h5">{e.title}</Typography>
              <Stack direction="row" spacing={1} alignItems="center">
                <StatusChip episode={e} />
                <Typography color="text.secondary">{e.length}</Typography>
              </Stack>
            </Box>
            <Stack direction="row" spacing={1} flexWrap="wrap">
              <Button variant="outlined" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button variant="outlined" onClick={() => setRegenerating(true)}>
                Regenerate
              </Button>
              <ConfirmButton
                variant="outlined"
                title="Regenerate audio?"
                message="Deletes the cached audio; it is synthesized again the next time it's played. This spends TTS quota."
                onConfirm={() => clearAudio.mutate()}
              >
                Regenerate audio
              </ConfirmButton>
              <ConfirmButton color="error" variant="outlined" title="Delete episode?" message={`Deletes "${e.title}" and its audio. This can't be undone.`} onConfirm={() => remove.mutate()}>
                Delete
              </ConfirmButton>
            </Stack>
          </Stack>

          {e.error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {e.error}
            </Alert>
          )}
          {e.status === "generating" && (
            <Alert
              severity="info"
              sx={{ mt: 2 }}
              action={
                <Button size="small" disabled={nudge.isPending} onClick={() => nudge.mutate()}>
                  Resume if stalled
                </Button>
              }
            >
              Generating…
            </Alert>
          )}
          <Typography variant="subtitle2" sx={{ mt: 2 }}>
            Topics
          </Typography>
          <Typography sx={{ whiteSpace: "pre-wrap" }}>{e.topics}</Typography>
          {e.productionNotes && (
            <>
              <Typography variant="subtitle2" sx={{ mt: 2 }}>
                Production notes
              </Typography>
              <Typography sx={{ whiteSpace: "pre-wrap" }}>{e.productionNotes}</Typography>
            </>
          )}
          {e.guests.map((g) => (
            <Typography key={g.id} sx={{ mt: 1 }}>
              <b>Guest {g.name}</b>: {g.persona}
            </Typography>
          ))}
          {audio.data && (
            <Box sx={{ mt: 2 }}>
              <audio controls preload="none" src={audio.data.url} style={{ width: "100%" }} />
            </Box>
          )}
          {regenerating && (
            <RegenerateDialog count={1} onConfirm={(redraft) => regenerate.mutate(redraft)} onClose={() => setRegenerating(false)} />
          )}
          {editing && (
            <EditDialog
              title="Edit episode"
              fields={[
                { key: "title", label: "Title" },
                { key: "topics", label: "Topics", multiline: true },
                { key: "productionNotes", label: "Production notes", multiline: true },
              ]}
              values={{ title: e.title, topics: e.topics, productionNotes: e.productionNotes ?? "" }}
              onSave={(changes) => update.mutate(changes)}
              onClose={() => setEditing(false)}
            />
          )}
        </Paper>
      )}
      {e?.transcript && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="h6" gutterBottom>
            Transcript
          </Typography>
          <Typography sx={{ whiteSpace: "pre-wrap" }}>{e.transcript}</Typography>
        </Paper>
      )}
    </Stack>
  );
}
