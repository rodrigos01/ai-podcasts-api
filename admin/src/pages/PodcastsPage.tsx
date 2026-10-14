import { Alert, Link as MuiLink, Paper, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { Podcast } from "../types";

export function PodcastsPage() {
  const [ownerId, setOwnerId] = useState("");
  const { data, error, isLoading } = useQuery({
    queryKey: ["podcasts", ownerId],
    queryFn: () => api<Podcast[]>(ownerId ? `?ownerId=${encodeURIComponent(ownerId)}` : ""),
  });

  return (
    <>
      <Typography variant="h5" gutterBottom>
        Podcasts
      </Typography>
      <TextField size="small" label="Filter by owner uid" value={ownerId} onChange={(e) => setOwnerId(e.target.value.trim())} sx={{ mb: 2, width: 360 }} />
      {error && <Alert severity="error">{error.message}</Alert>}
      <Paper>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Title</TableCell>
              <TableCell>Hosts</TableCell>
              <TableCell>Owner</TableCell>
              <TableCell>Created</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data?.map((p) => (
              <TableRow key={p.id} hover>
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
                <TableCell colSpan={4}>No podcasts.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>
    </>
  );
}
