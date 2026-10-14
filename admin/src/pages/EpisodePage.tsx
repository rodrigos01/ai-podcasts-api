import { Alert, Box, Button, Chip, Paper, Stack, Typography } from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { ConfirmButton } from "../ConfirmButton";
import { EditDialog } from "../EditDialog";
import type { Episode, EpisodeStatusResponse } from "../types";

export function EpisodePage() {
  const { podcastId = "", episodeId = "" } = useParams();
  const base = `/${podcastId}/episodes/${episodeId}`;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);

  const episode = useQuery({ queryKey: ["episode", episodeId], queryFn: () => api<Episode>(base) });
  // Polling /status also nudges a stalled generation back to life (see the API).
  const status = useQuery({
    queryKey: ["episodeStatus", episodeId],
    queryFn: () => api<EpisodeStatusResponse>(`${base}/status`),
    refetchInterval: (q) => (q.state.data?.status === "generating" ? 3000 : false),
  });
  const currentStatus = status.data?.status;
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ["episode", episodeId] });
  }, [currentStatus, qc, episodeId]);

  const audio = useQuery({
    queryKey: ["episodeAudioUrl", episodeId, episode.data?.audioComplete],
    queryFn: () => api<{ url: string }>(`${base}/audio/url`),
    enabled: !!episode.data && !!episode.data.transcript,
    staleTime: 60 * 60 * 1000,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["episode", episodeId] });
    void qc.invalidateQueries({ queryKey: ["episodeStatus", episodeId] });
    void qc.invalidateQueries({ queryKey: ["episodeAudioUrl", episodeId] });
  };
  const update = useMutation({ mutationFn: (body: Record<string, string>) => api(base, { method: "PATCH", body }), onSuccess: refresh });
  const regenerate = useMutation({ mutationFn: () => api(`${base}/regenerate`, { method: "POST" }), onSuccess: refresh });
  const clearAudio = useMutation({ mutationFn: () => api(`${base}/audio`, { method: "DELETE" }), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: () => api(base, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["episodes", podcastId] });
      navigate(`/podcasts/${podcastId}`);
    },
  });

  const e = episode.data;
  const error = episode.error ?? update.error ?? regenerate.error ?? clearAudio.error ?? remove.error;
  const shownStatus = currentStatus ?? e?.status;

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
                {shownStatus && <Chip size="small" label={shownStatus} color={shownStatus === "failed" ? "error" : shownStatus === "generating" ? "warning" : "success"} />}
                <Typography color="text.secondary">{e.length}</Typography>
              </Stack>
            </Box>
            <Stack direction="row" spacing={1} flexWrap="wrap">
              <Button variant="outlined" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <ConfirmButton
                variant="outlined"
                title="Regenerate episode?"
                message="Throws away the transcript and cached audio and writes a new script. This spends Gemini quota."
                onConfirm={() => regenerate.mutate()}
              >
                Regenerate
              </ConfirmButton>
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

          {(e.error || status.data?.error) && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {status.data?.error ?? e.error}
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
