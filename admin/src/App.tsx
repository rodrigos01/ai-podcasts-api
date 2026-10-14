import { AppBar, Box, Button, Container, Toolbar, Typography } from "@mui/material";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { EpisodePage } from "./pages/EpisodePage";
import { LoginPage } from "./pages/LoginPage";
import { PodcastPage } from "./pages/PodcastPage";
import { PodcastsPage } from "./pages/PodcastsPage";

export function App() {
  const { user, isAdmin, loading, signOut } = useAuth();
  if (loading) return null;
  if (!user || !isAdmin) return <LoginPage />;

  return (
    <Box>
      <AppBar position="static">
        <Toolbar>
          <Typography variant="h6" component={Link} to="/" sx={{ flexGrow: 1, color: "inherit", textDecoration: "none" }}>
            AI Podcasts Admin
          </Typography>
          <Typography variant="body2" sx={{ mr: 2 }}>
            {user.email}
          </Typography>
          <Button color="inherit" onClick={() => void signOut()}>
            Sign out
          </Button>
        </Toolbar>
      </AppBar>
      <Container sx={{ py: 3 }}>
        <Routes>
          <Route path="/" element={<PodcastsPage />} />
          <Route path="/podcasts/:podcastId" element={<PodcastPage />} />
          <Route path="/podcasts/:podcastId/episodes/:episodeId" element={<EpisodePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Container>
    </Box>
  );
}
